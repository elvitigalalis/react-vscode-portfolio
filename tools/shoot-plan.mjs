// Usage: npm run build, then npx astro preview --port 4321, then node tools/shoot-plan.mjs <outdir>
// (BASE=http://localhost:<port> for another port). Screenshots /plan and /now with Supabase and
// Google stubbed, and checks the layout (docs/sheet-glance.md, "Quality bar"); exits 1 on a failure.
import puppeteer from "puppeteer";
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
];
const days = [{ day: "2026-11-02", planned: true, shutdown: true }, { day: "2026-11-03", planned: false, shutdown: false }];
const settings = [{ id: true, owner_email: "x@y", nudges_on: true, calendars: [], gcal_calendar_id: "c", interests: "robotics, free food" }];
const campus = [
  { uid: "c1", title: "Pizza & Pitch Night", starts_at: "2026-11-03T22:00:00Z", ends_at: "2026-11-04T00:00:00Z", all_day: false, group_name: "Entrepreneurship Club", event_type: "Social", tags: ["Free Food", "Career"], url: "https://sbengaged.stonybrook.edu/x" },
  { uid: "c2", title: "Google Info Session", starts_at: "2026-11-03T21:00:00Z", ends_at: "2026-11-03T22:00:00Z", all_day: false, group_name: "Career Center", event_type: "Info Session", tags: ["Career"], url: null },
  { uid: "c3", title: "IEEE Workshop: Soldering", starts_at: "2026-11-04T22:00:00Z", ends_at: "2026-11-04T23:30:00Z", all_day: false, group_name: "IEEE", event_type: "Workshop", tags: ["Free Food", "Engineering"], url: null },
];
const feeds = [{ source: "brightspace", fetched_at: "2026-11-03T13:20:00Z", ok: true, error: null, items: 12 }, { source: "campus", fetched_at: "2026-11-03T13:35:00Z", ok: false, error: "304 parse", items: 0 }];
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
  if (u.includes("googleapis.com")) return json(r, gEvents);
  if (!u.includes("supabase.co")) return r.continue();
  const p = new URL(u).pathname.replace("/rest/v1/", "");
  const map = { tasks: tasks, blocks, days, settings, campus_events: campus, feed_state: feeds, mail_accounts: [{ id: 1, email: "lisul@stonybrook.edu", label: null, last_error: null }], gcal_pending: [], public_week: pubWeek, public_days: days, public_now: [{ title: "WorkIt: batch apply PR review", tag: "workit", public: true, updated_on: "2026-11-03" }] };
  if (new URL(u).search.includes("parked_on")) return json(r, [{ id: 99 }]);
  return json(r, map[p] ?? []);
}
const b = await puppeteer.launch({ headless: true });
async function shot(path, name, w, h, dark, after, at = "2026-11-03T15:20:00Z") {
  const pg = await b.newPage();
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
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
await shot("/plan/", "plan-campus", 1440, 900, false, async (pg) => { await pg.click(".sheet-campus-row"); await new Promise((r) => setTimeout(r, 500)); });
await shot("/plan/", "plan-settings", 1440, 900, false, async (pg) => { await pg.click("[data-feed-alert]"); await new Promise((r) => setTimeout(r, 800)); });
await shot("/plan/", "plan-help", 1440, 900, false, async (pg) => { await pg.click('[popovertarget="sheet-more"]'); await pg.click('[data-more] [data-act="help"]'); await new Promise((r) => setTimeout(r, 500)); });
for (const dark of [false, true]) {
  await shot("/plan/", `plan-phone-${dark ? "dark" : "light"}`, 390, 844, dark, (pg) => checkTopBar(pg, `/plan 390px ${dark ? "dark" : "light"}`));
}
await shot("/plan/", "plan-more", 1440, 900, false, async (pg) => { await pg.click('[popovertarget="sheet-more"]'); await new Promise((r) => setTimeout(r, 300)); });
await shot("/now/", "now-light", 1440, 900, false);
await shot("/now/", "now-dark", 1440, 900, true);
await shot("/now/", "now-phone", 390, 844, false);
await b.close();
for (const f of failures) console.error("FAIL", f);
console.log(failures.length ? `${failures.length} check(s) failed` : "All checks passed");
process.exit(failures.length ? 1 : 0);
