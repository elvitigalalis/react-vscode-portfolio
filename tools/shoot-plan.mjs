// Usage: npm run build, then npx astro preview --port 4321, then node tools/shoot-plan.mjs <outdir>
// (BASE=http://localhost:<port> for another port). Screenshots /plan and /now with Supabase and
// Google stubbed, and checks the layout (docs/sheet-glance.md, "Quality bar"); exits 1 on a failure.
import puppeteer from "puppeteer";
import { createRequire } from "node:module";
const OUT = process.argv[2];
const BASE = process.env.BASE ?? "http://localhost:4321";
// Week of Mon 2026-11-02; today Tue 11-03.
const T = (id, title, day, extra = {}) => ({ id, title, day, list: day ? null : "Inbox", position: id, est_min: null, at_time: null, tag: null, public: true, done: false, rolls: 0, due: null, source: null, created_at: "2026-11-01T00:00:00Z", ...extra });
const tasks = [
  T(1, "OS homework 4", "2026-11-03", { est_min: 90, due: "2026-11-04", public: false, source: "brightspace" }),
  T(2, "Gym", "2026-11-03", { est_min: 60, at_time: "17:30:00" }),
  T(3, "WorkIt: batch apply PR review", "2026-11-03", { est_min: 45, tag: "workit" }),
  T(4, "Email advisor re: spring schedule", "2026-11-03", { est_min: 15, rolls: 2 }),
  T(5, "Laundry", "2026-11-02", { done: true }),
  T(6, "Micromouse: tune PID", "2026-11-02", { done: true, tag: "micromouse", est_min: 60 }),
  T(7, "Read ch. 7 for CSE 320", "2026-11-04", { est_min: 60 }),
  T(8, "Robotics club GBM", "2026-11-04", { at_time: "19:00:00", tag: "campus", est_min: 60, public: false }),
  T(9, "Quiz 6", "2026-11-05", { due: "2026-11-05", public: false, source: "brightspace" }),
  T(10, "Call mom", "2026-11-06", { public: false }),
  T(11, "Draft cover letter", null, { list: "Inbox" }),
  T(12, "Project 3 - Due", null, { list: "Brightspace", due: "2026-11-09", public: false, source: "brightspace" }),
  T(13, "Lab 5", null, { list: "Brightspace", due: "2026-11-12", public: false, source: "brightspace" }),
];
const blocks = [
  { id: 1, task_id: 3, starts_at: "2026-11-03T15:00:00Z", ends_at: "2026-11-03T15:45:00Z", gcal_id: "g1", proposed: false },
  { id: 2, task_id: 1, starts_at: "2026-11-03T19:00:00Z", ends_at: "2026-11-03T20:30:00Z", gcal_id: null, proposed: true },
  { id: 3, task_id: 4, starts_at: "2026-11-03T16:00:00Z", ends_at: "2026-11-03T16:15:00Z", gcal_id: null, proposed: true },
  // Approved from Telegram, so no Google event yet: /plan makes one on opening.
  { id: 4, task_id: 2, starts_at: "2026-11-03T22:30:00Z", ends_at: "2026-11-03T23:30:00Z", gcal_id: null, proposed: false },
];
const days = [{ day: "2026-11-02", planned: true, shutdown: true }, { day: "2026-11-03", planned: false, shutdown: false }];
// Messages to Claude (docs/sheet-messages.md): a pasted announcement answered, one being read.
const messages = [
  { id: "m2", at: "2026-11-03T15:19:20Z", text: "gym tomorrow 7am", status: "pending", fired_at: "2026-11-03T15:19:26Z", tasks: [], events: [], tasks_added: 0, created_in_calendar: false, reply: null,
    session_url: "https://claude.ai/code/session_x",
    steps: [{ at: "2026-11-03T15:19:26Z", kind: "started", text: "Started Claude" }, { at: "2026-11-03T15:19:40Z", kind: "reading", text: "Read your planner" }, { at: "2026-11-03T15:19:50Z", kind: "checking", text: "Checking Wednesday on your calendar" }] },
  { id: "m1", at: "2026-11-03T14:00:00Z", status: "done", fired_at: "2026-11-03T14:00:00Z", created_in_calendar: true, tasks_added: 2,
    text: "CSE 320 reminders:\nProject 2 is due Nov 14 11:59pm.\nQuiz on ch. 5 next Tuesday in class.\nLab 4 report due the Friday after.\nOffice hours moved, see the site.",
    reply: "Added Project 2 and Lab 4 to your Inbox and the quiz on Tue Nov 10. Skipped office hours: no day or time given.",
    session_url: "https://claude.ai/code/session_y", answered_at: "2026-11-03T14:00:52Z",
    steps: [{ at: "2026-11-03T14:00:00Z", kind: "started", text: "Started Claude" }, { at: "2026-11-03T14:00:12Z", kind: "reading", text: "Read your planner" }, { at: "2026-11-03T14:00:40Z", kind: "adding", text: "Adding Project 2, due Nov 14" }, { at: "2026-11-03T14:00:50Z", kind: "saving", text: "Saving" }],
    tasks: [
      { id: "t1", title: "CSE 320 Project 2 (due 11:59 pm)", day: null, list: "Inbox", due: "2026-11-14", at_time: null, why: "A deadline at 11:59 pm, so a task due that day." },
      { id: "t2", title: "CSE 320 Lab 4 report", day: null, list: "Inbox", due: "2026-11-13", at_time: null },
    ],
    events: [{ id: "e1", title: "CSE 320 quiz, ch. 5", starts_at: "2026-11-10T14:00:00.000Z", ends_at: "2026-11-10T15:20:00.000Z", gcal_id: "gq", why: "An in-class quiz: an event at the class's time from your calendar." }] },
];
const settings = [{ id: true, owner_email: "x@y", nudges_on: true, calendars: [], gcal_calendar_id: "c", interests: "robotics, free food" }];
const campus = [
  { uid: "c1", title: "Pizza & Pitch Night", starts_at: "2026-11-03T22:00:00Z", ends_at: "2026-11-04T00:00:00Z", all_day: false, group_name: "Entrepreneurship Club", event_type: "Social", tags: ["Free Food", "Career"], url: "https://sbengaged.stonybrook.edu/x", rsvp_count: 22 },
  { uid: "c2", title: "Google Info Session", starts_at: "2026-11-03T21:00:00Z", ends_at: "2026-11-03T22:00:00Z", all_day: false, group_name: "Career Center", event_type: "Info Session", tags: ["Career"], url: null },
  { uid: "c3", title: "IEEE Workshop: Soldering", starts_at: "2026-11-04T22:00:00Z", ends_at: "2026-11-04T23:30:00Z", all_day: false, group_name: "IEEE", event_type: "Workshop", tags: ["Free Food", "Engineering"], url: null },
];
const feeds = [{ source: "brightspace", fetched_at: "2026-11-03T13:20:00Z", ok: true, error: null, items: 12 }, { source: "campus", fetched_at: "2026-11-03T13:35:00Z", ok: false, error: "304 parse", items: 0 }];
// The morning plan (docs/sheet-morning.md): today's proposal and the mail that needs Lisul. One
// row's link isn't Gmail's, so it must show no link.
const SBU = "lisul.elvitigala@stonybrook.edu";
const gmail = (id) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(SBU)}#all/${id}`;
const proposals = [{ day: "2026-11-03", status: "pending", note: "Lab 5 (2h) didn't fit before shutdown.", picks: [{ uid: "c1", why: "Career and free food" }] }];
const N = (id, kind, sender, subject, why, extra = {}) => ({ id: `n${id}`, day: "2026-11-03", account: SBU, message_id: `19a4f2c3b5d6e7f${id}`, link: gmail(`19a4f2c3b5d6e7f${id}`), sender, subject, why, kind, due: null, done: false, created_at: "2026-11-03T11:07:00Z", ...extra });
const needs = [
  N(1, "reply", "Ana Ruiz", "Micromouse demo moved to Friday", "She asked if 3 pm works for you; reply by Thursday.", { due: "2026-11-05" }),
  N(2, "deadline", "CSE 320 Staff", "Project 3 extension request form", "Form closes before Project 3 is due.", { due: "2026-11-07" }),
  N(3, "meeting", "Prof. Stark", "Office hours: research position follow-up", "Wants 20 minutes this week to talk about the spring position."),
  N(4, "admin", "Registrar", "Spring 2027 enrollment appointment", "Your enrollment window opens Monday.", { link: "https://evil.example/phish", account: "elvitigalalis@gmail.com" }),
  N(5, "reply", "Done row", "Already handled", "Hidden.", { done: true }),
];
// What the page wrote, for the checks below.
const writes = { busy: [], events: 0 };
const pubWeek = tasks.filter((t) => t.day).map((t) => ({ day: t.day, position: t.position, public: t.public, title: t.public ? t.title : null, bar: t.title.length, done: t.done, tag: t.tag }));
const gEvents = { items: [
  { iCalUID: "e1", summary: "CSE 320 Lecture", start: { dateTime: "2026-11-03T14:00:00Z" }, end: { dateTime: "2026-11-03T15:20:00Z" } },
  { iCalUID: "e2", summary: "AMS 310 Recitation", start: { dateTime: "2026-11-03T18:00:00Z" }, end: { dateTime: "2026-11-03T18:53:00Z" } },
  { iCalUID: "e3", summary: "CSE 320 Lecture", start: { dateTime: "2026-11-05T14:00:00Z" }, end: { dateTime: "2026-11-05T15:20:00Z" } },
  { iCalUID: "e4", summary: "Election Day", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } },
] };
const json = (r, body) => r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
function route(r) {
  const u = r.url();
  if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  if (u.includes("googleapis.com")) {
    if (r.method() === "POST" && /\/events$/.test(new URL(u).pathname)) { writes.events++; return json(r, { id: `gnew${writes.events}` }); }
    return json(r, gEvents);
  }
  if (!u.includes("supabase.co")) return r.continue();
  const p = new URL(u).pathname.replace("/rest/v1/", "");
  const q = new URL(u).search;
  if (p === "busy" && r.method() === "POST") writes.busy.push(JSON.parse(r.postData()));
  // Approved blocks without an event, with their task (api.eventlessBlocks).
  if (p === "blocks" && q.includes("gcal_id=is.null") && r.method() === "GET") {
    return json(r, blocks.filter((x) => !x.proposed && !x.gcal_id).map((x) => ({ ...x, tasks: { title: tasks.find((t) => t.id === x.task_id).title, public: true } })));
  }
  if (p === "blocks" && q.includes("gcal_id=is.null") && r.method() === "PATCH") return json(r, [{ ...blocks[3], ...JSON.parse(r.postData()) }]);
  if (p === "needs_you" && r.method() === "GET") return json(r, needs.filter((n) => !n.done));
  const map = { messages, tasks: tasks, blocks, days, settings, proposals, campus_events: campus, feed_state: feeds, mail_accounts: [{ id: 1, email: "lisul@stonybrook.edu", label: null, last_error: null }], gcal_pending: [], public_week: pubWeek, public_days: days, public_now: [{ title: "WorkIt: batch apply PR review", tag: "workit", public: true, updated_on: "2026-11-03" }] };
  if (new URL(u).search.includes("parked_on")) return json(r, [{ id: 99 }]);
  return json(r, map[p] ?? []);
}
const b = await puppeteer.launch({ headless: true });
// `touch` emulates a phone: a touch screen, so (pointer: coarse) and (hover: none) match.
async function shot(path, name, w, h, dark, after, at = "2026-11-03T15:20:00Z", touch = false) {
  const pg = await b.newPage();
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  await pg.emulateTimezone("America/New_York");
  await pg.setRequestInterception(true);
  pg.on("request", route);
  pg.on("pageerror", (e) => console.log("pageerror", e.message));
  await pg.evaluateOnNewDocument((at) => {
    const fixed = new Date(at).getTime(); const RD = Date; const off = fixed - RD.now();
    globalThis.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [RD.now() + off])); } static now() { return RD.now() + off; } };
    localStorage.setItem("sheet.session", JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3e6, provider_token: "g", provider_expires_at: Date.now() + 3e6 }));
  }, at);
  await pg.goto(BASE + path, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  if (after) await after(pg);
  await pg.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await pg.close();
}
// --- Checks ------------------------------------------------------------------------------
const failures = [];
// No task title is taller than 3 lines, and every icon is hidden from screen readers.
async function checkRows(pg, name) {
  const r = await pg.evaluate(() => {
    const tall = [...document.querySelectorAll(".sheet-title")].filter((t) => t.getClientRects().length)
      .filter((t) => t.getBoundingClientRect().height > 3 * parseFloat(getComputedStyle(t).lineHeight) + 1)
      .map((t) => `${t.textContent} (${Math.round(t.getBoundingClientRect().height)}px)`);
    const shown = [...document.querySelectorAll("svg.sheet-icon")].filter((s) => s.getAttribute("aria-hidden") !== "true").length;
    return { tall, shown, titles: document.querySelectorAll(".sheet-title").length };
  });
  if (!r.titles) failures.push(`${name}: no task titles drawn`);
  for (const t of r.tall) failures.push(`${name}: title taller than 3 lines: ${t}`);
  if (r.shown) failures.push(`${name}: ${r.shown} svg.sheet-icon without aria-hidden="true"`);
}
// Plan today (docs/sheet-glance.md, change 5): the now line never runs over a block's title, and
// a block under 30 minutes keeps its title on one line. `onTitle` says the now line crosses a
// block title at this time, so the first check can't pass by missing every block.
async function checkTimeline(pg, name, onTitle) {
  const r = await pg.evaluate(() => {
    const line = document.querySelector(".sheet-nowline");
    if (!line) return { noLine: true };
    line.scrollIntoView({ block: "center" });
    // The line ignores the pointer in use; let elementFromPoint see it while it looks.
    line.style.pointerEvents = "auto";
    const lr = line.getBoundingClientRect();
    const covered = [];
    let crossed = 0;
    for (const t of document.querySelectorAll(".sheet-block-title")) {
      const tr = t.getBoundingClientRect();
      const x0 = Math.max(tr.left, lr.left), x1 = Math.min(tr.right, lr.right);
      const y = lr.top + lr.height / 2;
      if (x1 <= x0 || y < tr.top || y > tr.bottom) continue;
      crossed++;
      for (const x of [x0 + 2, (x0 + x1) / 2, x1 - 2]) if (line.contains(document.elementFromPoint(x, y))) { covered.push(t.textContent); break; }
    }
    line.style.pointerEvents = "";
    const tall = [];
    let short = 0;
    for (const b of document.querySelectorAll(".sheet-block")) {
      if (parseFloat(b.style.height) >= 30 * 1.2) continue;
      short++;
      const t = b.querySelector(".sheet-block-title");
      if (t.getBoundingClientRect().height > parseFloat(getComputedStyle(t).lineHeight) + 1) tall.push(t.textContent);
    }
    return { covered, crossed, tall, short };
  });
  if (r.noLine) return failures.push(`${name}: no now line`);
  for (const t of r.covered) failures.push(`${name}: the now line covers the title of "${t}"`);
  if (onTitle && !r.crossed) failures.push(`${name}: the now line should cross a block title here`);
  if (!r.short) failures.push(`${name}: no block under 30 minutes drawn`);
  for (const t of r.tall) failures.push(`${name}: short block title on more than one line: "${t}"`);
}
const planToday = (name, onTitle) => async (pg) => { await pg.keyboard.press("p"); await new Promise((r) => setTimeout(r, 800)); await checkTimeline(pg, name, onTitle); };
for (const w of [1440, 390]) for (const dark of [false, true]) {
  const mode = dark ? "dark" : "light";
  await shot("/plan/", `plan-today-${w}-${mode}`, w, w > 400 ? 900 : 844, dark, planToday(`Plan today ${w}px ${mode}`, false));
}
// 10:05 am: the line runs through "WorkIt: batch apply PR review"'s title row.
await shot("/plan/", "plan-today-on-title", 1440, 900, false, planToday("Plan today at 10:05 am", true), "2026-11-03T15:05:00Z");

// The top bar is one row: every control it shows starts on the same line, inside the page.
async function checkTopBar(pg, name) {
  const r = await pg.evaluate(() => {
    const items = [...document.querySelectorAll(".sheet-tools button")].filter((x) => x.getClientRects().length && !x.closest(".visually-hidden"));
    const rects = items.map((x) => x.getBoundingClientRect());
    const tops = rects.map((x) => x.top);
    return { n: items.length, spread: Math.max(...tops) - Math.min(...tops), right: Math.max(...rects.map((x) => x.right)), width: document.documentElement.clientWidth };
  });
  if (!r.n) failures.push(`${name}: no top bar drawn`);
  if (r.spread > 8) failures.push(`${name}: top bar wraps (${Math.round(r.spread)}px between rows)`);
  if (r.right > r.width) failures.push(`${name}: top bar runs ${Math.round(r.right - r.width)}px off the page`);
}
for (const w of [1440, 1280]) for (const dark of [false, true]) {
  await shot("/plan/", `plan-week-${w}-${dark ? "dark" : "light"}`, w, 900, dark, async (pg) => { await checkRows(pg, `/plan ${w}px ${dark ? "dark" : "light"}`); await checkTopBar(pg, `/plan ${w}px ${dark ? "dark" : "light"}`); });
}
for (const w of [1440, 390]) {
  await shot("/plan/", `plan-messages-${w}`, w, 900, false, async (pg) => {
    const r = await pg.evaluate(() => {
      const d = document.querySelector("[data-message-recent]");
      document.querySelector(".sheet-message-decided")?.setAttribute("open", "");
      return { open: d?.open, items: document.querySelectorAll(".sheet-message-added li").length, steps: document.querySelectorAll(".sheet-message-progress .sheet-message-steps li").length, wide: document.documentElement.scrollWidth > innerWidth };
    });
    if (!r.open || r.items !== 3 || r.steps !== 3) failures.push(`/plan ${w}px: Recent should be open with 3 added items and 3 live steps, got ${JSON.stringify(r)}`);
    if (r.wide) failures.push(`/plan ${w}px: the message list scrolls sideways`);
  });
}
await shot("/plan/", "plan-campus", 1440, 900, false, async (pg) => { await pg.click(".sheet-campus-row"); await new Promise((r) => setTimeout(r, 500)); });
await shot("/plan/", "plan-settings", 1440, 900, false, async (pg) => { await pg.click("[data-feed-alert]"); await new Promise((r) => setTimeout(r, 800)); });
await shot("/plan/", "plan-help", 1440, 900, false, async (pg) => { await pg.click('[popovertarget="sheet-more"]'); await pg.click('[data-more] [data-act="help"]'); await new Promise((r) => setTimeout(r, 500)); });
// The Needs you chip (docs/sheet-morning.md, "/plan") shows on phones too, as the mail icon and
// the count, without breaking the top bar's one row.
async function checkNeedsChip(pg, name) {
  const r = await pg.evaluate(() => {
    const c = document.querySelector("[data-needs-chip]");
    return c && { shown: Boolean(c.getClientRects().length), text: c.innerText.replace(/\s+/g, " ").trim(), label: c.ariaLabel, icon: Boolean(c.querySelector('use[href="#i-mail"]')) };
  });
  if (!r?.shown) return failures.push(`${name}: no Needs you chip`);
  if (!r.icon || !/\b4$/.test(r.text) || r.label !== "Needs you · 4") failures.push(`${name}: Needs you chip reads "${r.text}" (${r.label})`);
}
for (const dark of [false, true]) {
  await shot("/plan/", `plan-phone-${dark ? "dark" : "light"}`, 390, 844, dark, async (pg) => { await checkTopBar(pg, `/plan 390px ${dark ? "dark" : "light"}`); await checkNeedsChip(pg, `/plan 390px ${dark ? "dark" : "light"}`); });
}

// --- The phone layout (research/plan-improvements.md 1-3, 7; plan-phone.md 10) -------------
// Every day and Someday list on screen keeps its "+ Add a task" row.
async function checkAddRows(pg, name) {
  const r = await pg.evaluate(() => [...document.querySelectorAll(".sheet-day.is-focus .sheet-rows, .sheet-list .sheet-rows")]
    .map((ul) => ({ head: ul.parentElement.querySelector(".sheet-head")?.textContent.trim(), add: ul.querySelector(".is-add"), ul }))
    .filter((x) => x.ul.getClientRects().length)
    .map((x) => ({ head: x.head, shown: Boolean(x.add?.getClientRects().length) })));
  if (r.length < 2) failures.push(`${name}: expected the day and Someday lists, got ${r.length}`);
  for (const x of r) if (!x.shown) failures.push(`${name}: no "+ Add a task" row under ${x.head}`);
}
// On a touch screen the top bar's controls and Approve take a 44 px tap area (Apple HIG,
// Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility).
// An ::after that reaches past the box counts toward it.
async function checkTargets(pg, name, sel) {
  const r = await pg.evaluate((sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length).map((x) => {
    const box = x.getBoundingClientRect();
    const a = getComputedStyle(x, "::after");
    const pad = a.content !== "none" && a.position === "absolute" ? [parseFloat(a.width) || 0, parseFloat(a.height) || 0] : [0, 0];
    return { what: x.ariaLabel || x.textContent.trim() || x.className, w: Math.max(box.width, pad[0]), h: Math.max(box.height, pad[1]) };
  }), sel);
  if (!r.length) failures.push(`${name}: nothing matches ${sel}`);
  for (const x of r) if (x.w < 43.5 || x.h < 43.5) failures.push(`${name}: "${x.what}" is ${Math.round(x.w)}x${Math.round(x.h)} px, under 44`);
}
// axe-core's target-size (WCAG 2.5.8) and color-contrast (WCAG 1.4.3) rules on what's open.
const axePath = createRequire(import.meta.url).resolve("axe-core");
async function checkAxe(pg, name) {
  await pg.addScriptTag({ path: axePath });
  const v = await pg.evaluate(async () => (await globalThis.axe.run(document, { runOnly: ["target-size", "color-contrast"] })).violations
    .flatMap((x) => x.nodes.map((n) => `${x.id}: ${n.target.join(" ")} (${n.failureSummary.split("\n").slice(1).join(" ").trim()})`)));
  for (const x of v) failures.push(`${name}: axe ${x}`);
}
const topBarSel = ".sheet-tools button:not([hidden]), .sheet-tools a";
for (const dark of [false, true]) {
  const name = `/plan 390px touch ${dark ? "dark" : "light"}`;
  await shot("/plan/", `plan-phone-touch-${dark ? "dark" : "light"}`, 390, 844, dark, async (pg) => {
    await checkTopBar(pg, name);
    await checkAddRows(pg, name);
    await checkTargets(pg, name, `${topBarSel}, .sheet-week .sheet-btn-approve`);
    await checkAxe(pg, name);
  }, undefined, true);
  // Plan today on the phone: the resize and shutdown handles and Approve are finger-sized.
  await shot("/plan/", `plan-today-touch-${dark ? "dark" : "light"}`, 390, 844, dark, async (pg) => {
    await pg.evaluate(() => document.querySelector('[data-act="plan"]').click());
    await new Promise((r) => setTimeout(r, 800));
    await checkTargets(pg, `Plan today ${name}`, "[data-plan] :is(.sheet-resize, .sheet-shutline, .sheet-block-x, .sheet-btn-approve)");
    await checkAxe(pg, `Plan today ${name}`);
  }, undefined, true);
}
// 4:30 pm, in the shutdown window: Shut down joins the bar, which still holds one row.
await shot("/plan/", "plan-phone-shutdown", 390, 844, false, async (pg) => {
  if (!(await pg.$eval('[data-act="shutdown"]', (x) => Boolean(x.getClientRects().length)))) failures.push("390px at 4:30 pm: no Shut down button");
  await checkTopBar(pg, "/plan 390px touch at 4:30 pm");
  await checkTargets(pg, "/plan 390px touch at 4:30 pm", topBarSel);
}, "2026-11-03T21:30:00Z", true);
// The laptop the phone work must not break: one top-bar row and the same axe rules.
for (const dark of [false, true]) {
  const name = `/plan 1366px ${dark ? "dark" : "light"}`;
  await shot("/plan/", `plan-week-1366-${dark ? "dark" : "light"}`, 1366, 800, dark, async (pg) => { await checkTopBar(pg, name); await checkAddRows(pg, name); await checkAxe(pg, name); });
}
// Add to Home Screen opens /plan/ on its own (Web App Manifest, https://www.w3.org/TR/appmanifest/),
// and standalone hides the site's nav and footer.
{
  const pg = await b.newPage();
  const res = await pg.goto(`${BASE}/plan/manifest.webmanifest`);
  const m = res.ok() ? await res.json().catch(() => null) : null;
  if (!m || m.start_url !== "/plan/" || m.scope !== "/plan/" || m.display !== "standalone") failures.push(`manifest: ${JSON.stringify(m)}`);
  await pg.setRequestInterception(true);
  pg.on("request", route);
  await pg.goto(`${BASE}/plan/`, { waitUntil: "networkidle0" });
  // Headless Chrome can't emulate display-mode, so the page's standalone rules are applied as
  // plain rules, and the nav and footer must then be gone.
  const r = await pg.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((s) => [...s.cssRules])
      .filter((x) => x instanceof CSSMediaRule && /display-mode:\s*standalone/.test(x.conditionText))
      .flatMap((x) => [...x.cssRules].map((y) => y.cssText));
    const parts = () => [...document.querySelectorAll("body > .topbar, body > .footer")];
    const before = parts().filter((x) => x.getClientRects().length).length;
    document.head.append(Object.assign(document.createElement("style"), { textContent: rules.join("\n") }));
    return { link: document.querySelector('link[rel="manifest"]')?.getAttribute("href"), before, after: parts().filter((x) => x.getClientRects().length).length };
  });
  if (r.link !== "/plan/manifest.webmanifest") failures.push(`manifest link: ${r.link}`);
  if (r.before !== 2 || r.after) failures.push(`standalone: nav and footer show ${r.before} in a tab and ${r.after} standalone, expected 2 and 0`);
  await pg.close();
}
// The dialog: four groups in order, only Gmail links, opened with noopener noreferrer, and Done
// takes a row away.
async function checkNeeds(pg, name) {
  const r = await pg.evaluate(() => {
    const d = document.querySelector("[data-needs]");
    return {
      open: d.open,
      groups: [...d.querySelectorAll(".sheet-needs-group h3")].map((h) => h.textContent),
      rows: d.querySelectorAll(".sheet-needs-item").length,
      links: [...d.querySelectorAll("a")].map((a) => [a.href.startsWith("https://mail.google.com/"), a.rel]),
    };
  });
  if (!r.open) return failures.push(`${name}: the Needs you dialog did not open`);
  if (r.groups.join("|") !== "Reply owed|Deadlines|Meetings|School & admin") failures.push(`${name}: groups ${r.groups.join(", ")}`);
  if (r.rows !== 4) failures.push(`${name}: ${r.rows} rows, expected 4`);
  if (r.links.length !== 3 || r.links.some(([gmail, rel]) => !gmail || rel !== "noopener noreferrer")) failures.push(`${name}: links ${JSON.stringify(r.links)}`);
}
for (const w of [1440, 390]) for (const dark of [false, true]) {
  const name = `Needs you ${w}px ${dark ? "dark" : "light"}`;
  await shot("/plan/", `plan-needs-${w}-${dark ? "dark" : "light"}`, w, w > 400 ? 900 : 844, dark, async (pg) => {
    await pg.keyboard.press("m");
    await new Promise((r) => setTimeout(r, 500));
    await checkNeeds(pg, name);
  });
}
await shot("/plan/", "plan-needs-done", 1440, 900, false, async (pg) => {
  await pg.click("[data-needs-chip]");
  await new Promise((r) => setTimeout(r, 500));
  await pg.click("[data-need-done]");
  await new Promise((r) => setTimeout(r, 500));
  const n = await pg.evaluate(() => [document.querySelectorAll(".sheet-needs-item").length, document.querySelector("[data-needs-n]").textContent.trim()]);
  if (n[0] !== 3 || n[1] !== "3") failures.push(`Needs you Done: ${n[0]} rows and chip ${n[1]}, expected 3 and 3`);
});
// Each page load saves busy times (start and end only) and makes the off-page block's event once.
{
  writes.busy = []; writes.events = 0;
  await shot("/plan/", "plan-sync", 1440, 900, false);
  const rows = writes.busy.flat();
  if (!rows.length) failures.push("busy: nothing saved");
  if (rows.some((x) => Object.keys(x).join() !== "starts_at,ends_at")) failures.push(`busy: rows hold more than start and end: ${JSON.stringify(rows[0])}`);
  if (rows.some((x) => x.starts_at.length === 10)) failures.push("busy: an all-day event was saved");
  if (writes.events !== 1) failures.push(`off-page block: ${writes.events} Google events made, expected 1`);
}
await shot("/plan/", "plan-more", 1440, 900, false, async (pg) => { await pg.click('[popovertarget="sheet-more"]'); await new Promise((r) => setTimeout(r, 300)); });
// /now draws a private task as a solid bar in --fg, at least 0.6em tall.
async function checkPrivateBars(pg, name) {
  const r = await pg.evaluate(() => {
    const probe = document.body.appendChild(Object.assign(document.createElement("i"), { style: "background: var(--fg)" }));
    const fg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...document.querySelectorAll(".sheet-bar")].map((x) => {
      const s = getComputedStyle(x);
      return { tall: x.getBoundingClientRect().height >= 0.6 * parseFloat(s.fontSize), fg: s.backgroundColor === fg };
    });
  });
  if (!r.length) return failures.push(`${name}: no private bars drawn`);
  if (r.some((x) => !x.tall || !x.fg)) failures.push(`${name}: a private bar is under 0.6em or not --fg`);
}
for (const [name, w, dark] of [["now-light", 1440, false], ["now-dark", 1440, true], ["now-phone", 390, false]]) {
  await shot("/now/", name, w, w > 400 ? 900 : 844, dark, (pg) => checkPrivateBars(pg, `/now ${name}`));
}
await b.close();
for (const f of failures) console.error("FAIL", f);
console.log(failures.length ? `${failures.length} check(s) failed` : "All checks passed");
process.exit(failures.length ? 1 : 0);
