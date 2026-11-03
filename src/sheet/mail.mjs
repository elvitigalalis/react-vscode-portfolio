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
