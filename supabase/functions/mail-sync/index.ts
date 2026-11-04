// The mail-sync Edge Function (docs/sheet-v5.md, "Edge Functions"; ADR 0004): every 5 minutes
// (supabase/schema.sql, "sheet-mail") it reads each connected mail account's Gmail history and
// keeps reply_state (Reply owed, Awaiting reply), message_senders and known_senders, and logs mail
// changes for replans. It never fetches mail text: only labels, dates and the headers in
// SYNC_HEADERS, with `fields` naming the reply's fields so not even the snippet comes back
// (metadataQuery, src/sheet/mail.mjs, which the tests cover with the rest of the rules).
//
// Gmail's side (all GETs, under the account's gmail.readonly grant):
// - users.history.list from mail_accounts.history_id, for messageAdded, messageDeleted,
//   labelAdded and labelRemoved; "If you receive an HTTP 404 error response, your application
//   should perform a full sync" (developers.google.com/workspace/gmail/api/reference/rest/v1/
//   users.history/list; guides/sync: records are "typically available for at least one week").
// - users.getProfile for a fresh historyId (…/rest/v1/users/getProfile).
// - users.threads.get with format=metadata for each thread history touched (…/users.threads/get).
// - Once a day (the first good run of the local day) and on a full sync, a sweep: users.messages.list
//   with q `newer_than:14d -in:drafts` (ids and thread ids only, newest first, spam and trash left
//   out; …/users.messages/list), then users.messages.get with format=metadata on each thread's
//   newest message. Reply owed and Awaiting reply turn on as business days pass, which happens
//   only when the local date changes, so a daily sweep catches every turn the history doesn't.
//
// Quota (developers.google.com/workspace/gmail/api/reference/quota): 6,000 units per user per
// minute; history.list 2, getProfile 1, messages.list 5, messages.get 20 and threads.get 40 (full
// would be 60 and 120). A quiet run costs 2 units; THREADS_MAX threads.get is 2,000 and a sweep
// of SWEEP_MAX messages 2,005, so a run stays well inside a minute's quota.
//
// Deploy from the repo root:
//   npx supabase functions deploy mail-sync --use-api --no-verify-jwt
// --no-verify-jwt because the cron job has no Supabase sign-in; it proves itself with the shared
// secret below.
//
// Secrets: SHEET_CRON_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SHEET_SENDER_SALT (the
// known-sender hashes' salt; without it no sender is known). Refresh tokens come from Vault
// (mail_refresh_token) and are never logged or written anywhere.
import {
  accountPatch, gmailError, historyChanges, mailChanges, metadataQuery, newestPerThread, parseAddresses,
  replyDiff, replyState, senderHash, syncMessage, syncThread, threadsToRead,
} from "../../../src/sheet/mail.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";
import { googleToken } from "../_shared/google.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const SALT = env("SHEET_SENDER_SALT");
const SOURCE = "gmail";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const HISTORY_PAGES = 10;   // 500 records a page
const SWEEP_MAX = 100;      // threads per sweep
const PARALLEL = 5;

type Msg = ReturnType<typeof syncMessage>;
type Thread = { account: string; thread_id: string; messages: Msg[] };
type Account = { email: string; history_id: string | null };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const fetched_at = now.toISOString();
  try {
    const accounts: Account[] = await db("mail_accounts?select=email,history_id&order=connected_at");
    if (!accounts.length) {
      await saveFeedState(SOURCE, { fetched_at, ok: null, error: "not connected", items: null });
      return Response.json({ ok: true, skipped: "not connected" });
    }
    const [settings] = await db("settings?select=time_zone");
    const tz = settings?.time_zone ?? "America/New_York";
    // The sweep runs on the first good run of each local day, and again after a failed run.
    const [prev] = await db(`feed_state?select=fetched_at,ok&source=eq.${SOURCE}`);
    const sweep = !prev || prev.ok !== true || !prev.fetched_at
      || localNow(new Date(prev.fetched_at), tz).day !== localNow(now, tz).day;
    const out = [];
    const failed: string[] = [];
    for (const a of accounts) {
      try { out.push(await syncAccount(a, tz, now, sweep)); }
      catch (e) { failed.push(`${a.email}: ${(e as Error).message}`); }
    }
    const items = out.reduce((n, o) => n + o.threads, 0);
    const error = failed.length ? failed.join("; ").slice(0, 300) : null;
    await saveFeedState(SOURCE, { fetched_at, ok: !error, error, items });
    return Response.json({ ok: !error, sweep, accounts: out, ...(error ? { error } : {}) });
  } catch (e) {
    return feedFailed(SOURCE, e, fetched_at);
  }
});

// --- One account ----------------------------------------------------------------------------------

class GmailError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function syncAccount(account: Account, tz: string, now: Date, sweepDue: boolean) {
  const email = account.email;
  const record = (outcome: { ok: boolean; status?: number; error?: string }) => {
    const patch = accountPatch(outcome, now);
    return patch ? db(`mail_accounts?email=eq.${encodeURIComponent(email)}`, { method: "PATCH", body: JSON.stringify(patch) }) : null;
  };
  try {
    const token = await accessToken(email);
    const gmail = async (path: string) => {
      const res = await fetch(`${GMAIL}/${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new GmailError(res.status, gmailError(res.status, await res.text()));
      return res.json();
    };

    // What changed since the last run, or a full sync when there is no position or it is too old.
    let changed: { threads: string[]; added: string[] } = { threads: [], added: [] };
    let historyId = account.history_id;
    let full = !historyId;
    if (historyId) {
      try {
        const pages = [];
        const start: string = historyId;
        let pageToken = "";
        for (let i = 0; i < HISTORY_PAGES; i++) {
          const q = new URLSearchParams({ startHistoryId: start, maxResults: "500" });
          for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) q.append("historyTypes", t);
          if (pageToken) q.set("pageToken", pageToken);
          const page = await gmail(`history?${q}`);
          pages.push(page);
          if (page.historyId) historyId = page.historyId;
          pageToken = page.nextPageToken ?? "";
          if (!pageToken) break;
        }
        changed = historyChanges(pages);
        // More history than a run reads, or more threads: start again from now, as after a 404,
        // and sweep (threadsToRead).
        const cut = threadsToRead(changed.threads, Boolean(pageToken));
        changed = { ...changed, threads: cut.threads };
        if (cut.full) full = true;
      } catch (e) {
        if (!(e instanceof GmailError && e.status === 404)) throw e;
        full = true;
      }
    }
    if (full) historyId = (await gmail("profile?fields=historyId")).historyId;

    // The threads to work out again: those history touched, read whole.
    const threads: Thread[] = await inBatches(changed.threads,
      async (id) => {
        // A thread deleted since leaves nothing to track.
        try { return syncThread(await gmail(`threads/${id}?${metadataQuery(true)}`), email); }
        catch (e) { if (e instanceof GmailError && e.status === 404) return { account: email, thread_id: id, messages: [] }; throw e; }
      });
    // The sweep reads only each recent thread's newest message, which is all replyState looks at.
    if (full || sweepDue) {
      const read = new Set(threads.map((t) => t.thread_id));
      const q = new URLSearchParams({ q: "newer_than:14d -in:drafts", maxResults: String(SWEEP_MAX * 2), fields: "messages(id,threadId)" });
      const { messages = [] } = await gmail(`messages?${q}`);
      const newest = newestPerThread(messages).filter((m: { threadId: string }) => !read.has(m.threadId)).slice(0, SWEEP_MAX);
      threads.push(...await inBatches(newest, async (m: { id: string; threadId: string }) => {
        const msg = syncMessage(await gmail(`messages/${m.id}?${metadataQuery()}`));
        return { account: email, thread_id: m.threadId, messages: [msg] };
      }));
    }

    const messages = threads.flatMap((t) => t.messages);
    await saveSenders(email, messages, now);
    const known = await knownAddresses(messages.map((m) => m.from_address).filter(Boolean) as string[]);

    // reply_state: upsert what holds now, delete what cleared, and note the threads turned owed.
    const enc = encodeURIComponent(email);
    const before = threads.length
      ? await db(`reply_state?select=thread_id,state,message_id&account=eq.${enc}`)
      : [];
    const after = threads.map((t) => {
      const state = replyState(t, tz, now);
      const newest = state && t.messages.find((m) => m.id === state.message_id);
      return { thread_id: t.thread_id, state, from_address: newest?.from_address ?? null };
    });
    const diff = replyDiff(email, before, after, known);
    if (diff.upserts.length) {
      await db("reply_state?on_conflict=account,thread_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(diff.upserts.map((r) => ({ ...r, updated_at: now.toISOString() }))),
      });
    }
    if (diff.deletes.length) {
      await db(`reply_state?account=eq.${enc}&thread_id=in.(${diff.deletes.map(quoted).join(",")})`, { method: "DELETE" });
    }

    // Changes for replans: new mail from people, and known senders' threads that turned owed.
    // A full sync has nothing new: everything it reads was there before.
    const added = new Set(changed.added);
    const rows = mailChanges(messages.filter((m) => added.has(m.id)), full ? [] : diff.owed);
    if (rows.length) await db("changes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });

    await db(`mail_accounts?email=eq.${enc}`, { method: "PATCH", body: JSON.stringify({ history_id: historyId }) });
    await record({ ok: true });
    return { account: email, full, threads: threads.length, changes: rows.length };
  } catch (e) {
    await record({ ok: false, status: e instanceof GmailError ? e.status : undefined, error: (e as Error).message });
    throw e;
  }
}

async function accessToken(email: string) {
  const refresh = await db("rpc/mail_refresh_token", { method: "POST", body: JSON.stringify({ account_email: email }) });
  if (!refresh) throw new Error("not a connected mail account");
  const { ok, status, grant } = await googleToken({ refresh_token: refresh, grant_type: "refresh_token" });
  // Google's error code (invalid_grant, say) never holds a token; its description is left out.
  if (!ok) throw new Error(`token refresh refused: ${/^[\w-]{1,40}$/.test(grant.error ?? "") ? grant.error : `HTTP ${status}`}`);
  return grant.access_token as string;
}

// --- Senders --------------------------------------------------------------------------------------

// message_senders gets each received message's From address (14 days, for never-show rules), and
// known_senders the salted hash of every To address of his sent mail.
async function saveSenders(account: string, messages: Msg[], now: Date) {
  const cutoff = +now - 14 * 86_400_000;
  const received = messages.filter((m) => !m.labels.includes("SENT") && m.from_address && Date.parse(m.date) > cutoff)
    .map((m) => ({ account, message_id: m.id, thread_id: m.thread_id, from_address: m.from_address, at: m.date }));
  if (received.length) {
    await db("message_senders?on_conflict=account,message_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(received),
    });
  }
  if (!SALT) return;
  const latest = new Map<string, string>();
  for (const m of messages.filter((m) => m.labels.includes("SENT"))) {
    for (const { address } of parseAddresses(m.to)) {
      const hash = await senderHash(address, SALT);
      if (!latest.has(hash) || latest.get(hash)! < m.date) latest.set(hash, m.date);
    }
  }
  if (!latest.size) return;
  await db("known_senders?on_conflict=hash", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([...latest].map(([hash, last_sent_at]) => ({ hash, last_sent_at }))),
  });
}

// The addresses among `addresses` he has written to, by their hashes in known_senders.
async function knownAddresses(addresses: string[]) {
  const known = new Set<string>();
  if (!SALT || !addresses.length) return known;
  const byHash = new Map<string, string>();
  for (const a of new Set(addresses)) byHash.set(await senderHash(a, SALT), a);
  const rows = await db(`known_senders?select=hash&hash=in.(${[...byHash.keys()].join(",")})`);
  for (const r of rows) known.add(byHash.get(r.hash)!);
  return known;
}

// --- Helpers --------------------------------------------------------------------------------------

// A value for PostgREST's in.() list, quoted (docs.postgrest.org/en/stable/references/api/
// tables_views.html#reserved-characters).
const quoted = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

// `work` over `items`, PARALLEL at a time, results in order.
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...await Promise.all(items.slice(i, i + PARALLEL).map(work)));
  return out;
}
