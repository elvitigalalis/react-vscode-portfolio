// The read-only mail connector's pure side (docs/sheet-sources.md, "mail.mjs"; ADR 0002): turning
// Gmail API messages into what Claude reads, and splitting one search across several accounts.
// Kept free of the network so node --test covers it; the `mail-mcp` Edge Function
// (supabase/functions/mail-mcp) imports it and only talks to Gmail.
//
// A message is a Gmail `users.messages.get` response with format=full: headers, labelIds,
// internalDate (epoch milliseconds, as a string) and a MessagePart tree with base64url bodies.
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages

import { addDays, localNow } from "./logic.mjs";
import { changeRow } from "./replan.mjs";

// A message's summary, for the account (its email address) it was read from. `link` opens the
// thread in Gmail signed in as that account.
export function messageSummary(message, account) {
  const header = (name) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  return {
    account,
    id: message.id,
    thread_id: message.threadId,
    from: header("From"),
    to: header("To"),
    subject: header("Subject"),
    date: new Date(Number(message.internalDate)).toISOString(),
    snippet: decodeEntities(message.snippet ?? ""),
    labels: message.labelIds ?? [],
    link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${message.threadId}`,
  };
}

// --- HTML entities -------------------------------------------------------------------------

// The named entities mail actually uses; numeric ones (&#39; &#x2014;) decode by code point.
// &nbsp; becomes a plain space, so the text reads and searches like the plain-text part.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", eacute: "é" };

export function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// --- Bodies --------------------------------------------------------------------------------

// The most of a body Claude gets, counting the marker a cut body ends in.
export const BODY_MAX = 20_000;
export const TRUNCATED = "… (truncated)";

// A message's text: the first text/plain part (depth first) that is not an attachment, otherwise
// the first such text/html part stripped to text, otherwise "". Trimmed, LF line ends, and cut
// to BODY_MAX characters.
export function messageBody(message) {
  const plain = findPart(message.payload, "text/plain");
  const html = plain ? null : findPart(message.payload, "text/html");
  const part = plain ?? html;
  if (!part) return "";
  let text = decodeBase64Url(part.body.data).replace(/\r\n?/g, "\n");
  if (html) text = htmlToText(text);
  text = text.trim();
  return text.length > BODY_MAX ? text.slice(0, BODY_MAX - TRUNCATED.length) + TRUNCATED : text;
}

// Attachments carry a filename (and usually an attachmentId instead of inline data).
function findPart(part, mimeType) {
  if (!part) return null;
  if (part.mimeType === mimeType && !part.filename && part.body?.data != null) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

// Gmail sends base64url, with or without padding; atob wants standard base64.
function decodeBase64Url(data) {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// HTML to readable text: no head, scripts, styles or comments; block ends become line breaks;
// a link keeps its address as "text (href)"; entities are decoded last, so "&lt;3" stays text.
const BLOCK = "p|div|br|li|tr|td|th|h[1-6]|table|ul|ol|blockquote|section|article|header|footer";

function htmlToText(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, inner) => {
      const label = inner.replace(/<[^>]*>/g, "").trim();
      return /^(https?:|mailto:)/i.test(href) && decodeEntities(href) !== decodeEntities(label) ? `${label} (${href})` : label;
    })
    .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .split("\n").map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// --- Searching several accounts --------------------------------------------------------------

// The most results one search returns, across every account.
export const SEARCH_MAX = 25;

// One search over several accounts (email addresses, in the order to break ties by). Each
// account is asked for the whole limit, since any one of them may hold the newest results.
// merge(lists) takes each account's summaries, in the order of `requests`, and returns one list,
// newest first, cut to the limit.
export function searchPlan(query, accounts, max) {
  const limit = max == null ? SEARCH_MAX : Math.min(SEARCH_MAX, Math.max(1, Math.floor(Number(max)) || 1));
  const requests = accounts.map((account) => ({ account, q: query, maxResults: limit }));
  const merge = (lists) => lists
    .flatMap((list, a) => list.map((summary, i) => ({ summary, a, i, t: Date.parse(summary.date) })))
    .sort((x, y) => y.t - x.t || x.a - y.a || x.i - y.i)
    .slice(0, limit)
    .map((x) => x.summary);
  return { limit, requests, merge };
}

// --- Account health (mail-mcp) ---------------------------------------------------------------

// A failed Gmail API call as one line: the status and Gmail's own error message
// (developers.google.com/workspace/gmail/api/guides/handle-errors: `{ error: { code, message } }`),
// never the raw body.
export function gmailError(status, body) {
  let message = "";
  try { message = String(JSON.parse(body)?.error?.message ?? ""); } catch { /* not JSON */ }
  return message ? `Gmail ${status}: ${message.slice(0, 200)}` : `Gmail ${status}`;
}

// What an account's mail_accounts row records after mail-mcp used it, or null for no change.
// `outcome` is { ok } or { ok: false, status?, error }: a refused token refresh has no status,
// a Gmail API error has Gmail's. A good use clears last_error. A 400 (a bad search) or 404 (a
// message that isn't there) is the request's fault, not the account's, so it records nothing.
export function accountPatch(outcome, now) {
  if (outcome.ok) return { last_used_at: new Date(now).toISOString(), last_error: null };
  if (outcome.status === 400 || outcome.status === 404) return null;
  return { last_error: String(outcome.error ?? "failed").slice(0, 300) };
}

// --- v5 A1: assessment and interview senders (docs/sheet-v5.md, "mail.mjs") ------------------

const ASSESSMENT_DOMAINS = {
  "hackerrank.com": "assessment",
  "codesignal.com": "assessment",
  "codility.com": "assessment",
  "hirevue.com": "assessment",
  "karat.com": "interview",
  "calendly.com": "interview",
  "goodtime.io": "interview",
};

// 'assessment' or 'interview' when a bare From address is at one of those domains or a
// subdomain of one (any case), otherwise null. Only the part after the last "@" counts, so
// "hackerrank.com@gmail.com" and "a@hackerrank.com.evil.io" are null.
export function assessmentSender(from) {
  const at = String(from ?? "").lastIndexOf("@");
  if (at < 0) return null;
  const domain = String(from).slice(at + 1).toLowerCase();
  for (const [d, kind] of Object.entries(ASSESSMENT_DOMAINS)) {
    if (domain === d || domain.endsWith(`.${d}`)) return kind;
  }
  return null;
}

// --- v5 M1: reply tracking from metadata (docs/sheet-v5.md, "mail.mjs") ----------------------
// The mail sync (supabase/functions/mail-sync) reads labels, dates and a few headers only, never
// mail text; these work out Reply owed and Awaiting reply from them.

// The Mondays to Fridays after fromIso's local date, up to and including toIso's.
export function businessDays(fromIso, toIso, timeZone) {
  let day = localNow(new Date(fromIso), timeZone).day;
  const last = localNow(new Date(toIso), timeZone).day;
  let n = 0;
  while (day < last) {
    day = addDays(day, 1);
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// A header's value from Gmail's `payload.headers` ([{ name, value }]), any case, or "".
const headerOf = (headers, name) => (headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

// An address list ("Ana <a@x.edu>, b@y.com") as [{ name, address }]: commas inside quotes don't
// split, a quoted name loses its quotes, and `name` is "" without one.
export function parseAddresses(value) {
  const parts = String(value ?? "").match(/(?:"[^"]*"|[^,])+/g) ?? [];
  return parts.map((part) => {
    const angle = part.match(/<([^>]*)>/);
    const address = (angle ? angle[1] : part).trim().toLowerCase();
    const name = angle ? part.slice(0, angle.index).trim().replace(/^"(.*)"$/, "$1").trim() : "";
    return { name, address };
  }).filter((a) => a.address.includes("@"));
}

// Local parts that only machines write from: a known prefix, or "noreply" anywhere in it
// (alerts-noreply, no.reply.alerts).
const AUTOMATED_LOCAL = /^(?:no[-._]?reply|do[-._]?not[-._]?reply|donotreply|mailer[-._]?daemon|postmaster|bounces?|notifications?|notify|alerts?|updates?|news(?:letter)?|info|marketing|billing|receipts?|security|verify|verification|accounts?|auto(?:mated)?|system|calendar-notification)(?:[-+._].*)?$/i;
const NOREPLY_ANYWHERE = /no[-._]?reply/i;
const machineAddress = (value) => {
  const a = parseAddresses(value)[0];
  const local = a ? a.address.split("@")[0] : "";
  return Boolean(local) && (AUTOMATED_LOCAL.test(local) || NOREPLY_ANYWHERE.test(local));
};

// True for mail no person wrote: a machine From or Sender address (Sender is who actually sent
// it, e.g. Google Calendar for a person's invite), a mailing list or bulk header (RFC 2369
// List-*, RFC 2919 List-Id, RFC 8058 List-Unsubscribe-Post, Precedence), an ESP stream's
// Feedback-ID (support.google.com/mail/answer/6254652) or an RFC 3834 Auto-Submitted other than
// "no". Transactional mail (passcodes, alerts) carries no list headers (support.google.com/a/
// answer/14229414), so the address check carries most of that.
export function automatedSender(headers) {
  if (machineAddress(headerOf(headers, "From")) || machineAddress(headerOf(headers, "Sender"))) return true;
  for (const h of ["List-Id", "List-Unsubscribe", "List-Unsubscribe-Post", "Feedback-ID"]) if (headerOf(headers, h)) return true;
  const auto = headerOf(headers, "Auto-Submitted").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  return /^(bulk|list|junk)$/i.test(headerOf(headers, "Precedence").trim());
}

// Signs that count against a person having written it, without ruling it out: Exchange's
// X-Auto-Response-Suppress (MS-OXCMAIL; a person's Outlook mail can carry it too) or a bounce
// or VERP Return-Path. They keep a thread from being owed unless he wrote in it.
export function automationDemerit(headers) {
  if (headerOf(headers, "X-Auto-Response-Suppress")) return true;
  const local = parseAddresses(headerOf(headers, "Return-Path"))[0]?.address.split("@")[0] ?? "";
  return /^bounces?/i.test(local) || /[+=]/.test(local);
}

// The Gmail categories spec 47 leaves out of reply tracking.
export const SKIPPED_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];
export const skippedCategory = (labels) => (labels ?? []).some((l) => SKIPPED_CATEGORIES.includes(l));

// reply_state.who: a display name, never an address, at most 80 characters.
export const WHO_MAX = 80;
function displayName(value) {
  const first = parseAddresses(value)[0];
  if (!first) return "";
  const name = first.name && !first.name.includes("@") ? first.name : first.address.split("@")[0];
  return name.slice(0, WHO_MAX);
}

// Gmail categories that never make a reply owed; CATEGORY_UPDATES only counts against (Gmail
// files some people's replies there, and one sender's mail moves between tabs).
const NEVER_OWED = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];

// A thread's reply state, or null. thread: { account, thread_id, draft?, messages: [{ id, date,
// labels, from, to, from_address, automated, demerit, addressed }] }. opts.participated: he wrote
// in the thread (the sweep's sent list; any SENT message in it counts too); opts.known: the From
// addresses (lowercased, in memory) he has written to.
// The deciding message is the newest that isn't spam, trash or a draft, and is his or a person's
// (an auto-reply or a ticket acknowledgement doesn't answer him). Owed needs evidence of a
// conversation, never just the lack of bulk headers:
//   basis "thread": he wrote in the thread and they answered, at once;
//   basis "known":  someone he has written to wrote To him, at once, with no Updates or demerit;
//   basis "cc":     the same with him only in Cc, from 2 business days.
// Anyone else is left to the planner, which reads the snippet. Awaiting: his, 3+ business days.
// Owed is { state, since, message_id, who, basis, draft }: draft, the thread has his unsent draft.
export function replyState(thread, timeZone, now, { participated = false, known = new Set() } = {}) {
  const kept = (thread.messages ?? []).filter((m) => !["SPAM", "TRASH", "DRAFT"].some((l) => m.labels.includes(l)));
  const deciding = kept.filter((m) => m.labels.includes("SENT") || !m.automated);
  if (!deciding.length) return null;
  const newest = deciding.reduce((a, b) => (Date.parse(b.date) > Date.parse(a.date) ? b : a));
  const days = businessDays(newest.date, now.toISOString(), timeZone);
  if (newest.labels.includes("SENT")) {
    const who = days >= 3 && displayName(newest.to);
    return who ? { state: "awaiting", since: newest.date, message_id: newest.id, who } : null;
  }
  if (newest.labels.some((l) => NEVER_OWED.includes(l))) return null;
  const wrote = participated || kept.some((m) => m.labels.includes("SENT"));
  const demerit = newest.demerit || newest.labels.includes("CATEGORY_UPDATES");
  const knownSender = Boolean(newest.from_address && known.has(newest.from_address));
  const basis = wrote ? "thread"
    : knownSender && !demerit && newest.addressed === "to" ? "known"
    : knownSender && !demerit && newest.addressed === "cc" && days >= 2 ? "cc"
    : null;
  const who = basis && displayName(newest.from);
  return who ? { state: "owed", since: newest.date, message_id: newest.id, who, basis, draft: Boolean(thread.draft) } : null;
}

// The mail sync's changes rows (replan.mjs's REASON_WORDS). added: the messages new since the
// last sync, [{ id, labels, automated }], each from a person and not skipped giving mail_new
// (weight 2). owed: the threads that turned owed this sync, [{ message_id, known, basis }], each
// from a known sender or answering his own thread (basis "thread") giving mail_owed (weight 8).
export function mailChanges(added, owed) {
  const quiet = ["SENT", "SPAM", "TRASH", "DRAFT"];
  return [
    ...added.filter((m) => !m.automated && !skippedCategory(m.labels) && !m.labels.some((l) => quiet.includes(l)))
      .map((m) => changeRow("mail_new", m.id)),
    ...owed.filter((t) => t.known || t.basis === "thread").map((t) => changeRow("mail_owed", t.message_id)),
  ];
}

// A known sender's key: hex SHA-256 of the salt (SHEET_SENDER_SALT) and the address, trimmed
// and lowercased, so no address is kept in plain text (crypto.subtle, in Node and Deno alike).
export async function senderHash(address, salt) {
  const bytes = new TextEncoder().encode(salt + String(address).trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// What message_senders keeps of a From address (fix: never the address itself): its senderHash,
// and the senderHash of its domain and of each parent domain, longest first ("mail.acme.com",
// "acme.com", "com"), so a domain rule can be checked by hashing its pattern the same way. Null
// for a value with no "@" and a domain after it.
export async function senderHashes(address, salt) {
  const a = String(address ?? "").trim().toLowerCase();
  const domain = a.slice(a.lastIndexOf("@") + 1);
  if (!a.includes("@") || !domain || /\s/.test(a)) return null;
  const labels = domain.split(".");
  return {
    address_hash: await senderHash(a, salt),
    domain_hashes: await Promise.all(labels.map((_, i) => senderHash(labels.slice(i).join("."), salt))),
  };
}

// --- v5 M1: the mail sync's reads (supabase/functions/mail-sync) -----------------------------
// Gmail's message formats (developers.google.com/workspace/gmail/api/reference/rest/v1/Format):
// `metadata` "Returns only email message ID, labels, and email headers", while `full` and `raw`
// return the body. Even metadata responses carry `snippet` ("A short part of the message text",
// …/rest/v1/users.messages#Message), so every read also names its `fields` (a partial response,
// developers.google.com/workspace/gmail/api/guides/performance#partial), which leaves the snippet,
// the size and any body out of the reply altogether. metadataHeaders ("When given and format is
// METADATA, only include headers specified", …/users.messages/get) keeps the headers to these.
export const SYNC_HEADERS = ["From", "To", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence",
  "Cc", "Sender", "Reply-To", "List-Unsubscribe-Post", "X-Auto-Response-Suppress", "Feedback-ID", "Return-Path"];
const MESSAGE_FIELDS = "id,threadId,labelIds,internalDate,payload/headers";

// The query for users.messages.get (`thread: false`) or users.threads.get (`thread: true`).
export function metadataQuery(thread = false) {
  const q = new URLSearchParams({ format: "metadata" });
  for (const h of SYNC_HEADERS) q.append("metadataHeaders", h);
  q.set("fields", thread ? `id,messages(${MESSAGE_FIELDS})` : MESSAGE_FIELDS);
  return q.toString();
}

// Whether the account (its email address) is in a message's To ("to"), else its Cc ("cc"),
// else "none" (Bcc, a list). Compared in memory; only the word is ever kept.
export function addressedTo(headers, account) {
  const me = String(account ?? "").trim().toLowerCase();
  if (!me) return "none";
  const has = (name) => parseAddresses(headerOf(headers, name)).some((a) => a.address === me);
  return has("To") ? "to" : has("Cc") ? "cc" : "none";
}

// A metadata message as replyState reads it, plus its thread and From address. `account` is the
// mailbox it was read from, for `addressed`.
export function syncMessage(message, account) {
  const headers = message.payload?.headers ?? [];
  const from = headerOf(headers, "From");
  return {
    id: message.id,
    thread_id: message.threadId,
    date: new Date(Number(message.internalDate)).toISOString(),
    labels: message.labelIds ?? [],
    from,
    to: headerOf(headers, "To"),
    cc: headerOf(headers, "Cc"),
    from_address: parseAddresses(from)[0]?.address ?? null,
    automated: automatedSender(headers),
    demerit: automationDemerit(headers),
    addressed: addressedTo(headers, account),
  };
}

// A users.threads.get reply (metadata) as replyState's thread. A draft isn't mail anyone has
// seen, so it is left out, but `draft` says the thread has one: his reply may be sitting unsent.
export function syncThread(thread, account) {
  const all = (thread.messages ?? []).map((m) => syncMessage(m, account));
  const messages = all.filter((m) => !m.labels.includes("DRAFT"));
  return { account, thread_id: thread.id, draft: messages.length < all.length, messages };
}

// What users.history.list pages say changed: the threads touched and the messages added, each
// once and in order. A history record's messages carry only id and threadId
// (developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).
export function historyChanges(pages) {
  const threads = new Set();
  const added = new Set();
  for (const page of pages) {
    for (const h of page.history ?? []) {
      for (const m of h.messagesAdded ?? []) { added.add(m.message.id); threads.add(m.message.threadId); }
      for (const key of ["messagesDeleted", "labelsAdded", "labelsRemoved"]) {
        for (const m of h[key] ?? []) threads.add(m.message.threadId);
      }
    }
  }
  return { threads: [...threads], added: [...added] };
}

// The threads one run reads again: at most THREADS_MAX of those history touched. Cutting any
// off, or history pages left over (`more`), makes it a full sync: the run starts from a fresh
// history position and sweeps, so the threads it skipped are read by the sweep, not lost.
export const THREADS_MAX = 50;
export function threadsToRead(threads, more) {
  return { threads: threads.slice(0, THREADS_MAX), full: Boolean(more) || threads.length > THREADS_MAX };
}

// The daily sweep's messages: users.messages.list gives ids and thread ids, newest first, so the
// first message seen of each thread is its newest.
export function newestPerThread(messages) {
  const seen = new Set();
  return messages.filter((m) => !seen.has(m.threadId) && seen.add(m.threadId));
}

// How one account's reply_state rows move. before: its rows now; after: [{ thread_id, state:
// replyState(...) | null, from_address }] for the threads read this sync; known: the From
// addresses (lowercased) he has written to. Gives the rows to upsert, the thread ids to delete,
// and the threads that turned owed (not owed at that message before), for mailChanges.
export function replyDiff(account, before, after, known) {
  const old = new Map(before.map((r) => [r.thread_id, r]));
  const upserts = [];
  const deletes = [];
  const owed = [];
  for (const { thread_id, state, from_address } of after) {
    const prev = old.get(thread_id);
    if (!state) { if (prev) deletes.push(thread_id); continue; }
    upserts.push({ account, thread_id, ...state });
    if (state.state === "owed" && !(prev?.state === "owed" && prev.message_id === state.message_id)) {
      owed.push({ message_id: state.message_id, known: Boolean(from_address && known.has(from_address)), basis: state.basis ?? null });
    }
  }
  return { upserts, deletes, owed };
}

// search_mail's summaries with `known` (he has sent mail to the From address) and the thread's
// `reply_state` ('owed' | 'awaiting' | null). known: lowercased addresses; states: reply_state
// rows, matched on account and thread.
export function searchMarks(summaries, known, states) {
  const state = new Map(states.map((r) => [`${r.account} ${r.thread_id}`, r.state]));
  return summaries.map((s) => ({
    ...s,
    known: known.has(parseAddresses(s.from)[0]?.address ?? ""),
    reply_state: state.get(`${s.account} ${s.thread_id}`) ?? null,
  }));
}
