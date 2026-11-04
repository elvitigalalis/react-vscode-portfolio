// Verification tests for v5 L1, learning from his taps: src/sheet/triage.mjs (triageLabels,
// scoreTriage, neverOffers) and checkProposal's never-show rules (src/sheet/proposal.mjs).
// Written before the code from docs/sheet-v5.md "Contracts" and spec 47. Every test starts as
// `todo`; the implementer removes `todo` and must not change an expectation. Expected values are
// written out by hand. Modules are imported inside each test, so this file loads before the code
// exists.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). The checkProposal snapshot is
// test/v5-day.verify.test.mjs's, with Needs you items added to its valid proposal.
//
// Readings chosen where the contract leaves room (closest to its words):
// - A needs row in `rows` is v4's, plus `from_address`.
// - A rule's pattern and the From address are both lowercase already (the table's check and the
//   server's lowercasing), so no test mixes case.
import { test } from "node:test";
import assert from "node:assert/strict";

const triage = () => import("../src/sheet/triage.mjs");
const proposal = () => import("../src/sheet/proposal.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const DAY = "2026-11-04";
const SBU = "lisul.elvitigala@stonybrook.edu";
const PERSONAL = "elvitigalalis@gmail.com";
const M1 = "18f2a3b4c5d6e7f1";
const M2 = "18f2a3b4c5d6e7f2";
const M3 = "18f2a3b4c5d6e7f3";
const M4 = "18f2a3b4c5d6e7f4";
const M5 = "18f2a3b4c5d6e7f5";

// =============================================================================================
// triageLabels
// =============================================================================================

const fb = (at, action, account, message_id, from_address = null) => ({ at, item: "needs_you", action, ref: { account, message_id, from_address } });

test("triageLabels: Done is needed, Not needed isn't, Undo leaves no label", async () => {
  const { triageLabels } = await triage();
  const feedback = [
    fb("2026-11-04T14:00:00Z", "done", PERSONAL, M3),
    fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1),
    fb("2026-11-04T15:01:00Z", "done", SBU, M2),
    fb("2026-11-04T15:02:00Z", "undo", SBU, M1),
    fb("2026-11-04T15:03:00Z", "not_needed", PERSONAL, M3),
    // Other items' feedback is no label.
    { at: "2026-11-04T15:04:00Z", item: "proposal", action: "approve", ref: { day: DAY, rev: 2 } },
    { at: "2026-11-04T15:05:00Z", item: "block", action: "turn_down", ref: { day: DAY, task_id: "6f1c2a3b-0000-4000-8000-000000000001" } },
  ];
  assert.deepEqual(triageLabels(feedback), [
    { account: PERSONAL, message_id: M3, needed: false },
    { account: SBU, message_id: M2, needed: true },
  ]);
});

test("triageLabels: the newest row by time decides, whatever the list order", async () => {
  const { triageLabels } = await triage();
  const feedback = [fb("2026-11-04T15:05:00Z", "done", SBU, M1), fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1)];
  assert.deepEqual(triageLabels(feedback), [{ account: SBU, message_id: M1, needed: true }]);
});

test("triageLabels: Not needed again after an Undo labels it again", async () => {
  const { triageLabels } = await triage();
  const feedback = [
    fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1),
    fb("2026-11-04T15:01:00Z", "undo", SBU, M1),
    fb("2026-11-04T15:02:00Z", "not_needed", SBU, M1),
  ];
  assert.deepEqual(triageLabels(feedback), [{ account: SBU, message_id: M1, needed: false }]);
});

// =============================================================================================
// scoreTriage
// =============================================================================================

const key = (account, id) => `${account} ${id}`;

test("scoreTriage: caught, missed and wrongly shown", async () => {
  const { scoreTriage } = await triage();
  const items = [{ account: SBU, message_id: M1 }, { account: SBU, message_id: M2 }, { account: PERSONAL, message_id: M3 }];
  const labels = [
    { account: SBU, message_id: M1, needed: true },
    { account: PERSONAL, message_id: M3, needed: false },
    { account: SBU, message_id: M4, needed: true },
    { account: SBU, message_id: M5, needed: false }, // not shown, not needed: right
  ];
  // M2 was shown with no label, so it is in none of them.
  assert.deepEqual(scoreTriage(items, labels), {
    caught: [key(SBU, M1)],
    missed: [key(SBU, M4)],
    wrongly_shown: [key(PERSONAL, M3)],
  });
});

test("scoreTriage: the same message id in another account is another message", async () => {
  const { scoreTriage } = await triage();
  const r = scoreTriage([{ account: SBU, message_id: M1 }], [{ account: PERSONAL, message_id: M1, needed: true }]);
  assert.deepEqual(r, { caught: [], missed: [key(PERSONAL, M1)], wrongly_shown: [] });
});

test("scoreTriage: keys are listed once, in item order and label order", async () => {
  const { scoreTriage } = await triage();
  const items = [{ account: SBU, message_id: M2 }, { account: SBU, message_id: M1 }, { account: SBU, message_id: M2 }, { account: SBU, message_id: M3 }, { account: SBU, message_id: M3 }];
  const labels = [
    { account: SBU, message_id: M1, needed: true },
    { account: SBU, message_id: M2, needed: true },
    { account: SBU, message_id: M3, needed: false },
    { account: SBU, message_id: M5, needed: true },
    { account: SBU, message_id: M4, needed: true },
  ];
  assert.deepEqual(scoreTriage(items, labels), {
    caught: [key(SBU, M2), key(SBU, M1)],
    missed: [key(SBU, M5), key(SBU, M4)],
    wrongly_shown: [key(SBU, M3)],
  });
});

test("scoreTriage: nothing in, nothing out", async () => {
  const { scoreTriage } = await triage();
  assert.deepEqual(scoreTriage([], []), { caught: [], missed: [], wrongly_shown: [] });
});

// =============================================================================================
// neverOffers: "Never show mail from <address>" after two Not needed
// =============================================================================================

test("neverOffers: two messages from one sender marked Not needed make an offer", async () => {
  const { neverOffers } = await triage();
  const feedback = [
    fb("2026-11-03T15:00:00Z", "not_needed", SBU, M1, "jobs@acme.com"),
    fb("2026-11-04T15:00:00Z", "not_needed", PERSONAL, M2, "jobs@acme.com"),
    fb("2026-11-04T15:01:00Z", "not_needed", SBU, M3, "news@shop.com"), // only one
  ];
  assert.deepEqual(neverOffers(feedback, []), ["jobs@acme.com"]);
});

test("neverOffers: several offers, sorted", async () => {
  const { neverOffers } = await triage();
  const feedback = [
    fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1, "zed@digest.io"),
    fb("2026-11-04T15:01:00Z", "not_needed", SBU, M2, "zed@digest.io"),
    fb("2026-11-04T15:02:00Z", "not_needed", SBU, M3, "jobs@acme.com"),
    fb("2026-11-04T15:03:00Z", "not_needed", SBU, M4, "jobs@acme.com"),
  ];
  assert.deepEqual(neverOffers(feedback, []), ["jobs@acme.com", "zed@digest.io"]);
});

test("neverOffers: one message marked twice is one message", async () => {
  const { neverOffers } = await triage();
  const feedback = [
    fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1, "jobs@acme.com"),
    fb("2026-11-04T15:01:00Z", "undo", SBU, M1, "jobs@acme.com"),
    fb("2026-11-04T15:02:00Z", "not_needed", SBU, M1, "jobs@acme.com"),
  ];
  assert.deepEqual(neverOffers(feedback, []), []);
});

test("neverOffers: an Undo or a later Done takes a message back out", async () => {
  const { neverOffers } = await triage();
  const two = [fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1, "jobs@acme.com"), fb("2026-11-04T15:01:00Z", "not_needed", SBU, M2, "jobs@acme.com")];
  assert.deepEqual(neverOffers([...two, fb("2026-11-04T15:02:00Z", "undo", SBU, M2, "jobs@acme.com")], []), []);
  assert.deepEqual(neverOffers([...two, fb("2026-11-04T15:02:00Z", "done", SBU, M2, "jobs@acme.com")], []), []);
  // Done on its own never counts.
  assert.deepEqual(neverOffers([fb("2026-11-04T15:00:00Z", "done", SBU, M1, "jobs@acme.com"), fb("2026-11-04T15:01:00Z", "done", SBU, M2, "jobs@acme.com")], []), []);
});

test("neverOffers: no offer for an address a rule already covers", async () => {
  const { neverOffers } = await triage();
  const feedback = [fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1, "jobs@mail.acme.com"), fb("2026-11-04T15:01:00Z", "not_needed", SBU, M2, "jobs@mail.acme.com")];
  assert.deepEqual(neverOffers(feedback, [{ match: "domain", pattern: "acme.com", action: "never" }]), []);
  assert.deepEqual(neverOffers(feedback, [{ match: "domain", pattern: "mail.acme.com", action: "never" }]), []);
  assert.deepEqual(neverOffers(feedback, [{ match: "address", pattern: "jobs@mail.acme.com", action: "always" }]), []);
  // Rules that don't cover it: another address, a narrower domain, a look-alike domain.
  const others = [
    { match: "address", pattern: "hr@mail.acme.com", action: "never" },
    { match: "domain", pattern: "x.mail.acme.com", action: "never" },
    { match: "domain", pattern: "me.com", action: "never" },
  ];
  assert.deepEqual(neverOffers(feedback, others), ["jobs@mail.acme.com"]);
});

test("neverOffers: rows with no From address count for nothing", async () => {
  const { neverOffers } = await triage();
  assert.deepEqual(neverOffers([fb("2026-11-04T15:00:00Z", "not_needed", SBU, M1), fb("2026-11-04T15:01:00Z", "not_needed", SBU, M2)], []), []);
});

// =============================================================================================
// checkProposal: never-show rules drop Needs you items
// =============================================================================================

const T1 = "6f1c2a3b-0000-4000-8000-000000000001";
const T2 = "6f1c2a3b-0000-4000-8000-000000000002";
const T3 = "6f1c2a3b-0000-4000-8000-000000000003";
const T4 = "6f1c2a3b-0000-4000-8000-000000000004";
const T5 = "6f1c2a3b-0000-4000-8000-000000000005";
const T6 = "6f1c2a3b-0000-4000-8000-000000000006";
const T7 = "6f1c2a3b-0000-4000-8000-000000000007";
const task = (id, title, est_min, paced_min, extra = {}) => ({
  id, title, est_min, at_time: null, due: null, tag: null, source: null, day: DAY, list: null, at_risk: false, paced_min, ...extra,
});
const snap = (extra = {}) => ({
  version: 5,
  now: "2026-11-04T15:02:00.000Z",
  time_zone: TZ,
  plan_day: DAY,
  shutdown: "17:00",
  window: { from: "10:15", to: "17:00" },
  run: { trigger: "replan", reasons: ["busy_overlap"], changes: { busy: 1 } },
  day_rules: { workload_cap_min: 360, travel_min: 10, break_after_min: 90, break_min: 10 },
  tasks: [
    task(T1, "OS homework", 45, 45, { due: "2026-11-05", at_risk: true }),
    task(T2, "Gym", 60, 60),
    task(T3, "Office hours", 30, 30, { at_time: "13:00:00" }),
    task(T4, "HW3", 30, 45, { due: "2026-11-09", source: "brightspace", day: null, list: "Brightspace" }),
    task(T5, "Lab 4", 40, 60, { due: "2026-11-05", source: "brightspace", day: null, list: "Brightspace", at_risk: true }),
  ],
  blocks: [
    { task_id: T7, starts_at: "2026-11-04T13:30:00Z", ends_at: "2026-11-04T14:30:00Z", proposed: false },
    { task_id: T2, starts_at: "2026-11-04T16:30:00Z", ends_at: "2026-11-04T17:30:00Z", proposed: false },
    { task_id: T1, starts_at: "2026-11-04T20:30:00Z", ends_at: "2026-11-04T21:15:00Z", proposed: true },
  ],
  busy: [{ starts_at: "2026-11-04T19:00:00Z", ends_at: "2026-11-04T20:20:00Z" }],
  busy_as_of: "2026-11-04T15:00:00Z",
  interests: null,
  campus: [],
  proposal: { rev: 1, status: "pending", created_at: "2026-11-04T11:09:00Z", run_trigger: "morning" },
  needs_you_open: [],
  accounts: [SBU, PERSONAL],
  pace: { course: { pace: 1.5, n: 6 }, campus: { pace: null, n: 0 }, github: { pace: null, n: 0 }, jira: { pace: null, n: 0 }, other: { pace: null, n: 2 } },
  planned_vs_done: [],
  turned_down: [T6],
  habits: [],
  triage_rules: [],
  reply_state: { owed: [], awaiting: [] },
  weather: [],
  academic: [],
  ...extra,
});
const LINK = (id) => `https://mail.google.com/mail/?authuser=lisul.elvitigala%40stonybrook.edu#all/${id}`;
const need = (message_id, extra = {}) => ({
  account: SBU, message_id, link: LINK(message_id), sender: "Acme Recruiting", subject: "Next steps", why: "Asks for your availability", kind: "reply", ...extra,
});
const good = (needs_you, extra = {}) => ({
  day: DAY,
  replaces: 1,
  blocks: [
    { task_id: T1, start: "10:15", minutes: 45 },
    { task_id: T3, start: "13:00", minutes: 30 },
    { task_id: T4, start: "15:30", minutes: 45 },
  ],
  needs_you,
  picks: [],
  note: "Lab 4 (1 h) didn't fit before shutdown.",
  couldnt_fit: [T5],
  ...extra,
});
const senders = {
  [`${SBU} ${M1}`]: "jobs@mail.acme.com",
  [`${SBU} ${M2}`]: "prof.kim@stonybrook.edu",
};
const rules = (...r) => snap({ triage_rules: r.map(([match, pattern, action]) => ({ match, pattern, action })) });
const row = (message_id, from_address) => ({
  account: SBU, message_id, link: LINK(message_id), sender: "Acme Recruiting", subject: "Next steps", why: "Asks for your availability", kind: "reply", due: null, from_address,
});

test("never-show: an item whose sender's domain has a never rule is dropped, not refused", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good([need(M2), need(M1)]), rules(["domain", "acme.com", "never"]), senders);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.needs, [row(M2, "prof.kim@stonybrook.edu")]);
  assert.deepEqual(r.dropped, [{ index: 1, message_id: M1, pattern: "acme.com" }]);
});

test("never-show: a domain rule matches the domain itself and its parents only", async () => {
  const { checkProposal } = await proposal();
  const dropped = (rule) => checkProposal(good([need(M1)]), rules(rule), senders).dropped.map((d) => d.message_id);
  assert.deepEqual(dropped(["domain", "mail.acme.com", "never"]), [M1]);
  assert.deepEqual(dropped(["domain", "acme.com", "never"]), [M1]);
  assert.deepEqual(dropped(["domain", "me.com", "never"]), []);
  assert.deepEqual(dropped(["domain", "x.mail.acme.com", "never"]), []);
  assert.deepEqual(dropped(["domain", "stonybrook.edu", "never"]), []);
});

test("never-show: an address rule matches that address only", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good([need(M1), need(M2)]), rules(["address", "jobs@mail.acme.com", "never"]), senders);
  assert.deepEqual(r.dropped, [{ index: 0, message_id: M1, pattern: "jobs@mail.acme.com" }]);
  assert.deepEqual(r.rows.needs, [row(M2, "prof.kim@stonybrook.edu")]);
  const other = checkProposal(good([need(M1)]), rules(["address", "obs@mail.acme.com", "never"]), senders);
  assert.deepEqual(other.dropped, []);
});

test("never-show: an always rule drops nothing", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good([need(M1)]), rules(["domain", "acme.com", "always"]), senders);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.rows.needs, [row(M1, "jobs@mail.acme.com")]);
});

test("never-show: an item with no known sender is kept, with from_address null", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good([need(M3)]), rules(["domain", "acme.com", "never"]), senders);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.rows.needs, [row(M3, null)]);
  // With no senders map at all, too.
  assert.deepEqual(checkProposal(good([need(M3)]), snap()).rows.needs, [row(M3, null)]);
});

test("never-show: a suggestion for a dropped item is dropped with it", todo, async () => {
  const { checkProposal } = await proposal();
  const suggestion = (id) => ({ account: SBU, message_id: id, title: "Acme assessment", due: "2026-11-07", kind: "assessment" });
  const r = checkProposal(good([need(M1), need(M2)], { suggested: [suggestion(M1), suggestion(M2)] }), rules(["domain", "acme.com", "never"]), senders);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.suggested, [suggestion(M2)]);
  assert.deepEqual(r.dropped, [{ index: 0, message_id: M1, pattern: "acme.com" }]);
});
