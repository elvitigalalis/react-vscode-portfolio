// Messages to Claude (src/sheet/messages.mjs, docs/sheet-messages.md): when the message function
// fires the morning task, what answer_messages accepts and how it turns local times into
// instants, and what read_planner adds for them. Expected values are worked out by hand.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFire, startedPatch, batchedPatch, messageText, checkAnswers, withMessages, proposalTrigger, addedLine, messageState, itemLines, checkStep, stepTargets, progress } from "../src/sheet/messages.mjs";
import { fireText } from "../src/sheet/routine-fire.mjs";

const NOW = new Date("2026-11-04T15:00:00Z"); // 10:00 am EST
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const M1 = "0b6f3c1e-0000-4000-8000-000000000001";
const M2 = "0b6f3c1e-0000-4000-8000-000000000002";

// ---------------------------------------------------------------- shouldFire

test("shouldFire: fires when no other pending message was fired in the last 3 minutes", () => {
  assert.equal(shouldFire([], NOW), true);
  assert.equal(shouldFire([{ id: M1, fired_at: null }], NOW), true);
  assert.equal(shouldFire([{ id: M1, fired_at: ago(3) }], NOW), true);
  assert.equal(shouldFire([{ id: M1, fired_at: ago(10) }, { id: M2, fired_at: null }], NOW), true);
});

test("shouldFire: holds off while a message fired under 3 minutes ago is still pending, since that run reads this one too", () => {
  assert.equal(shouldFire([{ id: M1, fired_at: ago(2) }], NOW), false);
  assert.equal(shouldFire([{ id: M2, fired_at: null }, { id: M1, fired_at: ago(0.5) }], NOW), false);
});

test("startedPatch: a fired message keeps the run's claude.ai link and its first step", () => {
  assert.deepEqual(startedPatch({ session_url: "https://claude.ai/code/session_01abc" }, NOW), {
    fired_at: NOW.toISOString(),
    session_url: "https://claude.ai/code/session_01abc",
    steps: [{ at: NOW.toISOString(), kind: "started", text: "Started Claude" }],
  });
  // Only a claude.ai link is kept.
  assert.equal(startedPatch({ session_url: "https://evil.example/x" }, NOW).session_url, null);
});

test("batchedPatch: a message riding on another's run gets that run's link, or nothing to write", () => {
  const link = "https://claude.ai/code/session_01abc";
  assert.deepEqual(batchedPatch([{ id: M1, fired_at: ago(1), session_url: link }], NOW), { session_url: link });
  assert.equal(batchedPatch([{ id: M1, fired_at: ago(1), session_url: null }], NOW), null);
  assert.equal(batchedPatch([{ id: M1, fired_at: ago(5), session_url: link }], NOW), null);
});

test("messageText: 1 to 8000 characters, line breaks kept (a pasted announcement), spaces collapsed; anything else is refused", () => {
  assert.equal(messageText("  dentist   Thu\t3pm "), "dentist Thu 3pm");
  assert.equal(messageText("Project 2 due Nov 14  \r\n\r\n\r\n\n  quiz on ch. 5 Tue\u0007\n"), "Project 2 due Nov 14\n\nquiz on ch. 5 Tue");
  assert.equal(messageText("x".repeat(8000)), "x".repeat(8000));
  assert.equal(messageText("x".repeat(8001)), null);
  assert.equal(messageText(" \n\n "), null);
  assert.equal(messageText(42), null);
  assert.equal(messageText(undefined), null);
});

test("fireText: a message fire says only its trigger", () => {
  assert.equal(fireText("message", {}), "trigger: message\nreasons: none");
});

// ---------------------------------------------------------------- checkAnswers

const TZ = "America/New_York";
const PENDING = [{ id: M1 }, { id: M2 }];
const answer = (over = {}) => ({ id: M1, tasks: [], events: [], reply: "Added it.", ...over });

test("checkAnswers: a task with no day goes to the Inbox list; one with a day goes on that day", () => {
  const out = checkAnswers({ answers: [answer({
    tasks: [
      { title: "Lab report", day: null, due: "2026-11-06", at_time: null, est_min: 120 },
      { title: "Gym", day: "2026-11-05", due: null, at_time: "07:00", est_min: 60 },
    ],
    reply: "Lab report is in your Inbox, due Fri; gym is on Thu at 7:00 am.",
  })] }, PENDING, TZ);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.answers, [{
    id: M1,
    tasks: [
      { title: "Lab report", day: null, list: "Inbox", due: "2026-11-06", at_time: null, est_min: 120 },
      { title: "Gym", day: "2026-11-05", list: null, due: null, at_time: "07:00", est_min: 60 },
    ],
    events: [],
    reply: "Lab report is in your Inbox, due Fri; gym is on Thu at 7:00 am.",
  }]);
});

test("checkAnswers: an event's local start becomes an instant in the time zone, and runs its minutes", () => {
  const out = checkAnswers({ answers: [answer({ events: [{ title: "Dentist", start: "2026-11-05T15:00", minutes: 60 }] })] }, PENDING, TZ);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.answers[0].events, [{ title: "Dentist", starts_at: "2026-11-05T20:00:00.000Z", ends_at: "2026-11-05T21:00:00.000Z" }]);
});

test("checkAnswers: daylight saving time: EDT before Nov 1, EST after, and a run across the change keeps its length", () => {
  const events = [
    { title: "Lab", start: "2026-10-30T09:00", minutes: 90 },          // EDT, UTC-4
    { title: "Party", start: "2026-10-31T23:30", minutes: 180 },       // across 2 am on Nov 1
    { title: "Lab", start: "2027-03-15T09:00", minutes: 90 },          // EDT again
  ];
  const out = checkAnswers({ answers: [answer({ events })] }, PENDING, TZ);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.answers[0].events, [
    { title: "Lab", starts_at: "2026-10-30T13:00:00.000Z", ends_at: "2026-10-30T14:30:00.000Z" },
    { title: "Party", starts_at: "2026-11-01T03:30:00.000Z", ends_at: "2026-11-01T06:30:00.000Z" },
    { title: "Lab", starts_at: "2027-03-15T13:00:00.000Z", ends_at: "2027-03-15T14:30:00.000Z" },
  ]);
});

test("checkAnswers: a start the clocks skip (2:30 am on Mar 14, 2027) is refused", () => {
  const out = checkAnswers({ answers: [answer({ events: [{ title: "Late", start: "2027-03-14T02:30", minutes: 60 }] })] }, PENDING, TZ);
  assert.deepEqual(out.errors, ["answers[0].events[0].start: 02:30 doesn't happen on 2027-03-14 in America/New_York (the clocks skip it)"]);
  assert.deepEqual(out.answers, []);
});

test("checkAnswers: an id that isn't a pending message fails that answer only", () => {
  const gone = "0b6f3c1e-0000-4000-8000-000000000009";
  const out = checkAnswers({ answers: [answer({ id: gone }), answer({ id: M2, reply: "Done." }), answer({ id: M2 })] }, PENDING, TZ);
  assert.deepEqual(out.errors, [
    "answers[0].id: not a pending message (already answered, or not one read_planner gave)",
    "answers[2].id: that message is already answered above",
  ]);
  assert.deepEqual(out.answers, [{ id: M2, tasks: [], events: [], reply: "Done." }]);
});

test("checkAnswers: titles over 120 characters, replies over 500, links and line breaks are refused", () => {
  const out = checkAnswers({ answers: [answer({
    tasks: [{ title: "x".repeat(121), day: null, due: null, at_time: null, est_min: null }],
    events: [{ title: "Call\nnow", start: "2026-11-05T15:00", minutes: 30 }],
    reply: "See www.example.com",
  }), answer({ id: M2, reply: "y".repeat(501) })] }, PENDING, TZ);
  assert.deepEqual(out.errors, [
    "answers[0].tasks[0].title: at most 120 characters, got 121",
    "answers[0].events[0].title: must be one line, with no line breaks or control characters",
    "answers[0].reply: must not hold a link or web address",
    "answers[1].reply: at most 500 characters, got 501",
  ]);
  assert.deepEqual(out.answers, []);
});

test("checkAnswers: bad dates, times and lengths each name their field", () => {
  const out = checkAnswers({ answers: [answer({
    tasks: [
      { title: "A", day: "2026-02-30", due: "Friday", at_time: "7am", est_min: 10 },
      { title: "B", day: null, due: null, at_time: "07:00", est_min: 481 },
    ],
    events: [
      { title: "C", start: "2026-11-05 15:00", minutes: 60 },
      { title: "D", start: "2026-11-05T24:00", minutes: 721 },
      { title: "E", start: "2026-11-05T15:00", minutes: 14 },
    ],
  })] }, PENDING, TZ);
  assert.deepEqual(out.errors, [
    'answers[0].tasks[0].day: must be a date "YYYY-MM-DD" or null',
    'answers[0].tasks[0].due: must be a date "YYYY-MM-DD" or null',
    'answers[0].tasks[0].at_time: must be "HH:MM", 24-hour, or null',
    "answers[0].tasks[0].est_min: must be 15 to 480 minutes, or null",
    "answers[0].tasks[1].at_time: a fixed time needs a day",
    "answers[0].tasks[1].est_min: must be 15 to 480 minutes, or null",
    'answers[0].events[0].start: must be local "YYYY-MM-DDTHH:MM", 24-hour',
    'answers[0].events[1].start: must be local "YYYY-MM-DDTHH:MM", 24-hour',
    "answers[0].events[1].minutes: must be 15 to 720",
    "answers[0].events[2].minutes: must be 15 to 720",
  ]);
});

test("checkAnswers: past dates are fine (he may log what already happened); missing fields read as null", () => {
  const out = checkAnswers({ answers: [answer({
    tasks: [{ title: "Expense report", day: "2026-10-01", due: "2026-10-02" }, { title: "Read ch. 4" }],
    events: [{ title: "Advisor meeting", start: "2026-10-01T10:00", minutes: 30 }],
  })] }, PENDING, TZ);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.answers[0].tasks, [
    { title: "Expense report", day: "2026-10-01", list: null, due: "2026-10-02", at_time: null, est_min: null },
    { title: "Read ch. 4", day: null, list: "Inbox", due: null, at_time: null, est_min: null },
  ]);
  assert.equal(out.answers[0].events[0].starts_at, "2026-10-01T14:00:00.000Z");
});

test("checkAnswers: at most 10 answers, 20 tasks and 10 events an answer (a long pasted message), and a reply is required", () => {
  const many = (n, f) => Array.from({ length: n }, f);
  assert.deepEqual(checkAnswers({ answers: many(11, () => answer()) }, PENDING, TZ).errors, ["answers: at most 10, got 11"]);
  const full = checkAnswers({ answers: [answer({
    tasks: many(20, (_, i) => ({ title: `T${i}` })),
    events: many(10, () => ({ title: "E", start: "2026-11-05T15:00", minutes: 30 })),
  })] }, PENDING, TZ);
  assert.deepEqual(full.errors, []);
  assert.equal(full.answers[0].tasks.length, 20);
  const out = checkAnswers({ answers: [answer({
    tasks: many(21, () => ({ title: "T" })),
    events: many(11, () => ({ title: "E", start: "2026-11-05T15:00", minutes: 30 })),
    reply: undefined,
  })] }, PENDING, TZ);
  assert.deepEqual(out.errors, ["answers[0].tasks: at most 20, got 21", "answers[0].events: at most 10, got 11", "answers[0].reply: must be text"]);
});

test("checkAnswers: a reply may run to 500 characters, so it can list what was skipped and why", () => {
  assert.deepEqual(checkAnswers({ answers: [answer({ reply: "y".repeat(500) })] }, PENDING, TZ).errors, []);
  assert.deepEqual(checkAnswers({ answers: [answer({ reply: "y".repeat(501) })] }, PENDING, TZ).errors, ["answers[0].reply: at most 500 characters, got 501"]);
});

test("checkAnswers: each task and event may carry a short why for /plan's How Claude decided; a long or linked one fails", () => {
  const out = checkAnswers({ answers: [answer({
    tasks: [{ title: "Lab report", due: "2026-11-06", why: "A deadline with no time, so a task due Fri." }],
    events: [{ title: "Dentist", start: "2026-11-05T15:00", minutes: 60, why: "60 min: you gave no length." }],
  })] }, PENDING, TZ);
  assert.deepEqual(out.errors, []);
  assert.equal(out.answers[0].tasks[0].why, "A deadline with no time, so a task due Fri.");
  assert.equal(out.answers[0].events[0].why, "60 min: you gave no length.");
  const bad = checkAnswers({ answers: [answer({
    tasks: [{ title: "A", why: "w".repeat(141) }],
    events: [{ title: "B", start: "2026-11-05T15:00", minutes: 60, why: "see cse416.org" }],
  })] }, PENDING, TZ);
  assert.deepEqual(bad.errors, [
    "answers[0].tasks[0].why: at most 140 characters, got 141",
    "answers[0].events[0].why: must not hold a link or web address",
  ]);
});

// ---------------------------------------------------------------- report_step

test("checkStep: a step is one plain line of at most 120 characters, of a known kind", () => {
  assert.deepEqual(checkStep({ kind: "checking", text: "Checking  Thursday on your calendar" }), { step: { kind: "checking", text: "Checking Thursday on your calendar" } });
  assert.deepEqual(checkStep({ kind: "searching", text: "Searching the web for the CSE 416 page" }).step.kind, "searching");
  assert.deepEqual(checkStep({ kind: "thinking", text: "Hmm" }), { error: "kind: must be reading, checking, searching, adding or done" });
  assert.deepEqual(checkStep({ kind: "adding", text: "x".repeat(121) }), { error: "text: at most 120 characters, got 121" });
  assert.deepEqual(checkStep({ kind: "adding", text: "Open https://evil.example" }), { error: "text: must not hold a link or web address" });
});

test("stepTargets: the named pending messages, or every pending one when none are named", () => {
  const pending = [{ id: M1 }, { id: M2 }];
  assert.deepEqual(stepTargets(pending, undefined), [M1, M2]);
  assert.deepEqual(stepTargets(pending, [M2, "0b6f3c1e-0000-4000-8000-000000000009"]), [M2]);
  assert.deepEqual(stepTargets([], undefined), []);
});

// ---------------------------------------------------------------- progress (/plan)

const at = (s) => new Date(NOW.getTime() - s * 1000).toISOString();
const step = (s, text, kind = "checking") => ({ at: at(s), kind, text });

test("progress: while Claude works, the time since the fire and the last 5 steps, the newest one current", () => {
  const steps = [step(40, "Started Claude", "started"), step(38, "Read your planner", "reading"), step(30, "Checking Thursday on your calendar"),
    step(20, "Searching the web for the CSE 416 page", "searching"), step(10, "Adding Project 2, due Nov 14", "adding"), step(5, "Adding the quiz", "adding")];
  assert.deepEqual(progress({ status: "pending", fired_at: at(34), steps }, NOW), {
    running: true, elapsed: "0:34", note: null,
    steps: [
      { text: "Read your planner", done: true },
      { text: "Checking Thursday on your calendar", done: true },
      { text: "Searching the web for the CSE 416 page", done: true },
      { text: "Adding Project 2, due Nov 14", done: true },
      { text: "Adding the quiz", done: false },
    ],
  });
});

test("progress: notes for a run that hasn't started, has gone quiet, or a message riding on another's run", () => {
  assert.equal(progress({ status: "pending", fired_at: at(50), steps: [step(50, "Started Claude", "started")] }, NOW).note,
    "Claude hasn't started yet. Cloud runs can take a minute to start.");
  assert.equal(progress({ status: "pending", fired_at: at(30), steps: [step(30, "Started Claude", "started")] }, NOW).note, null);
  assert.equal(progress({ status: "pending", fired_at: at(200), steps: [step(200, "Started Claude", "started"), step(95, "Checking Thursday on your calendar")] }, NOW).note,
    "Still working on \u201cChecking Thursday on your calendar\u201d…");
  const batched = progress({ status: "pending", fired_at: null, steps: [] }, NOW);
  assert.equal(batched.note, "Waiting for the run that's already going…");
  assert.equal(batched.elapsed, null);
});

test("progress: once answered, the steps fold into a count and how long the run took", () => {
  const steps = [step(80, "Started Claude", "started"), step(70, "Read your planner", "reading"), step(40, "Checking Thursday on your calendar"), step(30, "Saving", "adding")];
  assert.deepEqual(progress({ status: "done", fired_at: at(82), answered_at: at(30), steps }, NOW), {
    running: false, summary: "4 steps · 52 s",
    steps: steps.map((x) => ({ text: x.text, done: true })),
  });
  assert.equal(progress({ status: "failed", fired_at: at(200), answered_at: at(65), steps: steps.slice(0, 1) }, NOW).summary, "1 step · 2 min 15 s");
  // A message answered before steps were kept has nothing to fold.
  assert.equal(progress({ status: "done", fired_at: null, steps: [] }, NOW), null);
});

// ---------------------------------------------------------------- withMessages

const snap = (trigger = "morning") => ({ version: 5, now: NOW.toISOString(), time_zone: TZ, plan_day: "2026-11-04", run: { trigger, reasons: [], changes: {} } });
const row = (n, at, fired_at = null) => ({ id: `0b6f3c1e-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, at, text: `message ${n}`, fired_at });

test("withMessages: read_planner gains the pending messages, oldest first and at most 10, with today and replans_on", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(12 - i, ago(100 + i)));
  const out = withMessages(snap(), rows, { replans_on: true }, NOW);
  assert.equal(out.today, "2026-11-04");
  assert.equal(out.replans_on, true);
  assert.equal(out.messages.length, 10);
  assert.deepEqual(out.messages[0], { id: row(1).id, at: ago(111), text: "message 1" });
  assert.deepEqual(out.messages.map((m) => m.text).slice(-1), ["message 10"]);
  assert.equal(out.run.trigger, "morning");
  assert.equal(out.plan_day, "2026-11-04");
});

test("withMessages: past 20,000 characters in all, the oldest messages wait for the next run, and messages_held says how many", () => {
  const long = (n, at, len) => ({ ...row(n, at), text: "x".repeat(len) });
  const rows = [long(1, ago(30), 8000), long(2, ago(20), 8000), long(3, ago(10), 8000), long(4, ago(5), 5000)];
  const out = withMessages(snap(), rows, {}, NOW);
  assert.deepEqual(out.messages.map((m) => m.id), [row(3).id, row(4).id]);
  assert.equal(out.messages_held, 2);
  // Under the budget nothing is held.
  assert.equal(withMessages(snap(), [row(1, ago(5))], {}, NOW).messages_held, 0);
  // One message is always read, however long.
  assert.equal(withMessages(snap(), [long(1, ago(5), 8000)], {}, NOW).messages.length, 1);
});

test("withMessages: a message fired under 10 minutes ago and still pending makes the run a message run", () => {
  assert.equal(withMessages(snap(), [row(1, ago(4), ago(4))], {}, NOW).run.trigger, "message");
  assert.equal(withMessages(snap(), [row(1, ago(40), ago(40))], {}, NOW).run.trigger, "morning");
  // A replan the server started stays a replan; it answers the messages as well.
  assert.equal(withMessages(snap("replan"), [row(1, ago(4), ago(4))], {}, NOW).run.trigger, "replan");
  assert.equal(withMessages(snap(), [], { replans_on: false }, NOW).replans_on, false);
});

test("proposalTrigger: a revision a message run submits is recorded as a replan", () => {
  assert.equal(proposalTrigger("message"), "replan");
  assert.equal(proposalTrigger("morning"), "morning");
  assert.equal(proposalTrigger("replan"), "replan");
});

// ---------------------------------------------------------------- addedLine (/plan)

test("addedLine: what an answered message added, as /plan shows it under the reply", () => {
  const ev = { title: "Dentist", starts_at: "2026-11-05T20:00:00.000Z", ends_at: "2026-11-05T21:00:00.000Z" };
  assert.equal(addedLine({ status: "done", tasks_added: 2, events: [ev] }), "Added: 2 tasks, 1 event");
  assert.equal(addedLine({ status: "done", tasks_added: 1, events: [] }), "Added: 1 task");
  assert.equal(addedLine({ status: "done", tasks_added: 0, events: [ev, ev] }), "Added: 2 events");
  assert.equal(addedLine({ status: "failed", tasks_added: 0, events: [] }), "Nothing added");
  assert.equal(addedLine({ status: "pending", tasks_added: 0, events: [] }), "");
});

test("addedLine: an answered message whose items were all undone says so", () => {
  assert.equal(addedLine({ status: "done", tasks_added: 0, events: [] }), "All undone");
});

// ---------------------------------------------------------------- messageState (/plan)

test("messageState: Claude is reading while a fired message is fresh; queued once the run was missed or rate limited", () => {
  const m = (over) => ({ id: M1, status: "pending", fired_at: null, ...over });
  assert.deepEqual(messageState(m({ fired_at: ago(2) }), [], NOW), { key: "reading", words: "Claude is reading…" });
  // Batched: another pending message's run, fired a minute ago, reads this one too.
  assert.equal(messageState(m(), [m(), { id: M2, status: "pending", fired_at: ago(1) }], NOW).key, "reading");
  const queued = { key: "queued", words: "Queued: Claude is busy, so this runs with the next plan." };
  assert.deepEqual(messageState(m(), [m()], NOW), queued);
  assert.deepEqual(messageState(m({ fired_at: ago(11) }), [], NOW), queued);
  // An answered message's fire no longer counts.
  assert.equal(messageState(m(), [{ id: M2, status: "done", fired_at: ago(1) }], NOW).key, "queued");
});

test("messageState: an answered message says what it added; one that added nothing couldn't be parsed", () => {
  assert.deepEqual(messageState({ status: "done", tasks_added: 2, events: [] }, [], NOW), { key: "added", words: "Added: 2 tasks" });
  assert.deepEqual(messageState({ status: "failed", tasks_added: 0, events: [] }, [], NOW), { key: "unparsed", words: "Couldn't parse it: nothing added" });
});

// ---------------------------------------------------------------- itemLines (/plan)

test("itemLines: each to-do with its day or Inbox and due date, each event with its day and times, to-dos first", () => {
  const m = {
    tasks: [
      { id: "t1", title: "Project 2 (due 11:59 pm)", day: null, list: "Inbox", due: "2026-11-14", at_time: null, why: "A deadline at 11:59 pm: a task due that day." },
      { id: "t2", title: "Read ch. 5", day: "2026-11-09", list: null, due: "2026-11-10", at_time: "09:30" },
      { id: "t3", title: "Email TA", day: "2026-11-05", list: null, due: null, at_time: null },
    ],
    events: [
      { id: "e1", title: "Quiz ch. 5", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T15:15:00.000Z" },
      { id: "e2", title: "Review session", starts_at: "2026-11-12T23:30:00.000Z", ends_at: "2026-11-13T01:00:00.000Z" },
    ],
  };
  assert.deepEqual(itemLines(m, TZ), [
    { id: "t1", kind: "task", title: "Project 2 (due 11:59 pm)", when: "Inbox · due Sat Nov 14", why: "A deadline at 11:59 pm: a task due that day." },
    { id: "t2", kind: "task", title: "Read ch. 5", when: "Mon Nov 9, 9:30 am · due Tue Nov 10", why: null },
    { id: "t3", kind: "task", title: "Email TA", when: "Thu Nov 5", why: null },
    { id: "e1", kind: "event", title: "Quiz ch. 5", when: "Tue Nov 10, 9–10:15 am", why: null },
    { id: "e2", kind: "event", title: "Review session", when: "Thu Nov 12, 6:30–8 pm", why: null },
  ]);
  // A message answered before items were listed has none; an event without an id can't be undone.
  assert.deepEqual(itemLines({ tasks_added: 2, events: [] }, TZ), []);
  assert.equal(itemLines({ events: [{ title: "Old", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T15:00:00.000Z" }] }, TZ)[0].id, null);
});

// ---------------------------------------------------------------- messageEventBody (/plan)

test("messageEventBody: a message's event keeps its title, private to the owner, with Google's default alerts", async () => {
  const { messageEventBody } = await import("../src/sheet/api.mjs");
  assert.deepEqual(messageEventBody("Dentist", "2026-11-05T20:00:00.000Z", "2026-11-05T21:00:00.000Z"), {
    summary: "Dentist",
    visibility: "private",
    start: { dateTime: "2026-11-05T20:00:00.000Z" },
    end: { dateTime: "2026-11-05T21:00:00.000Z" },
    reminders: { useDefault: true },
  });
});
