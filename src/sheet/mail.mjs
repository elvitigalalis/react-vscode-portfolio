// The read-only mail connector's pure side (docs/sheet-sources.md, "mail.mjs"; ADR 0002): turning
// Gmail API messages into what Claude reads, and splitting one search across several accounts.
// Kept free of the network so node --test covers it; the `mail-mcp` Edge Function
// (supabase/functions/mail-mcp) imports it and only talks to Gmail.
//
// A message is a Gmail `users.messages.get` response with format=full: headers, labelIds,
// internalDate (epoch milliseconds, as a string) and a MessagePart tree with base64url bodies.
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages

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
