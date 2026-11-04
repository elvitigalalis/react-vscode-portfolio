// Verification tests for v5 M1, mail metadata and reply tracking: businessDays, automatedSender,
// replyState, skippedCategory, senderHash and mailChanges (src/sheet/mail.mjs), and the brief's
// "Awaiting reply" line (src/sheet/nudges.mjs). Written before the code from docs/sheet-v5.md
// "Contracts" and spec 47. Every test starts as `todo`; the implementer removes `todo` and must
// not change an expectation. Expected values are written out by hand. Modules are imported inside
// each test, so this file loads before the code exists.
//
// November 2026 in New York is EST (UTC-5). Wednesday is Nov 4; Friday Nov 6; the weekend Nov 7-8;
// Monday Nov 9; Tuesday Nov 10; Wednesday Nov 11.
//
// Readings chosen where the contract leaves room (closest to its words):
// - automatedSender takes Gmail's `payload.headers`, `[{ name, value }]`.
// - The brief lists awaiting names in the snapshot's order and counts every row.
// - The hashes below are `shasum -a 256` of the salt and address, written out.
import { test } from "node:test";
import assert from "node:assert/strict";

const mail = () => import("../src/sheet/mail.mjs");
const nudges = () => import("../src/sheet/nudges.mjs");
const todo = { todo: true };

const TZ = "America/New_York";

// =============================================================================================
// businessDays
// =============================================================================================

test("businessDays: Mondays to Fridays after the first date, up to and including the second", async () => {
  const { businessDays } = await mail();
  assert.equal(businessDays("2026-11-04T13:00:00Z", "2026-11-04T22:00:00Z", TZ), 0); // same Wednesday
  assert.equal(businessDays("2026-11-04T15:00:00Z", "2026-11-05T15:00:00Z", TZ), 1); // Wed → Thu
  assert.equal(businessDays("2026-11-04T15:00:00Z", "2026-11-06T15:00:00Z", TZ), 2); // Wed → Fri
  assert.equal(businessDays("2026-11-02T15:00:00Z", "2026-11-16T15:00:00Z", TZ), 10); // two weeks
});

test("businessDays: weekends don't count", async () => {
  const { businessDays } = await mail();
  assert.equal(businessDays("2026-11-06T20:00:00Z", "2026-11-07T20:00:00Z", TZ), 0); // Fri → Sat
  assert.equal(businessDays("2026-11-06T20:00:00Z", "2026-11-08T20:00:00Z", TZ), 0); // Fri → Sun
  assert.equal(businessDays("2026-11-06T20:00:00Z", "2026-11-09T15:00:00Z", TZ), 1); // Fri → Mon
  assert.equal(businessDays("2026-11-06T20:00:00Z", "2026-11-10T15:00:00Z", TZ), 2); // Fri → Tue
  assert.equal(businessDays("2026-11-07T15:00:00Z", "2026-11-09T15:00:00Z", TZ), 1); // Sat → Mon
});

test("businessDays: both dates are read in the owner's time zone", async () => {
  const { businessDays } = await mail();
  // 10 pm Thursday in New York is 03:00 Friday UTC: Friday and Monday count (UTC dates would give 1).
  assert.equal(businessDays("2026-11-06T03:00:00Z", "2026-11-09T17:00:00Z", TZ), 2);
  // 9 pm Monday in New York is 02:00 Tuesday UTC: only Monday counts (UTC dates would give 2).
  assert.equal(businessDays("2026-11-06T17:00:00Z", "2026-11-10T02:00:00Z", TZ), 1);
});

// =============================================================================================
// automatedSender
// =============================================================================================

const headers = (from, extra = []) => [
  { name: "From", value: from },
  { name: "To", value: "Sample Owner <owner@example.com>" },
  { name: "Subject", value: "Hello" },
  ...extra.map(([name, value]) => ({ name, value })),
];

test("automatedSender: a person writing directly is not automated", async () => {
  const { automatedSender } = await mail();
  assert.equal(automatedSender(headers("Ana Ruiz <ana.ruiz@example.edu>")), false);
  assert.equal(automatedSender(headers("kim@cs.example.edu")), false);
  assert.equal(automatedSender(headers("Noah Brooks <noah.brooks@example.com>")), false);
  assert.equal(automatedSender(headers("Ana Ruiz <ana.ruiz@example.edu>", [["Auto-Submitted", "no"]])), false);
});

test("automatedSender: no-reply style local parts", async () => {
  const { automatedSender } = await mail();
  for (const from of [
    "GitHub <noreply@github.com>",
    "Example Bank <no-reply@alerts.example.com>",
    "donotreply@example.edu",
    "GitHub <notifications@github.com>",
    "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "bounce@lists.example.org",
    "Accounts <NoReply@example.com>",
  ]) assert.equal(automatedSender(headers(from)), true, from);
});

test("automatedSender: list and auto-reply headers", async () => {
  const { automatedSender } = await mail();
  const person = "Ana Ruiz <ana.ruiz@example.edu>";
  assert.equal(automatedSender(headers(person, [["List-Id", "CS Department <cs-all.example.edu>"]])), true);
  assert.equal(automatedSender(headers(person, [["List-Unsubscribe", "<mailto:unsub@example.edu>"]])), true);
  assert.equal(automatedSender(headers(person, [["Auto-Submitted", "auto-replied"]])), true);
  assert.equal(automatedSender(headers(person, [["Auto-Submitted", "auto-generated"]])), true);
  assert.equal(automatedSender(headers(person, [["Precedence", "bulk"]])), true);
  assert.equal(automatedSender(headers(person, [["Precedence", "list"]])), true);
  assert.equal(automatedSender(headers(person, [["Precedence", "junk"]])), true);
  assert.equal(automatedSender(headers(person, [["Precedence", "first-class"]])), false);
});

// =============================================================================================
// replyState
// =============================================================================================

const ANA = "Ana Ruiz <ana.ruiz@example.edu>";
const OWNER = "Sample Owner <owner@example.com>";
const msg = (id, date, labels, from, to, automated = false) => ({ id, date, labels, from, to, automated });
const thread = (...messages) => ({ account: "owner@example.com", thread_id: "18f3a1c2d4e5f000", messages });

// Ana wrote on Friday Nov 6 at 3 pm, after his Thursday message.
const owedThread = thread(
  msg("18f3a1c2d4e5f001", "2026-11-05T15:00:00.000Z", ["SENT"], OWNER, ANA),
  msg("18f3a1c2d4e5f002", "2026-11-06T20:00:00.000Z", ["INBOX", "CATEGORY_PERSONAL"], ANA, OWNER),
);
// He wrote to Prof. Kim (and a TA) on Thursday Nov 5 at 10 am.
const awaitingThread = thread(
  msg("18f3a1c2d4e5f011", "2026-11-04T14:00:00.000Z", ["INBOX"], "Prof. Kim <kim@cs.example.edu>", OWNER),
  msg("18f3a1c2d4e5f012", "2026-11-05T15:00:00.000Z", ["SENT"], OWNER, "Prof. Kim <kim@cs.example.edu>, ta@cs.example.edu"),
);
const mon = new Date("2026-11-09T14:00:00Z"); // 9 am Monday
const tue = new Date("2026-11-10T14:00:00Z");
const wed = new Date("2026-11-11T14:00:00Z");

// Revised with the reply-owed fix: owed needs evidence of a conversation and then holds at once
// (mail.mjs, replyState). He wrote in this thread, so Ana's answer is owed from the start.
test("replyState: Reply owed at once when a person answers his thread", async () => {
  const { replyState } = await mail();
  assert.deepEqual(replyState(owedThread, TZ, mon), {
    state: "owed", since: "2026-11-06T20:00:00.000Z", message_id: "18f3a1c2d4e5f002", who: "Ana Ruiz", basis: "thread", draft: false,
  });
});

test("replyState: Awaiting reply after 3 business days, with the first To name", async () => {
  const { replyState } = await mail();
  assert.equal(replyState(awaitingThread, TZ, mon), null); // Thursday → Monday is 2
  assert.deepEqual(replyState(awaitingThread, TZ, tue), {
    state: "awaiting", since: "2026-11-05T15:00:00.000Z", message_id: "18f3a1c2d4e5f012", who: "Prof. Kim",
  });
});

test("replyState: a weekend doesn't move the count", async () => {
  const { replyState } = await mail();
  // Sent on Friday Nov 6: Monday and Tuesday are 2, Wednesday makes 3.
  const sentFriday = thread(msg("18f3a1c2d4e5f021", "2026-11-06T16:00:00.000Z", ["SENT"], OWNER, "Dana Lee <dana.lee@example.com>"));
  assert.equal(replyState(sentFriday, TZ, new Date("2026-11-08T23:00:00Z")), null);
  assert.equal(replyState(sentFriday, TZ, tue), null);
  assert.equal(replyState(sentFriday, TZ, wed).state, "awaiting");
  assert.equal(replyState(sentFriday, TZ, wed).who, "Dana Lee");
});

test("replyState: the newest message decides, by date", async () => {
  const { replyState } = await mail();
  const shuffled = { ...owedThread, messages: [...owedThread.messages].reverse() };
  assert.equal(replyState(shuffled, TZ, tue).message_id, "18f3a1c2d4e5f002");
});

test("replyState: the state clears when the thread moves", async () => {
  const { replyState } = await mail();
  // He answers Ana on Tuesday morning: nothing owed, and too soon to be awaiting.
  const answered = { ...owedThread, messages: [...owedThread.messages, msg("18f3a1c2d4e5f003", "2026-11-10T13:30:00.000Z", ["SENT"], OWNER, ANA)] };
  assert.equal(replyState(answered, TZ, tue), null);
  // Prof. Kim answers on Monday: not awaiting any more; owed at once, since he wrote in the thread.
  const kimAnswered = { ...awaitingThread, messages: [...awaitingThread.messages, msg("18f3a1c2d4e5f013", "2026-11-09T18:00:00.000Z", ["INBOX", "UNREAD"], "Prof. Kim <kim@cs.example.edu>", OWNER)] };
  assert.deepEqual(replyState(kimAnswered, TZ, tue), {
    state: "owed", since: "2026-11-09T18:00:00.000Z", message_id: "18f3a1c2d4e5f013", who: "Prof. Kim", basis: "thread", draft: false,
  });
});

test("replyState: automated senders never make a reply owed", async () => {
  const { replyState } = await mail();
  const t = thread(msg("18f3a1c2d4e5f031", "2026-11-02T15:00:00.000Z", ["INBOX"], "GitHub <notifications@github.com>", OWNER, true));
  assert.equal(replyState(t, TZ, wed), null);
});

// Revised with the reply-owed fix: Ana is someone he has written to (known), writing To him.
const toHim = (m) => ({ ...m, from_address: "ana.ruiz@example.edu", addressed: "to" });
const knownAna = { known: new Set(["ana.ruiz@example.edu"]) };
test("replyState: Promotions, Updates, Social and Forums are skipped", async () => {
  const { replyState } = await mail();
  for (const category of ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]) {
    const t = thread(toHim(msg("18f3a1c2d4e5f041", "2026-11-02T15:00:00.000Z", ["INBOX", category], ANA, OWNER)));
    assert.equal(replyState(t, TZ, wed, knownAna), null, category);
  }
  const personal = thread(toHim(msg("18f3a1c2d4e5f042", "2026-11-02T15:00:00.000Z", ["INBOX", "CATEGORY_PERSONAL"], ANA, OWNER)));
  assert.equal(replyState(personal, TZ, wed, knownAna).state, "owed");
});

test("replyState: spam and trash are passed over", async () => {
  const { replyState } = await mail();
  // His reply went to the trash: Ana's message is the newest that counts.
  const trashed = { ...owedThread, messages: [...owedThread.messages, msg("18f3a1c2d4e5f004", "2026-11-10T13:00:00.000Z", ["SENT", "TRASH"], OWNER, ANA)] };
  assert.equal(replyState(trashed, TZ, tue).message_id, "18f3a1c2d4e5f002");
  assert.equal(replyState(thread(msg("18f3a1c2d4e5f051", "2026-11-02T15:00:00.000Z", ["SPAM"], ANA, OWNER)), TZ, wed), null);
  assert.equal(replyState(thread(), TZ, wed), null);
});

test("replyState: who is a display name, unquoted, or else the local part", async () => {
  const { replyState } = await mail();
  const owedFrom = (from) => replyState(thread(toHim(msg("18f3a1c2d4e5f061", "2026-11-02T15:00:00.000Z", ["INBOX"], from, OWNER))), TZ, wed, knownAna).who;
  assert.equal(owedFrom('"Ruiz, Ana" <ana.ruiz@example.edu>'), "Ruiz, Ana");
  assert.equal(owedFrom("ana.ruiz@example.edu"), "ana.ruiz");
  assert.equal(owedFrom("<ana.ruiz@example.edu>"), "ana.ruiz");
  const sentTo = (to) => replyState(thread(msg("18f3a1c2d4e5f062", "2026-11-02T15:00:00.000Z", ["SENT"], OWNER, to)), TZ, wed).who;
  assert.equal(sentTo("dana.lee@example.com, Sam Ortiz <sam@example.com>"), "dana.lee");
  // Never an address, and at most 80 characters (reply_state.who).
  const long = owedFrom(`${"A".repeat(100)} <ana.ruiz@example.edu>`);
  assert.ok(long.length <= 80 && long.startsWith("AAAA") && !long.includes("@"));
});

test("skippedCategory: the four Gmail categories spec 47 skips", async () => {
  const { skippedCategory } = await mail();
  assert.equal(skippedCategory(["INBOX", "CATEGORY_PROMOTIONS"]), true);
  assert.equal(skippedCategory(["CATEGORY_UPDATES"]), true);
  assert.equal(skippedCategory(["CATEGORY_SOCIAL", "UNREAD"]), true);
  assert.equal(skippedCategory(["CATEGORY_FORUMS"]), true);
  assert.equal(skippedCategory(["INBOX", "CATEGORY_PERSONAL", "IMPORTANT"]), false);
  assert.equal(skippedCategory([]), false);
});

// =============================================================================================
// senderHash
// =============================================================================================

const SALT = "test-salt-0001";

test("senderHash: hex SHA-256 of the salt and the address", async () => {
  const { senderHash } = await mail();
  assert.equal(await senderHash("ana.ruiz@example.edu", SALT), "b2d1910ecb638f419ce06372f8393efff2ab1f90e03954509117859182151af9");
  assert.equal(await senderHash("kim@cs.example.edu", SALT), "1e10efc4fc43e6d00faaeb662af18129323f4edeb39dc8aa1d0e4c8f18590164");
});

test("senderHash: the same address gives the same hash, whatever its case or spaces", async () => {
  const { senderHash } = await mail();
  const h = await senderHash("ana.ruiz@example.edu", SALT);
  assert.equal(await senderHash("Ana.Ruiz@Example.EDU", SALT), h);
  assert.equal(await senderHash("  ana.ruiz@example.edu\n", SALT), h);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("senderHash: the salt matters", async () => {
  const { senderHash } = await mail();
  assert.equal(await senderHash("ana.ruiz@example.edu", "other-salt"), "ed30bbe393cd2abc0240fa98f20c411c8399b1a855288650e1e261dd4184990c");
  assert.notEqual(await senderHash("ana.ruiz@example.edu", "other-salt"), await senderHash("ana.ruiz@example.edu", SALT));
});

// =============================================================================================
// mailChanges
// =============================================================================================

test("mailChanges: weight 2 per new message from a person; 8 when a known sender's reply turns owed", async () => {
  const { mailChanges } = await mail();
  const added = [
    { id: "18f3a1c2d4e5f101", labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], automated: false },
    { id: "18f3a1c2d4e5f102", labels: ["SENT"], automated: false },
    { id: "18f3a1c2d4e5f103", labels: ["INBOX", "CATEGORY_PROMOTIONS"], automated: false },
    { id: "18f3a1c2d4e5f104", labels: ["SPAM"], automated: false },
    { id: "18f3a1c2d4e5f105", labels: ["INBOX"], automated: true },
    { id: "18f3a1c2d4e5f106", labels: ["INBOX", "IMPORTANT"], automated: false },
    { id: "18f3a1c2d4e5f107", labels: ["TRASH"], automated: false },
  ];
  const owed = [{ message_id: "18f3a1c2d4e5f002", known: true }, { message_id: "18f3a1c2d4e5f009", known: false }];
  assert.deepEqual(mailChanges(added, owed), [
    { kind: "mail", reason: "mail_new", weight: 2, ref: "18f3a1c2d4e5f101" },
    { kind: "mail", reason: "mail_new", weight: 2, ref: "18f3a1c2d4e5f106" },
    { kind: "mail", reason: "mail_owed", weight: 8, ref: "18f3a1c2d4e5f002" },
  ]);
});

test("mailChanges: nothing new, no changes", async () => {
  const { mailChanges } = await mail();
  assert.deepEqual(mailChanges([], []), []);
  assert.deepEqual(mailChanges([{ id: "18f3a1c2d4e5f102", labels: ["SENT"], automated: false }], [{ message_id: "18f3a1c2d4e5f009", known: false }]), []);
});

// =============================================================================================
// The brief's Awaiting reply line
// =============================================================================================

const DAY = "2026-11-04";
const settings = { time_zone: TZ, telegram_chat_id: 42, nudges_on: true, morning_on: false };
const B1 = "0b0b0b0b-0000-4000-8000-000000000001";
const tasks = [{ id: "t1", title: "OS homework", day: DAY, done: false, due: null, public: true, est_min: 45 }];
const approved = { id: B1, task_id: "t1", starts_at: "2026-11-04T15:00:00Z", ends_at: "2026-11-04T15:45:00Z", proposed: false, gcal_id: null };
const snapshot = (extra = {}) => ({ settings, day: null, tasks, blocks: [approved], log: [], proposal: null, needsOpen: [], campus: [], ...extra });
const at8 = new Date("2026-11-04T13:00:00Z");
const briefOf = (out) => out.find((m) => m.kind === "brief");
const awaiting = (who, since) => ({ account: "owner@example.com", thread_id: `t-${who}`, state: "awaiting", since, message_id: `m-${who}`, who });
const ROWS = [
  awaiting("Ana Ruiz", "2026-10-28T15:00:00Z"),
  awaiting("Prof. Kim", "2026-10-29T15:00:00Z"),
  awaiting("Dana Lee", "2026-10-30T15:00:00Z"),
  awaiting("Sam Ortiz", "2026-10-30T16:00:00Z"),
];

test("brief: Awaiting reply names who he's waiting on", async () => {
  const { whatToSend } = await nudges();
  assert.equal(briefOf(whatToSend(snapshot({ awaiting: ROWS.slice(0, 2) }), at8)).text, [
    "Today: 1 task, 1 block.",
    "Awaiting reply: 2 (Ana Ruiz, Prof. Kim).",
  ].join("\n"));
});

test("brief: at most 3 names, every thread counted", async () => {
  const { whatToSend } = await nudges();
  assert.equal(briefOf(whatToSend(snapshot({ awaiting: ROWS }), at8)).text, [
    "Today: 1 task, 1 block.",
    "Awaiting reply: 4 (Ana Ruiz, Prof. Kim, Dana Lee).",
  ].join("\n"));
});

test("brief: no awaiting rows, no line", async () => {
  const { whatToSend } = await nudges();
  assert.equal(briefOf(whatToSend(snapshot({ awaiting: [] }), at8)).text, "Today: 1 task, 1 block.");
  assert.equal(briefOf(whatToSend(snapshot(), at8)).text, "Today: 1 task, 1 block.");
});

test("brief: names cut to 30, names only, nothing link-like", async () => {
  const { whatToSend } = await nudges();
  const long = "Alexandria Montgomery-Fitzwilliam the Third"; // 43 characters
  const text = briefOf(whatToSend(snapshot({ awaiting: [awaiting(long, "2026-10-28T15:00:00Z"), awaiting("www.example.com", "2026-10-29T15:00:00Z")] }), at8)).text;
  const line = text.split("\n").find((l) => l.startsWith("Awaiting reply: "));
  assert.ok(line, text);
  assert.ok(line.includes("Alexandria Montgomery-Fitzwil") && !line.includes(long), line);
  assert.doesNotMatch(line, /example\.com|@/);
  // The names inside the parentheses are each 30 characters or fewer.
  for (const name of line.replace(/^Awaiting reply: \d+ \(|\)\.$/g, "").split(", ")) assert.ok(name.length <= 30, name);
});

test("brief: the Awaiting reply line comes after the plan's lines", async () => {
  const { whatToSend } = await nudges();
  const proposed = { ...approved, id: "0b0b0b0b-0000-4000-8000-000000000002", starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z", proposed: true };
  const proposal = { day: DAY, rev: 1, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [], couldnt_fit: [], suggested: [], run_trigger: "morning", reasons: [], blocks: [] };
  const snap = snapshot({ blocks: [proposed], proposal, awaiting: ROWS.slice(0, 1) });
  assert.equal(briefOf(whatToSend(snap, at8)).text, [
    "Today: 1 task, 0 blocks.",
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
    "Awaiting reply: 1 (Ana Ruiz).",
  ].join("\n"));
});
