import puppeteer from "puppeteer";
const OUT = process.argv[2];
const BASE = "http://localhost:4321";
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
  const map = { tasks: tasks, blocks, days, settings, campus_events: campus, feed_state: feeds, mail_accounts: [{ id: 1, email: "lisul@stonybrook.edu", label: null, last_error: null }], gcal_pending: [], public_week: pubWeek, public_days: days, public_now: [{ title: "WorkIt: batch apply PR review", heads_down: false }] };
  if (new URL(u).search.includes("parked_on")) return json(r, [{ id: 99 }]);
  return json(r, map[p] ?? []);
}
const b = await puppeteer.launch({ headless: true });
async function shot(path, name, w, h, dark, after) {
  const pg = await b.newPage();
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  await pg.emulateTimezone("America/New_York");
  await pg.setRequestInterception(true);
  pg.on("request", route);
  pg.on("pageerror", (e) => console.log("pageerror", e.message));
  await pg.evaluateOnNewDocument(() => {
    const fixed = new Date("2026-11-03T15:20:00Z").getTime(); const RD = Date; const off = fixed - RD.now();
    globalThis.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [RD.now() + off])); } static now() { return RD.now() + off; } };
    localStorage.setItem("sheet.session", JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3e6, provider_token: "g", provider_expires_at: Date.now() + 3e6 }));
  });
  await pg.goto(BASE + path, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  if (after) await after(pg);
  await pg.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await pg.close();
}
await shot("/plan/", "plan-week-light", 1440, 900, false);
await shot("/plan/", "plan-week-dark", 1440, 900, true);
await shot("/plan/", "plan-today", 1440, 900, false, async (pg) => { await pg.keyboard.press("p"); await new Promise((r) => setTimeout(r, 800)); });
await shot("/plan/", "plan-campus", 1440, 900, false, async (pg) => { await pg.click(".sheet-campus-row"); await new Promise((r) => setTimeout(r, 500)); });
await shot("/plan/", "plan-settings", 1440, 900, false, async (pg) => { await pg.click('[data-act="settings"]'); await new Promise((r) => setTimeout(r, 800)); });
await shot("/plan/", "plan-phone", 390, 844, false);
await shot("/now/", "now-light", 1440, 900, false);
await shot("/now/", "now-phone", 390, 844, false);
await b.close();
