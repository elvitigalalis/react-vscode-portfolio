// Reply tracking beyond the verification tests (test/v5-mail.verify.test.mjs; docs/sheet-v5.md,
// M1): read_planner's `reply_state` (proposal.mjs, planSnapshot), the brief on an empty day, and
// how the mail sync reads Gmail's metadata (mail.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSnapshot } from "../src/sheet/proposal.mjs";
import { whatToSend } from "../src/sheet/nudges.mjs";

const TZ = "America/New_York";
const settings = { id: true, time_zone: TZ, interests: null, busy_as_of: null };
const rows = (extra = {}) => ({ settings, tasks: [], blocks: [], busy: [], days: [], campus: [], proposal: null, needsOpen: [], accounts: [], ...extra });
const sixOhSeven = new Date("2026-11-04T11:07:00Z");
const row = (state, who, since) => ({ account: "owner@example.com", thread_id: `t-${who}`, state, since, message_id: `m-${who}`, who, updated_at: since });

test("planSnapshot: reply_state splits the rows into owed and awaiting, oldest first, without message ids", () => {
  const replyState = [
    row("owed", "Ana Ruiz", "2026-10-30T15:00:00Z"),
    row("awaiting", "Prof. Kim", "2026-10-29T15:00:00Z"),
    row("owed", "Dana Lee", "2026-10-28T15:00:00Z"),
  ];
  assert.deepEqual(planSnapshot(rows({ replyState }), sixOhSeven).reply_state, {
    owed: [
      { account: "owner@example.com", thread_id: "t-Dana Lee", who: "Dana Lee", since: "2026-10-28T15:00:00Z" },
      { account: "owner@example.com", thread_id: "t-Ana Ruiz", who: "Ana Ruiz", since: "2026-10-30T15:00:00Z" },
    ],
    awaiting: [{ account: "owner@example.com", thread_id: "t-Prof. Kim", who: "Prof. Kim", since: "2026-10-29T15:00:00Z" }],
  });
  assert.deepEqual(planSnapshot(rows(), sixOhSeven).reply_state, { owed: [], awaiting: [] });
});

test("brief: an empty day still names who he's waiting on", () => {
  const snap = { settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true }, day: null, tasks: [], blocks: [], log: [],
    awaiting: [row("awaiting", "Prof. Kim", "2026-10-29T15:00:00Z")] };
  const brief = whatToSend(snap, new Date("2026-11-04T13:00:00Z")).find((m) => m.kind === "brief");
  assert.equal(brief.text, "Nothing on today.\nAwaiting reply: 1 (Prof. Kim).");
});

test("brief: an address-like name is left out, the thread still counted", () => {
  const snap = { settings: { time_zone: TZ, telegram_chat_id: 42, nudges_on: true }, day: null, tasks: [], blocks: [], log: [],
    awaiting: [row("awaiting", "https://evil.example", "2026-10-29T15:00:00Z")] };
  const brief = whatToSend(snap, new Date("2026-11-04T13:00:00Z")).find((m) => m.kind === "brief");
  assert.equal(brief.text, "Nothing on today.\nAwaiting reply: 1.");
});

// --- The mail sync's reads ---------------------------------------------------------------------

test("metadataQuery: metadata with the sender and automation headers and named fields, never a body or snippet", async () => {
  const { metadataQuery } = await import("../src/sheet/mail.mjs");
  for (const thread of [false, true]) {
    const q = new URLSearchParams(metadataQuery(thread));
    assert.equal(q.get("format"), "metadata");
    assert.deepEqual(q.getAll("metadataHeaders"), ["From", "To", "List-Id", "List-Unsubscribe", "Auto-Submitted", "Precedence",
      "Cc", "Sender", "Reply-To", "List-Unsubscribe-Post", "X-Auto-Response-Suppress", "Feedback-ID", "Return-Path"]);
    assert.ok(!q.getAll("metadataHeaders").includes("Subject"));
    assert.doesNotMatch(q.get("fields"), /snippet|raw|body|parts|sizeEstimate/);
  }
  assert.equal(new URLSearchParams(metadataQuery()).get("fields"), "id,threadId,labelIds,internalDate,payload/headers");
  assert.equal(new URLSearchParams(metadataQuery(true)).get("fields"), "id,messages(id,threadId,labelIds,internalDate,payload/headers)");
});

const gmailMessage = (id, ms, labels, from, extra = []) => ({
  id, threadId: "18f3a1c2d4e5f000", labelIds: labels, internalDate: String(ms),
  payload: { headers: [{ name: "From", value: from }, { name: "To", value: "Sample Owner <owner@example.com>" }, ...extra] },
});

test("syncThread: messages as replyState reads them; a draft is left out but flagged", async () => {
  const { syncThread } = await import("../src/sheet/mail.mjs");
  const t = syncThread({ id: "18f3a1c2d4e5f000", messages: [
    gmailMessage("18f3a1c2d4e5f001", Date.parse("2026-11-06T20:00:00Z"), ["INBOX"], "Ana Ruiz <Ana.Ruiz@example.edu>"),
    gmailMessage("18f3a1c2d4e5f002", Date.parse("2026-11-06T21:00:00Z"), ["INBOX"], "News <news@example.com>", [{ name: "List-Id", value: "<news.example.com>" }]),
    gmailMessage("18f3a1c2d4e5f003", Date.parse("2026-11-07T21:00:00Z"), ["DRAFT"], "Sample Owner <owner@example.com>"),
  ] }, "owner@example.com");
  const common = { thread_id: "18f3a1c2d4e5f000", labels: ["INBOX"], to: "Sample Owner <owner@example.com>", cc: "", addressed: "to", demerit: false };
  assert.deepEqual(t, { account: "owner@example.com", thread_id: "18f3a1c2d4e5f000", draft: true, messages: [
    { id: "18f3a1c2d4e5f001", date: "2026-11-06T20:00:00.000Z", ...common,
      from: "Ana Ruiz <Ana.Ruiz@example.edu>", from_address: "ana.ruiz@example.edu", automated: false },
    { id: "18f3a1c2d4e5f002", date: "2026-11-06T21:00:00.000Z", ...common,
      from: "News <news@example.com>", from_address: "news@example.com", automated: true },
  ] });
  assert.equal(syncThread({ id: "18f3a1c2d4e5f000", messages: [] }, "owner@example.com").draft, false);
});

test("syncMessage: addressed is to, cc or none for the account, worked out in memory", async () => {
  const { syncMessage } = await import("../src/sheet/mail.mjs");
  const m = (to, cc) => ({ ...gmailMessage("18f3a1c2d4e5f001", 0, ["INBOX"], "Ana Ruiz <ana.ruiz@example.edu>"),
    payload: { headers: [{ name: "From", value: "Ana Ruiz <ana.ruiz@example.edu>" }, { name: "To", value: to }, { name: "Cc", value: cc }] } });
  assert.equal(syncMessage(m("Sample Owner <Owner@Example.com>", ""), "owner@example.com").addressed, "to");
  assert.equal(syncMessage(m("team@example.edu", "owner@example.com, b@example.edu"), "owner@example.com").addressed, "cc");
  assert.equal(syncMessage(m("team@example.edu", ""), "owner@example.com").addressed, "none");
  assert.equal(syncMessage(m("owner@example.com", "")).addressed, "none");
});

test("historyChanges: the threads touched and messages added, each once", async () => {
  const { historyChanges } = await import("../src/sheet/mail.mjs");
  const m = (id, threadId) => ({ message: { id, threadId } });
  const pages = [
    { history: [{ id: "1", messagesAdded: [m("a1", "t1"), m("a2", "t2")] }, { id: "2", labelsAdded: [{ ...m("a0", "t3"), labelIds: ["TRASH"] }] }] },
    { history: [{ id: "3", messagesAdded: [m("a1", "t1")], labelsRemoved: [m("a2", "t2")], messagesDeleted: [m("a9", "t4")] }] },
    {},
  ];
  assert.deepEqual(historyChanges(pages), { threads: ["t1", "t2", "t3", "t4"], added: ["a1", "a2"] });
});

test("newestPerThread: the first message listed of each thread", async () => {
  const { newestPerThread } = await import("../src/sheet/mail.mjs");
  assert.deepEqual(newestPerThread([{ id: "m3", threadId: "t1" }, { id: "m2", threadId: "t2" }, { id: "m1", threadId: "t1" }]),
    [{ id: "m3", threadId: "t1" }, { id: "m2", threadId: "t2" }]);
});

test("replyDiff: upserts, deletes, and owed only when it turns owed at a new message", async () => {
  const { replyDiff } = await import("../src/sheet/mail.mjs");
  const owed = (message_id, who) => ({ state: "owed", since: "2026-11-06T20:00:00.000Z", message_id, who });
  const before = [
    { thread_id: "t1", state: "owed", message_id: "m1" },
    { thread_id: "t2", state: "awaiting", message_id: "m2" },
    { thread_id: "t3", state: "owed", message_id: "m3" },
  ];
  const after = [
    { thread_id: "t1", state: owed("m1", "Ana Ruiz"), from_address: "ana.ruiz@example.edu" },   // still owed
    { thread_id: "t2", state: owed("m2b", "Prof. Kim"), from_address: "kim@cs.example.edu" },  // Kim answered
    { thread_id: "t3", state: null, from_address: null },                                       // he replied
    { thread_id: "t4", state: owed("m4", "Dana Lee"), from_address: "dana.lee@example.com" },  // new, unknown
    { thread_id: "t5", state: null, from_address: null },                                       // nothing before or now
  ];
  const known = new Set(["kim@cs.example.edu", "ana.ruiz@example.edu"]);
  assert.deepEqual(replyDiff("owner@example.com", before, after, known), {
    upserts: [
      { account: "owner@example.com", thread_id: "t1", ...owed("m1", "Ana Ruiz") },
      { account: "owner@example.com", thread_id: "t2", ...owed("m2b", "Prof. Kim") },
      { account: "owner@example.com", thread_id: "t4", ...owed("m4", "Dana Lee") },
    ],
    deletes: ["t3"],
    owed: [{ message_id: "m2b", known: true, basis: null }, { message_id: "m4", known: false, basis: null }],
  });
});

test("searchMarks: known by From address, reply_state by account and thread", async () => {
  const { searchMarks } = await import("../src/sheet/mail.mjs");
  const s = (account, thread_id, from) => ({ account, id: `${thread_id}-m`, thread_id, from });
  const out = searchMarks(
    [s("owner@example.com", "t1", "Ana Ruiz <Ana.Ruiz@example.edu>"), s("other@example.com", "t1", "x@example.com"), s("owner@example.com", "t2", "")],
    new Set(["ana.ruiz@example.edu"]),
    [{ account: "owner@example.com", thread_id: "t1", state: "owed" }],
  );
  assert.deepEqual(out.map((r) => [r.known, r.reply_state]), [[true, "owed"], [false, null], [false, null]]);
});

test("mail-sync: never asks Gmail for a body, a snippet or a raw message", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../supabase/functions/mail-sync/index.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /format=(full|raw)|messageBody|snippet|\/attachments/);
  assert.match(code, /metadataQuery\(true\)/);
  assert.match(code, /fields: "messages\(id,threadId\)"/);
  // The sent list for participation asks for thread ids only, and replyState gets it and known.
  assert.match(code, /q: "in:sent newer_than:30d", maxResults: "500", fields: "messages\(threadId\)"/);
  assert.match(code, /replyState\(t, tz, now, \{ participated: sentThreads\.has\(t\.thread_id\), known \}\)/);
});

test("threadLink: Gmail's thread link for an Awaiting reply row, only for a hex thread id", async () => {
  const { threadLink } = await import("../src/sheet/morning.mjs");
  assert.equal(threadLink("owner@example.com", "18f3a1c2d4e5f000"), "https://mail.google.com/mail/?authuser=owner%40example.com#all/18f3a1c2d4e5f000");
  assert.equal(threadLink("owner@example.com", "javascript:alert(1)"), null);
  assert.equal(threadLink("owner@example.com", null), null);
});

test("threadsToRead: at most 50 threads a run; cutting any off makes the next run a full sync", async () => {
  const { threadsToRead } = await import("../src/sheet/mail.mjs");
  const ids = (n) => Array.from({ length: n }, (_, i) => `t${i}`);
  assert.deepEqual(threadsToRead(ids(3), false), { threads: ["t0", "t1", "t2"], full: false });
  const many = threadsToRead(ids(51), false);
  assert.equal(many.threads.length, 50);
  assert.equal(many.threads[49], "t49");
  assert.equal(many.full, true);
  assert.equal(threadsToRead(ids(50), false).full, false);
  // More history pages than a run reads is a full sync already.
  assert.equal(threadsToRead(ids(2), true).full, true);
});

test("senderHashes: the salted hash of the address, and of its domain and every parent", async () => {
  const { senderHashes } = await import("../src/sheet/mail.mjs");
  const { createHash } = await import("node:crypto");
  const sha = (x) => createHash("sha256").update(`pepper${x}`).digest("hex");
  assert.deepEqual(await senderHashes("  Jobs@Mail.Acme.com ", "pepper"), {
    address_hash: sha("jobs@mail.acme.com"),
    domain_hashes: [sha("mail.acme.com"), sha("acme.com"), sha("com")],
  });
  assert.equal(await senderHashes("not an address", "pepper"), null);
});

// --- Reply owed from positive evidence ---------------------------------------------------------
// Owed needs evidence of a conversation: he wrote in the thread, or he has written to the sender.
// Machine mail (list, auto-reply and ESP headers, no-reply style addresses) never counts. The
// fixtures are anonymised versions of real misses: a reply in his own thread a day old, a bank's
// no.reply.alerts mail and a one-time passcode from a careers address.

const hdrs = (from, extra = []) => [
  { name: "From", value: from }, { name: "To", value: "Sample Owner <owner@example.com>" },
  ...extra.map(([name, value]) => ({ name, value })),
];

test("automatedSender: a bank's no.reply.alerts address is a machine", async () => {
  const { automatedSender } = await import("../src/sheet/mail.mjs");
  assert.equal(automatedSender(hdrs("Bank <no.reply.alerts@bank.example.com>")), true);
});

test("automatedSender: no-reply addresses however they're spelled", async () => {
  const { automatedSender } = await import("../src/sheet/mail.mjs");
  for (const from of ["alerts-noreply@x.example.com", "do.not.reply@x.example.com", "donotreply@x.example.com",
    "notifications+abc@code.example.com", "x_no-reply_y@x.example.com", "Alerts <alerts@x.example.com>"]) {
    assert.equal(automatedSender(hdrs(from)), true, from);
  }
});

test("automatedSender: a person is not; a person-like info.* prefix is (an accepted false positive)", async () => {
  const { automatedSender } = await import("../src/sheet/mail.mjs");
  assert.equal(automatedSender(hdrs("Ana Ruiz <ana.ruiz@example.edu>")), false);
  assert.equal(automatedSender(hdrs("Ana <info.ana@x.example.com>")), true);
});

test("automatedSender: a machine Sender behind a person's From", async () => {
  const { automatedSender } = await import("../src/sheet/mail.mjs");
  assert.equal(automatedSender(hdrs("Ana Ruiz <ana.ruiz@example.edu>", [["Sender", "Google Calendar <calendar-notification@google.com>"]])), true);
  assert.equal(automatedSender(hdrs("Ana Ruiz <ana.ruiz@example.edu>", [["Sender", "ana.ruiz@example.edu"]])), false);
});

test("automatedSender: one-click unsubscribe, Feedback-ID and Auto-Submitted", async () => {
  const { automatedSender } = await import("../src/sheet/mail.mjs");
  const ana = "Ana Ruiz <ana.ruiz@example.edu>";
  assert.equal(automatedSender(hdrs(ana, [["List-Unsubscribe-Post", "List-Unsubscribe=One-Click"]])), true);
  assert.equal(automatedSender(hdrs(ana, [["Feedback-ID", "1:2:acme"]])), true);
  assert.equal(automatedSender(hdrs(ana, [["Auto-Submitted", "no"]])), false);
  assert.equal(automatedSender(hdrs(ana, [["Auto-Submitted", "auto-replied"]])), true);
});

test("automationDemerit: X-Auto-Response-Suppress counts against, without making it automated", async () => {
  const { automatedSender, automationDemerit } = await import("../src/sheet/mail.mjs");
  const h = hdrs("Ana Ruiz <ana.ruiz@example.edu>", [["X-Auto-Response-Suppress", "All"]]);
  assert.equal(automatedSender(h), false);
  assert.equal(automationDemerit(h), true);
  assert.equal(automationDemerit(hdrs("Ana Ruiz <ana.ruiz@example.edu>")), false);
  assert.equal(automationDemerit(hdrs("Ana Ruiz <ana.ruiz@example.edu>", [["Return-Path", "<bounce-123@mail.example.com>"]])), true);
  assert.equal(automationDemerit(hdrs("Ana Ruiz <ana.ruiz@example.edu>", [["Return-Path", "<ana.ruiz@example.edu>"]])), false);
});

// replyState. Mon Nov 2 to Thu Nov 5, 2026, New York (EST).
const ME = "Sample Owner <owner@example.com>";
const PAT = "Pat Kim <pat.kim@example.org>";
const m = (id, date, labels, from, to, more = {}) => ({ id, date, labels, from, to, from_address: from.match(/<([^>]+)>|(\S+@\S+)/).slice(1).find(Boolean).toLowerCase(),
  automated: false, demerit: false, addressed: labels.includes("SENT") ? "none" : "to", ...more });
const th = (messages, more = {}) => ({ account: "owner@example.com", thread_id: "18f3a1c2d4e5f700", messages, ...more });
const wed0607 = new Date("2026-11-04T11:07:00Z");
// He wrote Monday 10 am; Pat answered Tuesday 3 pm ("let me know what works for you").
const hisThread = [
  m("18f3a1c2d4e5f701", "2026-11-02T15:00:00.000Z", ["SENT"], ME, PAT),
  m("18f3a1c2d4e5f702", "2026-11-03T20:00:00.000Z", ["INBOX", "CATEGORY_PERSONAL"], PAT, ME),
];

test("replyState: a reply in a thread he started is owed at once (basis thread)", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  assert.deepEqual(replyState(th(hisThread), TZ, wed0607), {
    state: "owed", since: "2026-11-03T20:00:00.000Z", message_id: "18f3a1c2d4e5f702", who: "Pat Kim", basis: "thread", draft: false,
  });
});

test("replyState: his unsent draft is not a reply; the thread stays owed, marked draft", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const s = replyState(th(hisThread, { draft: true }), TZ, wed0607);
  assert.equal(s.state, "owed");
  assert.equal(s.draft, true);
});

test("replyState: an out-of-office reply doesn't count as them answering", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const oof = [hisThread[0], m("18f3a1c2d4e5f703", "2026-11-03T20:00:00.000Z", ["INBOX"], PAT, ME, { automated: true })];
  assert.equal(replyState(th(oof), TZ, wed0607), null); // Monday → Wednesday is 2
  assert.deepEqual(replyState(th(oof), TZ, new Date("2026-11-05T14:00:00Z")), {
    state: "awaiting", since: "2026-11-02T15:00:00.000Z", message_id: "18f3a1c2d4e5f701", who: "Pat Kim",
  });
});

test("replyState: Updates doesn't hide a reply in his own thread", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const updates = [hisThread[0], { ...hisThread[1], labels: ["INBOX", "CATEGORY_UPDATES"], demerit: true }];
  assert.equal(replyState(th(updates), TZ, wed0607).basis, "thread");
});

test("replyState: a one-time passcode from a careers address is never owed", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const otp = m("18f3a1c2d4e5f711", "2026-11-02T15:00:00.000Z", ["IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
    "Careers <careers@recruitment.example.com>", ME);
  assert.equal(replyState(th([otp]), TZ, wed0607), null);
});

test("replyState: a bank's alert stream is never owed", async () => {
  const { replyState, syncMessage } = await import("../src/sheet/mail.mjs");
  const alert = (i) => syncMessage({ id: `18f3a1c2d4e5f72${i}`, threadId: "18f3a1c2d4e5f700", labelIds: ["INBOX", i % 2 ? "CATEGORY_PERSONAL" : "CATEGORY_UPDATES"],
    internalDate: String(Date.parse("2026-10-28T15:00:00Z") + i * 3_600_000),
    payload: { headers: [{ name: "From", value: "Bank <no.reply.alerts@bank.example.com>" }, { name: "To", value: ME }] } }, "owner@example.com");
  const known = new Set(["no.reply.alerts@bank.example.com"]);
  assert.equal(replyState(th([0, 1, 2, 3, 4, 5].map(alert)), TZ, wed0607, { known }), null);
});

test("replyState: someone he has written to is owed at once when it's to him, at 2 business days when he's copied", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const known = new Set(["pat.kim@example.org"]);
  const to = m("18f3a1c2d4e5f731", "2026-11-04T10:00:00.000Z", ["INBOX"], PAT, ME);
  assert.deepEqual(replyState(th([to]), TZ, wed0607, { known }), {
    state: "owed", since: "2026-11-04T10:00:00.000Z", message_id: "18f3a1c2d4e5f731", who: "Pat Kim", basis: "known", draft: false,
  });
  const cc = { ...m("18f3a1c2d4e5f732", "2026-11-03T15:00:00.000Z", ["INBOX"], PAT, "team@example.org"), addressed: "cc" };
  assert.equal(replyState(th([cc]), TZ, wed0607, { known }), null); // Tuesday → Wednesday is 1
  assert.equal(replyState(th([cc]), TZ, new Date("2026-11-05T14:00:00Z"), { known }).basis, "cc");
  // Updates or an Exchange auto-response flag keeps a known sender's mail from being owed.
  assert.equal(replyState(th([{ ...to, labels: ["INBOX", "CATEGORY_UPDATES"] }]), TZ, wed0607, { known }), null);
  assert.equal(replyState(th([{ ...to, demerit: true }]), TZ, wed0607, { known }), null);
  // Promotions, Social and Forums never count.
  assert.equal(replyState(th([{ ...to, labels: ["INBOX", "CATEGORY_SOCIAL"] }]), TZ, wed0607, { known }), null);
});

test("replyState: an unknown person writing to him is left to the planner, however old", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const cold = m("18f3a1c2d4e5f741", "2026-10-28T15:00:00.000Z", ["INBOX", "CATEGORY_PERSONAL"], PAT, ME);
  assert.equal(replyState(th([cold]), TZ, wed0607), null); // 5 business days
});

test("replyState: a known sender's list mail is never owed", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const list = m("18f3a1c2d4e5f751", "2026-11-04T10:00:00.000Z", ["INBOX"], PAT, ME, { automated: true });
  assert.equal(replyState(th([list]), TZ, wed0607, { known: new Set(["pat.kim@example.org"]) }), null);
});

test("replyState: the sweep's single newest message, with participation from his sent list", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  assert.equal(replyState(th([hisThread[1]]), TZ, wed0607), null);
  assert.equal(replyState(th([hisThread[1]]), TZ, wed0607, { participated: true }).basis, "thread");
});

test("replyState: when he wrote last, awaiting only from 3 business days", async () => {
  const { replyState } = await import("../src/sheet/mail.mjs");
  const sent = [m("18f3a1c2d4e5f761", "2026-11-02T15:00:00.000Z", ["SENT"], ME, PAT)];
  assert.equal(replyState(th(sent), TZ, wed0607), null);
  assert.equal(replyState(th(sent), TZ, new Date("2026-11-05T14:00:00Z")).state, "awaiting");
});

test("mailChanges: a thread turning owed because they answered him replans, known or not", async () => {
  const { replyDiff, mailChanges } = await import("../src/sheet/mail.mjs");
  const state = { state: "owed", since: "2026-11-03T20:00:00.000Z", message_id: "18f3a1c2d4e5f702", who: "Pat Kim", basis: "thread", draft: false };
  const diff = replyDiff("owner@example.com", [], [{ thread_id: "18f3a1c2d4e5f700", state, from_address: "pat.kim@example.org" }], new Set());
  assert.deepEqual(diff.owed, [{ message_id: "18f3a1c2d4e5f702", known: false, basis: "thread" }]);
  assert.deepEqual(mailChanges([], diff.owed), [{ kind: "mail", reason: "mail_owed", weight: 8, ref: "18f3a1c2d4e5f702" }]);
});

test("replyDiff: an owed thread read again at the same message doesn't fire again, overdue or not", async () => {
  const { replyDiff } = await import("../src/sheet/mail.mjs");
  const state = { state: "owed", since: "2026-11-03T20:00:00.000Z", message_id: "18f3a1c2d4e5f702", who: "Pat Kim", basis: "thread", draft: false };
  const before = [{ thread_id: "18f3a1c2d4e5f700", state: "owed", message_id: "18f3a1c2d4e5f702" }];
  assert.deepEqual(replyDiff("owner@example.com", before, [{ thread_id: "18f3a1c2d4e5f700", state, from_address: null }], new Set()).owed, []);
});
