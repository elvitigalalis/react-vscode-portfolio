// The telegram Edge Function (docs/sheet-nudges.md): The Sheet's only server code. pg_cron calls
// it every minute (supabase/schema.sql, "sheet-telegram") to send what's due, and it is the bot's
// webhook for Done and Snooze taps. Which messages are due, their wording, what counts as a tap
// and what it changes are decided in src/sheet/nudges.mjs, the module /plan's tests cover; this file only reads the
// day, talks to the Telegram Bot API and writes what the module says.
//
// Deploy from the repo root with server-side bundling, which follows the import out of
// supabase/functions (tools/sheet-setup.sh does this):
//   npx supabase functions deploy telegram --use-api --no-verify-jwt
// --no-verify-jwt because neither caller has a Supabase sign-in: the cron job proves itself with
// the shared secret below, and Telegram's webhook with its own secret token header (the
// secret_token tools/sheet-setup.sh passes to setWebhook).
//
// Secrets (function secrets, set by Lisul, never in the repo): TELEGRAM_BOT_TOKEN,
// SHEET_CRON_SECRET and TELEGRAM_WEBHOOK_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase.
import { whatToSend, handleTap, readTap, needsTappedBlock } from "../../../src/sheet/nudges.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";

const env = (name: string) => Deno.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const CRON_SECRET = env("SHEET_CRON_SECRET");
const WEBHOOK_SECRET = env("TELEGRAM_WEBHOOK_SECRET");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (CRON_SECRET && secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return Response.json(await send(new Date()));
  }
  if (WEBHOOK_SECRET && secretMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", WEBHOOK_SECRET)) {
    await tap(await req.json(), new Date());
    return new Response("ok");
  }
  return new Response("forbidden", { status: 403 });
});

// Whether a header holds the secret, compared without stopping at the first difference.
function secretMatches(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// --- The database, through PostgREST with the service key (it bypasses row-level security) ---

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// The snapshot whatToSend takes: settings, today's day row, today's tasks and every undone task
// with a due date, the blocks of those tasks and of today, and today's log.
async function snapshot(now: Date) {
  const [settings] = await db("settings?select=*");
  const { day: today } = localNow(now, settings.time_zone);
  const tasks = await db(`tasks?select=*&or=(day.eq.${today},and(due.not.is.null,done.is.false))`);
  // A day's blocks start within a day of its UTC midnight either way; whatToSend narrows them to
  // the owner's day.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString();
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const ids = tasks.map((t: { id: string }) => t.id).join(",");
  const blocks = await db(`blocks?select=*&or=(and(starts_at.gte.${from},starts_at.lt.${to})${ids ? `,task_id.in.(${ids})` : ""})`);
  const [day = null] = await db(`days?select=*&day=eq.${today}`);
  const log = await db(`nudges?select=*&day=eq.${today}`);
  return { settings, day, tasks, blocks, log };
}

// --- Sending ------------------------------------------------------------------------------

type Message = { kind: string; block_id: string | null; day: string; send_at: string; text: string; buttons: { text: string; url?: string; callback_data?: string }[] };

async function send(now: Date) {
  const snap = await snapshot(now);
  const sent = [];
  for (const m of whatToSend(snap, now) as Message[]) {
    // Claim the log row first: if another run got there, the claim returns nothing and this
    // one skips the message, so it goes out once.
    const c = await claim(m);
    if (!c) continue;
    try {
      // The buttons sit in one row: Done and Snooze 10 min under a nudge, Open /plan otherwise.
      await telegram("sendMessage", {
        chat_id: snap.settings.telegram_chat_id,
        text: m.text,
        reply_markup: m.buttons.length ? { inline_keyboard: [m.buttons] } : undefined,
      });
    } catch (e) {
      // Give the claim back so the next minute tries again.
      await c.giveBack();
      throw e;
    }
    await c.sent();
    sent.push(m.kind);
  }
  return { sent };
}

const setSentAt = (id: string, sent_at: string | null) => db(`nudges?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ sent_at }) });

// A snooze's row was logged by its tap, unsent; claiming it fills in sent_at, which only one run
// can do. Any other message is claimed by inserting its log row, which the unique key turns away
// the second time, and gets sent_at once Telegram has it.
async function claim(m: Message) {
  if (m.kind === "snooze") {
    const key = `block_id=eq.${m.block_id}&kind=eq.snooze&day=eq.${m.day}&send_at=eq.${encodeURIComponent(m.send_at)}&sent_at=is.null`;
    const [row] = await db(`nudges?${key}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ sent_at: new Date().toISOString() }),
    });
    return row && { giveBack: () => setSentAt(row.id, null), sent: async () => {} };
  }
  const [row] = await db("nudges?on_conflict=block_id,kind,day,send_at", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ block_id: m.block_id, kind: m.kind, day: m.day, send_at: m.send_at }),
  });
  return row && { giveBack: () => db(`nudges?id=eq.${row.id}`, { method: "DELETE" }), sent: () => setSentAt(row.id, new Date().toISOString()) };
}

// --- Taps ---------------------------------------------------------------------------------

type Change = { table: string; id?: string; insert?: unknown; update?: unknown; delete?: boolean };

// A second tap on the same button meets the row the first one wrote: a snooze stays as logged,
// and a pending Google edit takes the latest end.
const UPSERT: Record<string, string> = {
  nudges: "on_conflict=block_id,kind,day,send_at",
  gcal_pending: "on_conflict=gcal_id",
};
const RESOLVE: Record<string, string> = { nudges: "ignore-duplicates", gcal_pending: "merge-duplicates" };

// Done or Snooze on a nudge; readTap decides what counts as one. The message's buttons go when
// its text is edited.
async function tap(update: unknown, now: Date) {
  const snap = await snapshot(now);
  const t = readTap(update, snap.settings);
  if (!t) return;
  if (needsTappedBlock(snap, t)) {
    const [b] = await db(`blocks?select=*&id=eq.${t.block_id}`);
    if (b) {
      snap.blocks.push(...(await db(`blocks?select=*&task_id=eq.${b.task_id}`)));
      snap.tasks.push(...(await db(`tasks?select=*&id=eq.${b.task_id}`)));
    }
  }
  const { changes, text } = handleTap(t, snap, now) as { changes: Change[]; text: string };
  for (const c of changes) {
    if (c.insert) {
      await db(`${c.table}?${UPSERT[c.table]}`, { method: "POST", headers: { Prefer: `resolution=${RESOLVE[c.table]}` }, body: JSON.stringify(c.insert) });
    } else if (c.update) {
      await db(`${c.table}?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify(c.update) });
    } else if (c.delete) {
      await db(`${c.table}?id=eq.${c.id}`, { method: "DELETE" });
    }
  }
  await telegram("answerCallbackQuery", { callback_query_id: t.query_id });
  // A repeated tap leaves the text as it was, and Telegram refuses an edit that changes nothing.
  await telegram("editMessageText", { chat_id: t.chat_id, message_id: t.message_id, text }).catch(() => {});
}

async function telegram(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(`telegram ${method}: ${out.error_code} ${out.description}`);
  return out.result;
}
