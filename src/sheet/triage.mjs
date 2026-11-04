// v5 L1, learning from his taps (docs/sheet-v5.md, "triage.mjs"): the labels his Needs you taps
// leave in `feedback`, a score of one run's Needs you items against them, the "Never show mail
// from …" offers /plan makes, and the rule match the server drops items by. Pure, so node --test
// covers it; /plan, planner-mcp (through proposal.mjs) and tools/triage-score.mjs import it.

// A message is its account and id: the same Gmail id in another account is another message.
export const messageKey = (account, message_id) => `${account} ${message_id}`;

// The needs_you feedback rows of each message, oldest first by `at` (list order breaks ties).
function byMessage(feedback) {
  const rows = (feedback ?? []).filter((f) => f?.item === "needs_you" && f.ref?.account && f.ref?.message_id)
    .map((f, i) => ({ f, i, at: Date.parse(f.at) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.f);
  const messages = new Map();
  for (const f of rows) {
    const k = messageKey(f.ref.account, f.ref.message_id);
    if (!messages.has(k)) messages.set(k, []);
    messages.get(k).push(f);
  }
  return messages;
}

// The label the newest row leaves: done is needed, not_needed isn't, undo (or anything else)
// leaves none.
const labelOf = (rows) => ({ done: true, not_needed: false })[rows.at(-1).action];

// Labels [{ account, message_id, needed }], one per message with one, in order of each message's
// first row.
export function triageLabels(feedback) {
  const labels = [];
  for (const rows of byMessage(feedback).values()) {
    const needed = labelOf(rows);
    if (needed !== undefined) labels.push({ account: rows[0].ref.account, message_id: rows[0].ref.message_id, needed });
  }
  return labels;
}

// One run's Needs you items ([{ account, message_id }]) against his labels: caught (shown and
// needed, item order), missed (needed, not shown, label order) and wrongly_shown (shown, not
// needed, item order), each a list of "<account> <message_id>" keys, once each. Unlabelled items
// are in none.
export function scoreTriage(items, labels) {
  const needed = new Map((labels ?? []).map((l) => [messageKey(l.account, l.message_id), l.needed]));
  const shown = [...new Set((items ?? []).map((x) => messageKey(x.account, x.message_id)))];
  const shownSet = new Set(shown);
  return {
    caught: shown.filter((k) => needed.get(k) === true),
    missed: [...new Set((labels ?? []).filter((l) => l.needed).map((l) => messageKey(l.account, l.message_id)))].filter((k) => !shownSet.has(k)),
    wrongly_shown: shown.filter((k) => needed.get(k) === false),
  };
}

// Whether a triage rule ({ match, pattern }) covers a From address. Both are lowercase already
// (the table's check and the server's lowercasing). A domain rule matches the address's domain
// and its parents: mail.acme.com matches acme.com, never me.com or x.mail.acme.com.
export function ruleMatches(rule, address) {
  if (typeof address !== "string" || !rule) return false;
  if (rule.match === "address") return address === rule.pattern;
  if (rule.match !== "domain") return false;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domain === rule.pattern || domain.endsWith(`.${rule.pattern}`);
}

// The never-show rule that drops mail from `address`, or null. An always rule never drops.
export const neverRule = (rules, address) => (rules ?? []).find((r) => r.action === "never" && ruleMatches(r, address)) ?? null;

// The From addresses /plan offers "Never show mail from <address>" for, sorted: those with at
// least two messages now labelled not needed, unless a rule of either action already covers it.
// Rows without a from_address count for nothing.
export function neverOffers(feedback, rules) {
  const count = new Map();
  for (const rows of byMessage(feedback).values()) {
    const from = rows.findLast((f) => f.ref.from_address)?.ref.from_address;
    if (from && labelOf(rows) === false) count.set(from, (count.get(from) ?? 0) + 1);
  }
  return [...count].filter(([a, n]) => n >= 2 && !(rules ?? []).some((r) => ruleMatches(r, a))).map(([a]) => a).sort();
}
