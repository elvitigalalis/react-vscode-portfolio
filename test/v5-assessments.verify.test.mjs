// Verification tests for v5 A1, assessment and interview deadlines as tasks: the sender matcher
// (assessmentSender, src/sheet/mail.mjs), checkProposal's suggested tasks and the "Task to add"
// line (src/sheet/proposal.mjs). Written before the code from docs/sheet-v5.md "Contracts" and
// spec 47. Every test starts as `todo`; the implementer removes `todo` and must not change an
// expectation. Expected values are written out by hand. Modules are imported inside each test, so
// this file loads before the code exists. approve_proposal creating the task once per message is
// checked in SQL, in tools/test-schema.sh ("v5 A1").
//
// Wednesday 2026-11-04 in New York, EST (UTC-5). The checkProposal snapshot is
// test/v5-day.verify.test.mjs's, with a HackerRank mail item in its valid proposal.
//
// Readings chosen where the contract leaves room (closest to its words):
// - assessmentSender takes a bare address; the domain is matched without regard to case.
// - Tests match an error's field name, not its wording.
// - "Task to add" lines come right after "Couldn't fit", before the campus picks and Mail lines.
import { test } from "node:test";
import assert from "node:assert/strict";

const mail = () => import("../src/sheet/mail.mjs");
const proposal = () => import("../src/sheet/proposal.mjs");
const todo = { todo: true };

const TZ = "America/New_York";
const DAY = "2026-11-04";
const SBU = "lisul.elvitigala@stonybrook.edu";
const PERSONAL = "elvitigalalis@gmail.com";

// =============================================================================================
// assessmentSender
// =============================================================================================

test("assessmentSender: online-assessment senders", async () => {
  const { assessmentSender } = await mail();
  for (const from of ["no-reply@hackerrank.com", "support@codesignal.com", "noreply@codility.com", "noreply@hirevue.com"]) {
    assert.equal(assessmentSender(from), "assessment", from);
  }
});

test("assessmentSender: interview-scheduling senders", async () => {
  const { assessmentSender } = await mail();
  for (const from of ["scheduling@karat.com", "notifications@calendly.com", "no-reply@goodtime.io"]) {
    assert.equal(assessmentSender(from), "interview", from);
  }
});

test("assessmentSender: any subdomain, and any case", async () => {
  const { assessmentSender } = await mail();
  assert.equal(assessmentSender("invites@email.hackerrank.com"), "assessment");
  assert.equal(assessmentSender("x@app.eu.codesignal.com"), "assessment");
  assert.equal(assessmentSender("no-reply@app.goodtime.io"), "interview");
  assert.equal(assessmentSender("No-Reply@HackerRank.com"), "assessment");
});

test("assessmentSender: look-alikes and everything else are null", async () => {
  const { assessmentSender } = await mail();
  for (const from of [
    "a@nothackerrank.com", // not a subdomain
    "a@hackerrank.com.evil.io", // the name inside another domain
    "hackerrank.com@gmail.com", // the name as the local part
    "recruiting@acme.com",
    "lisul.elvitigala@stonybrook.edu",
    "",
  ]) assert.equal(assessmentSender(from), null, from);
});

// =============================================================================================
// checkProposal: suggested tasks
// =============================================================================================

const T1 = "6f1c2a3b-0000-4000-8000-000000000001";
const T2 = "6f1c2a3b-0000-4000-8000-000000000002";
const T3 = "6f1c2a3b-0000-4000-8000-000000000003";
const T4 = "6f1c2a3b-0000-4000-8000-000000000004";
const T5 = "6f1c2a3b-0000-4000-8000-000000000005";
const T6 = "6f1c2a3b-0000-4000-8000-000000000006";
const T7 = "6f1c2a3b-0000-4000-8000-000000000007";
const M = (n) => `18f2a3b4c5d6e7f${n}`;
const M1 = M(1);
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
const need = (message_id, extra = {}) => ({
  account: SBU, message_id, link: `https://mail.google.com/mail/?authuser=lisul.elvitigala%40stonybrook.edu#all/${message_id}`,
  sender: "HackerRank", subject: "Your Acme online assessment", why: "Assessment due Nov 7", kind: "deadline", due: "2026-11-07", ...extra,
});
const hr = (extra = {}) => ({ account: SBU, message_id: M1, title: "Acme HackerRank assessment", due: "2026-11-07", kind: "assessment", ...extra });
const good = (extra = {}) => ({
  day: DAY,
  replaces: 1,
  blocks: [
    { task_id: T1, start: "10:15", minutes: 45 },
    { task_id: T3, start: "13:00", minutes: 30 },
    { task_id: T4, start: "15:30", minutes: 45 },
  ],
  needs_you: [need(M1)],
  picks: [],
  note: null,
  couldnt_fit: [T5],
  suggested: [hr()],
  ...extra,
});
const with1 = (fields) => good({ suggested: [hr(fields)] });

function refused(result, ...patterns) {
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "expected errors");
  assert.ok(result.errors.some((e) => patterns.every((p) => p.test(e))), `no error matching ${patterns.join(" and ")}: ${JSON.stringify(result.errors)}`);
}

test("suggested: a suggestion for one of this submit's items passes through to rows", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good(), snap());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.suggested, [{ account: SBU, message_id: M1, title: "Acme HackerRank assessment", due: "2026-11-07", kind: "assessment" }]);
});

test("suggested: an interview suggestion passes too", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(with1({ title: "Karat interview with Acme", kind: "interview" }), snap());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.suggested[0].kind, "interview");
});

test("suggested: the title is free text, its spaces collapsed", async () => {
  const { checkProposal } = await proposal();
  assert.equal(checkProposal(with1({ title: "  Acme   HackerRank assessment " }), snap()).rows.suggested[0].title, "Acme HackerRank assessment");
});

test("suggested: a title of 80 characters passes, 81 is refused", async () => {
  const { checkProposal } = await proposal();
  // "Acme online assessment " is 23 characters.
  assert.equal(checkProposal(with1({ title: `Acme online assessment ${"x".repeat(57)}` }), snap()).ok, true);
  refused(checkProposal(with1({ title: `Acme online assessment ${"x".repeat(58)}` }), snap()), /suggested\[0\]/);
});

test("suggested: a title that holds a link, or a line break, is refused", async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(with1({ title: "Assessment at hackerrank.com/test/abc" }), snap()), /suggested\[0\]/);
  refused(checkProposal(with1({ title: "https://hr.example/x" }), snap()), /suggested\[0\]/);
  refused(checkProposal(with1({ title: "Acme\nassessment" }), snap()), /suggested\[0\]/);
});

test("suggested: due is required and must be a date", async () => {
  const { checkProposal } = await proposal();
  const { due, ...none } = hr();
  refused(checkProposal(good({ suggested: [none] }), snap()), /suggested\[0\]/);
  refused(checkProposal(with1({ due: null }), snap()), /suggested\[0\]/);
  refused(checkProposal(with1({ due: "Nov 7" }), snap()), /suggested\[0\]/);
  refused(checkProposal(with1({ due: "2026-02-30" }), snap()), /suggested\[0\]/);
});

test("suggested: kind is assessment or interview", async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(with1({ kind: "deadline" }), snap()), /suggested\[0\]/);
  refused(checkProposal(with1({ kind: undefined }), snap()), /suggested\[0\]/);
});

test("suggested: the message must be one of this submit's Needs you items", async () => {
  const { checkProposal } = await proposal();
  refused(checkProposal(with1({ message_id: M(2) }), snap()), /suggested\[0\]/);
  // An item already open from an earlier run isn't enough.
  const open = snap({ needs_you_open: [{ account: SBU, message_id: M(2) }] });
  refused(checkProposal(with1({ message_id: M(2) }), open), /suggested\[0\]/);
  // The same message id in the other account isn't it either.
  refused(checkProposal(with1({ account: PERSONAL }), snap()), /suggested\[0\]/);
});

test("suggested: at most one suggestion per item", async () => {
  const { checkProposal } = await proposal();
  const r = checkProposal(good({ suggested: [hr(), hr({ title: "Acme assessment again" })] }), snap());
  refused(r, /suggested\[1\]/);
  assert.equal(r.errors.some((e) => /suggested\[0\]/.test(e)), false, JSON.stringify(r.errors));
});

test("suggested: at most 5", async () => {
  const { checkProposal } = await proposal();
  const ids = [1, 2, 3, 4, 5, 6].map(M);
  const items = ids.map((id) => need(id));
  const tasks = ids.map((id, i) => hr({ message_id: id, title: `Assessment ${i + 1}` }));
  assert.equal(checkProposal(good({ needs_you: items, suggested: tasks.slice(0, 5) }), snap()).ok, true);
  refused(checkProposal(good({ needs_you: items, suggested: tasks }), snap()), /suggested/);
});

test("suggested: absent, the list is empty", async () => {
  const { checkProposal } = await proposal();
  const { suggested, ...none } = good();
  assert.deepEqual(checkProposal(none, snap()).rows.suggested, []);
});

// =============================================================================================
// proposalLines: "Task to add"
// =============================================================================================

const lineTasks = [{ id: T1, title: "OS homework" }, { id: T5, title: "Lab 4" }];
const pendingRow = (extra = {}) => ({ day: DAY, rev: 1, status: "pending", created_at: "2026-11-04T11:09:00Z", note: null, picks: [], couldnt_fit: [], suggested: [], ...extra });
const oneBlock = [{ id: "p1", task_id: T1, starts_at: "2026-11-04T14:30:00Z", ends_at: "2026-11-04T15:15:00Z", proposed: true }];

test("proposalLines: one \"Task to add\" line per suggestion, after \"Couldn't fit\"", todo, async () => {
  const { proposalLines } = await proposal();
  const p = pendingRow({
    note: "Gym got squeezed.",
    couldnt_fit: [T5],
    suggested: [
      { account: SBU, message_id: M1, title: "HackerRank assessment", due: "2026-11-07", kind: "assessment" },
      { account: PERSONAL, message_id: M(2), title: "Karat interview", due: "2026-11-12", kind: "interview" },
    ],
  });
  const open = [{ account: SBU, message_id: M1, done: false }];
  assert.deepEqual(proposalLines(p, oneBlock, lineTasks, open, [], [], TZ), [
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
    "Didn't fit: Gym got squeezed.",
    "Couldn't fit: Lab 4.",
    "Task to add: HackerRank assessment (due Nov 7)",
    "Task to add: Karat interview (due Nov 12)",
    "Mail: 1 needs you.",
  ]);
});

test("proposalLines: no suggestions, no \"Task to add\" line", todo, async () => {
  const { proposalLines } = await proposal();
  assert.deepEqual(proposalLines(pendingRow(), oneBlock, lineTasks, [], [], [], TZ), [
    "Morning plan: 1 block, 9:30–10:15 am.",
    "9:30 am · OS homework (45 min)",
  ]);
});
