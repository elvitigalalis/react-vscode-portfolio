// Drives /plan through its real flows, signed in, against a stateful stub of Supabase and Google.
// tools/shoot-plan.mjs screenshots and checks layout on fixed data; this one clicks: add, edit and
// complete a task, a project's steps, focus, proposals, every dialog, the ?open= links, Settings,
// and coming back to the tab.
// Usage: npm run build, npx astro preview --port 4321, then node tools/drive-plan.mjs [outdir]
// (BASE=http://localhost:<port>, ONLY=<scenario substring>). Exits 1 on a failed check.
import puppeteer from "puppeteer";
const OUT = process.argv[2];
const BASE = process.env.BASE ?? "http://localhost:4321";
const ONLY = process.env.ONLY ?? "";
const AT = "2026-11-03T15:20:00Z"; // Tue Nov 3, 10:20 am in New York

// --- The stub database -----------------------------------------------------------------------
const T = (id, title, day, extra = {}) => ({ id, title, day, list: day ? null : "Inbox", position: Number(String(id).replace(/\D/g, "")) || 1, est_min: null, at_time: null, tag: null, public: true, done: false, rolls: 0, due: null, source: null, link: null, project_id: null, step: null, parked_on: null, created_at: "2026-11-01T00:00:00Z", ...extra });
const B = (id, task_id, from, to, extra = {}) => ({ id, task_id, habit_id: null, starts_at: `2026-11-03T${from}:00Z`, ends_at: `2026-11-03T${to}:00Z`, gcal_id: null, proposed: false, auto: false, first_step: null, ...extra });
const seed = () => ({
  tasks: [
    T("t1", "OS homework 4", "2026-11-03", { est_min: 90, due: "2026-11-04", public: false, source: "brightspace" }),
    T("t2", "WorkIt: batch apply PR review", "2026-11-03", { est_min: 45, tag: "workit" }),
    T("t3", "Email advisor re: spring schedule", "2026-11-03", { est_min: 15, rolls: 2 }),
    T("t4", "Laundry", "2026-11-02", { done: true }),
    T("t5", "Read ch. 7 for CSE 320", "2026-11-04", { est_min: 60 }),
    T("t6", "Draft cover letter", null),
    // A project: its steps are Inbox tasks with a project_id (docs/sheet-projects.md).
    T("s1", "Write the schema", null, { project_id: "p1", step: 1, est_min: 60, due: "2026-11-20" }),
    T("s2", "Build the API", null, { project_id: "p1", step: 2, est_min: 120, due: "2026-11-20" }),
    T("s3", "Build the UI", null, { project_id: "p1", step: 3, est_min: 120, due: "2026-11-20" }),
  ],
  projects: [{ id: "p1", title: "CSE 416 final project", due: "2026-11-20", est_min: 300, done: false, created_at: "2026-11-01T00:00:00Z" }],
  blocks: [
    B("b1", "t2", "15:00", "15:45", { gcal_id: "g1", first_step: "Open the diff" }),
    B("b2", "t1", "19:00", "20:30", { proposed: true }),
    B("b3", "t3", "16:00", "16:15", { proposed: true }),
    // The horizon gave the project's first step time today, as an approved block.
    B("b4", "s1", "17:00", "18:00", { gcal_id: "g4" }),
  ],
  days: [{ day: "2026-11-02", planned: true, shutdown: true }, { day: "2026-11-03", planned: false, shutdown: false }],
  settings: [{ id: true, owner_email: "x@y", nudges_on: true, calendars: [], gcal_calendar_id: "c", interests: "robotics", workload_cap_min: 480, replans_on: true, auto_approve: false, bedtime_target: "23:30:00", github_orgs: [] }],
  proposals: [{ day: "2026-11-03", rev: 2, status: "pending", note: "Lab 5 didn't fit before shutdown.", picks: [], couldnt_fit: [], suggested: [] }],
  needs_you: [{ id: "n1", day: "2026-11-03", account: "a@b", message_id: "m1", link: "https://mail.google.com/mail/?authuser=a#all/1", sender: "Ana", subject: "Demo moved", why: "Reply by Thu", kind: "reply", due: "2026-11-05", done: false, created_at: "2026-11-03T11:07:00Z" }],
  feed_state: [{ source: "brightspace", fetched_at: "2026-11-03T15:00:00Z", ok: true, error: null, items: 12 }, { source: "campus", fetched_at: "2026-11-03T15:00:00Z", ok: false, error: "304 parse", items: 0 }],
  mail_accounts: [{ id: 1, email: "lisul@stonybrook.edu", label: null, last_error: null }],
  calendar_account: [{ email: "lisul@stonybrook.edu", connected_at: "2026-10-01T00:00:00Z", last_error: null }],
  oura_account: [{ connected_at: "2026-10-01T00:00:00Z", synced_at: "2026-11-03T15:00:00Z", last_error: null, workouts_ok: true }],
  sleep_nights: ["10-27", "10-28", "10-29", "10-30", "10-31", "11-01", "11-02", "11-03"].map((d, i) => ({ oura_id: `o${i}`, day: `2026-${d}`, type: "long_sleep", bedtime_start: `2026-${d}T04:30:00Z`, bedtime_end: `2026-${d}T12:30:00Z` })),
  sleep_days: [{ day: "2026-11-03", sleep_score: 82, readiness_score: 86, total_sleep_min: 460 }],
  sleep_times: [],
  horizon_alloc: [{ task_id: "s2", day: "2026-11-05", minutes: 90, over_min: 0, task: { title: "Build the API" } }],
  horizon_state: [{ task_id: "s1", state: "on_track", slack_min: 200, short_min: 0, remaining_min: 60, finish_day: "2026-11-04" }, { task_id: "s2", state: "tight", slack_min: 10, short_min: 0, remaining_min: 120, finish_day: "2026-11-05" }],
  actuals: [], habits: [], triage_rules: [], event_todos: [], messages: [], gcal_pending: [], campus_events: [], reply_state: [], feedback: [],
});
const gEvents = { items: [
  { id: "e1", iCalUID: "e1", summary: "CSE 320 Lecture", start: { dateTime: "2026-11-03T14:00:00Z" }, end: { dateTime: "2026-11-03T14:50:00Z" } },
  { id: "e2", iCalUID: "e2", summary: "Election Day", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } },
] };

// PostgREST's filters, as far as the page uses them.
function matches(row, key, cond) {
  const v = row[key];
  if (cond === "is.null") return v == null;
  if (cond === "not.is.null") return v != null;
  if (cond === "is.false") return v === false;
  if (cond === "is.true") return v === true;
  const [op, ...rest] = cond.split(".");
  const arg = rest.join(".");
  if (op === "eq") return String(v) === arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(v));
  if (op === "gte") return v >= arg;
  if (op === "lte") return v <= arg;
  if (op === "gt") return v > arg;
  if (op === "lt") return v < arg;
  return true;
}
function select(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
    if (k === "or") { const [from, to] = [...v.matchAll(/day\.(?:gte|lte)\.([\d-]+)/g)].map((m) => m[1]); out = out.filter((r) => r.day == null || (r.day >= from && r.day <= to)); continue; }
    out = out.filter((r) => matches(r, k, v));
  }
  return out;
}

function stub() {
  const db = seed();
  const log = [];
  let nid = 100;
  const json = (r, body, status = 200) => r.respond({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  const respond = (r) => {
    const u = new URL(r.url());
    const method = r.method();
    if (method === "OPTIONS") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (u.hostname.includes("googleapis.com")) {
      if (method !== "GET") log.push({ method, path: `google${u.pathname}` });
      if (method === "POST") return json(r, { id: `gnew${nid++}` });
      if (method === "DELETE") return r.respond({ status: 204, headers: { "access-control-allow-origin": "*" } });
      if (method === "PATCH") return json(r, {});
      return json(r, u.pathname.includes("freeBusy") ? { calendars: {} } : gEvents);
    }
    if (!u.hostname.includes("supabase.co")) return r.continue();
    if (u.pathname.startsWith("/auth/") || u.pathname.startsWith("/functions/")) return json(r, {}, 401);
    const table = u.pathname.replace("/rest/v1/", "");
    const params = [...u.searchParams.entries()];
    const body = r.postData() ? JSON.parse(r.postData()) : null;
    log.push({ method, path: table, query: u.search, body });
    if (table.startsWith("rpc/")) {
      const fn = table.slice(4);
      if (fn === "approve_proposal") {
        for (const b of db.blocks) if (b.proposed) b.proposed = false;
        db.proposals[0].status = "approved";
        return json(r, body.rev);
      }
      if (fn === "turn_down") { db.blocks = db.blocks.filter((b) => !(b.proposed && b.task_id === body.task)); return json(r, null); }
      if (fn === "record_focus") { db.actuals.push({ ...body, at: new Date().toISOString() }); return json(r, true); }
      if (fn === "shut_down") { db.days.find((d) => d.day === body.d).shutdown = true; return json(r, null); }
      return json(r, null);
    }
    const rows = db[table] ?? [];
    if (method === "GET") {
      let out = select(rows, params);
      if (table === "blocks") out = out.map((b) => ({ ...b, tasks: db.tasks.find((t) => t.id === b.task_id) ?? null }));
      return json(r, out);
    }
    if (method === "POST") {
      const row = { ...body, id: body.id ?? `new${nid++}`, ...(table === "tasks" ? { done: false, rolls: 0, project_id: null, step: null } : {}) };
      if (table === "days" || table === "event_todos") { const k = table === "days" ? "day" : "cal_event_key"; const had = rows.find((x) => x[k] === body[k]); if (had) Object.assign(had, body); else rows.push(body); return json(r, null, 201); }
      db[table] ??= [];
      db[table].push(row);
      return json(r, [row], 201);
    }
    const hit = select(rows, params);
    if (method === "PATCH") {
      for (const x of hit) {
        const next = { ...x, ...body };
        // tasks' own check: a day or a list, never neither (supabase/schema.sql).
        if (table === "tasks" && (next.day == null) !== (next.list != null)) return json(r, { message: "violates check" }, 400);
        Object.assign(x, body);
      }
      syncProject(db);
      return json(r, hit);
    }
    if (method === "DELETE") { db[table] = rows.filter((x) => !hit.includes(x)); syncProject(db); return json(r, null); }
    return json(r, []);
  };
  return { db, log, respond };
}
// The tasks_project_done trigger.
function syncProject(db) { for (const p of db.projects) p.done = db.tasks.filter((t) => t.project_id === p.id).every((t) => t.done); }

// --- The harness -----------------------------------------------------------------------------
const browser = await puppeteer.launch({ headless: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` :: ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ w = 1440, dark = false, touch = false, at = AT, path = "/plan/", prep } = {}) {
  const s = stub();
  if (prep) prep(s.db);
  const pg = await browser.newPage();
  await pg.setViewport({ width: w, height: w > 500 ? 900 : 844, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);
  await pg.emulateTimezone("America/New_York");
  await pg.setRequestInterception(true);
  pg.on("request", s.respond);
  const errors = [];
  pg.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  pg.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await pg.evaluateOnNewDocument((at) => {
    const RD = Date;
    globalThis.__off = new RD(at).getTime() - RD.now();
    globalThis.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [RD.now() + globalThis.__off])); } static now() { return RD.now() + globalThis.__off; } };
    localStorage.setItem("sheet.session", JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3e7, provider_token: "g", provider_expires_at: Date.now() + 3e7 }));
  }, at);
  await pg.goto(BASE + path, { waitUntil: "networkidle0" });
  await sleep(400);
  return { pg, ...s, errors, touch };
}

// A real press: scrolled into view, at its centre, and whatever sits on top takes it. So a covered
// button fails here as it would under a finger.
async function press(c, sel, name = sel) {
  const pos = await c.pg.evaluate((sel) => {
    const x = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length);
    if (!x) return null;
    x.scrollIntoView({ block: "center", inline: "nearest" });
    const r = x.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: x === at || x.contains(at) || at?.contains(x) && at === x, top: at ? `${at.tagName}.${at.className?.baseVal ?? at.className}` : "none" };
  }, sel);
  if (!pos) { check(`${name}: on screen`, false, `nothing visible matches ${sel}`); return false; }
  if (!pos.on) check(`${name}: nothing covers it`, false, `covered by ${pos.top}`);
  if (c.touch) await c.pg.touchscreen.tap(pos.x, pos.y); else await c.pg.mouse.click(pos.x, pos.y);
  await sleep(250);
  return true;
}
const text = (c, sel) => c.pg.evaluate((sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length).map((n) => n.textContent.replace(/\s+/g, " ").trim()).join(" | "), sel);
const shown = (c, sel) => c.pg.evaluate((sel) => [...document.querySelectorAll(sel)].some((n) => n.getClientRects().length), sel);
const openDialogs = (c) => c.pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => [...d.attributes].find((a) => a.name.startsWith("data-"))?.name ?? d.className));
const shot = async (c, name) => { if (OUT) await c.pg.screenshot({ path: `${OUT}/${name}.png` }); };

// No sideways scroll, and no visible control sits under another element in what's on screen.
async function layout(c, name) {
  const r = await c.pg.evaluate(() => {
    const top = [...document.querySelectorAll("dialog[open]")].at(-1) ?? document.querySelector(".sheet-planner");
    const covered = [];
    for (const x of top.querySelectorAll("button, a, summary, input, textarea, select")) {
      if (!x.getClientRects().length) continue;
      const b = x.getBoundingClientRect();
      if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight || b.right > innerWidth || b.left < 0) continue;
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      // An open menu covers what's under it on purpose, and the site's sticky header covers rows
      // scrolled under it.
      if (!at || x === at || x.contains(at) || at.contains(x) || at.closest("[data-toast], :popover-open, body > header, body > .topbar, .sheet-settings-index")) continue;
      if (at.closest("label")?.contains(x)) continue;
      if (getComputedStyle(x).visibility === "hidden" || x.closest(".visually-hidden")) continue;
      // A closed <details> keeps its contents' boxes but draws none of them.
      if ((x.matches("summary") ? x.parentElement.parentElement : x)?.closest("details:not([open])")) continue;
      covered.push(`${x.tagName} "${(x.ariaLabel || x.textContent).trim().slice(0, 30)}" under ${at.tagName}.${at.className?.baseVal ?? at.className}`);
    }
    return { wide: document.documentElement.scrollWidth - innerWidth, covered: covered.slice(0, 6) };
  });
  check(`${name}: no sideways scroll`, r.wide <= 0, `${r.wide}px`);
  check(`${name}: no control covered`, !r.covered.length, r.covered.join("; "));
}
const clean = (c, name) => check(`${name}: no console errors`, !c.errors.length, c.errors.join(" ; ").slice(0, 400));

const scenarios = {};
const VIEWS = [["1440-light", { w: 1440 }], ["1440-dark", { w: 1440, dark: true }], ["390-light", { w: 390, touch: true }], ["390-dark", { w: 390, touch: true, dark: true }]];
for (const [v, opt] of VIEWS) {
  scenarios[`tasks ${v}`] = async (n) => {
    const c = await open(opt);
    await layout(c, `${n} week`);
    await shot(c, `week-${v}`);
    // Add.
    await c.pg.focus('.sheet-day.is-today .sheet-add');
    await c.pg.keyboard.type("Buy stamps ~20m");
    await c.pg.keyboard.press("Enter");
    await sleep(300);
    check(`${n} add`, (await text(c, ".sheet-day.is-today .sheet-title")).includes("Buy stamps"), await text(c, ".sheet-day.is-today .sheet-title"));
    check(`${n} add saved the estimate`, c.db.tasks.find((t) => t.title === "Buy stamps")?.est_min === 20);
    // Edit.
    await press(c, '.sheet-day.is-today .sheet-task[data-id="t3"] .sheet-title', `${n} title`);
    check(`${n} edit opens`, await shown(c, ".sheet-edit"));
    await c.pg.keyboard.type("Email advisor now");
    await c.pg.keyboard.press("Enter");
    await sleep(300);
    check(`${n} edit saved`, c.db.tasks.find((t) => t.id === "t3").title === "Email advisor now");
    check(`${n} edit offers Undo`, await shown(c, "[data-toast]"));
    await press(c, '[data-act="undo"]', `${n} Undo`);
    await sleep(200);
    check(`${n} Undo restores`, c.db.tasks.find((t) => t.id === "t3").title === "Email advisor re: spring schedule");
    // Complete and reopen.
    await press(c, '.sheet-day.is-today .sheet-task[data-id="t3"] .sheet-check', `${n} check`);
    check(`${n} complete`, c.db.tasks.find((t) => t.id === "t3").done);
    check(`${n} proposed block goes when done`, !c.db.blocks.find((b) => b.id === "b3"));
    await press(c, '[data-act="undo"]', `${n} Undo done`);
    check(`${n} Undo reopens`, !c.db.tasks.find((t) => t.id === "t3").done);
    // The task menu.
    await press(c, '.sheet-day.is-today .sheet-task[data-id="t2"] .sheet-more', `${n} row menu`);
    check(`${n} menu opens`, await shown(c, "[data-menu]"));
    await layout(c, `${n} menu`);
    await press(c, '[data-move="tomorrow"]', `${n} to tomorrow`);
    await sleep(200);
    check(`${n} moved to tomorrow`, c.db.tasks.find((t) => t.id === "t2").day === "2026-11-04");
    clean(c, n);
    await c.pg.close();
  };
  scenarios[`project ${v}`] = async (n) => {
    const c = await open(opt);
    check(`${n} summary`, /0 of 3 steps/.test(await text(c, ".sheet-project summary")), await text(c, ".sheet-project summary"));
    check(`${n} steps not in Someday`, !(await text(c, ".sheet-list .sheet-title")).includes("Build the API"));
    await press(c, ".sheet-project summary", `${n} open project`);
    await shot(c, `project-${v}`);
    await layout(c, `${n} open`);
    await press(c, '.sheet-project .sheet-task[data-id="s2"] .sheet-check', `${n} step check`);
    await sleep(200);
    check(`${n} step done`, c.db.tasks.find((t) => t.id === "s2").done);
    check(`${n} advances`, /1 of 3 steps/.test(await text(c, ".sheet-project summary")), await text(c, ".sheet-project summary"));
    check(`${n} stays open across the redraw`, await shown(c, '.sheet-project .sheet-task[data-id="s3"] .sheet-title'));
    await press(c, '.sheet-project .sheet-task[data-id="s3"] .sheet-check', `${n} step 3`);
    await sleep(200);
    await press(c, '.sheet-project .sheet-task[data-id="s1"] .sheet-check', `${n} last step`);
    await sleep(200);
    check(`${n} last step finishes it`, c.db.projects[0].done);
    check(`${n} project leaves the list`, !(await shown(c, ".sheet-project")));
    await press(c, '[data-act="undo"]', `${n} Undo last step`);
    await sleep(200);
    check(`${n} Undo brings it back`, await shown(c, ".sheet-project") && !c.db.projects[0].done);
    clean(c, n);
    await c.pg.close();
  };
  scenarios[`focus ${v}`] = async (n) => {
    const c = await open(opt);
    check(`${n} Start on the block on now`, await shown(c, '.sheet-task[data-id="t2"] [data-act="focus-start"]'));
    await layout(c, `${n} week`);
    await press(c, '.sheet-task[data-id="t2"] [data-act="focus-start"]', `${n} Start`);
    await sleep(300);
    check(`${n} view opens`, await shown(c, "dialog.sheet-focus"));
    check(`${n} first step`, (await text(c, ".sheet-focus-first")).includes("Open the diff"));
    await shot(c, `focus-${v}`);
    await layout(c, `${n} view`);
    const left = await text(c, ".sheet-focus-left");
    await c.pg.evaluate(() => { globalThis.__off += 10 * 60_000; });
    await sleep(1200);
    check(`${n} clock runs`, (await text(c, ".sheet-focus-left")) !== left);
    await press(c, ".sheet-focus-actions .sheet-btn:nth-child(2)", `${n} +15`);
    await sleep(300);
    check(`${n} +15 moved the block`, c.db.blocks.find((b) => b.id === "b1").ends_at.startsWith("2026-11-03T16:00"), c.db.blocks.find((b) => b.id === "b1").ends_at);
    await press(c, ".sheet-focus-leave", `${n} leave`);
    await sleep(200);
    check(`${n} shows Resume`, /Resume/.test(await text(c, '[data-act="focus-start"]')), await text(c, '[data-act="focus-start"]'));
    // The session survives a reload.
    await c.pg.reload({ waitUntil: "networkidle0" });
    await sleep(300);
    check(`${n} Resume after reload`, /Resume/.test(await text(c, '[data-act="focus-start"]')));
    // The reload reset the page's clock to 10:20; ten minutes on again, as before it.
    await c.pg.evaluate(() => { globalThis.__off += 10 * 60_000; });
    await press(c, '[data-act="focus-start"]', `${n} Resume`);
    await sleep(300);
    await press(c, ".sheet-focus-actions .primary", `${n} Done`);
    await sleep(500);
    const order = c.log.filter((l) => l.path === "rpc/record_focus" || (l.path === "tasks" && l.method === "PATCH")).map((l) => l.path);
    check(`${n} actuals then done`, order[0] === "rpc/record_focus" && order[1] === "tasks", order.join());
    check(`${n} task done`, c.db.tasks.find((t) => t.id === "t2").done);
    check(`${n} toast visible with Undo`, await shown(c, "[data-toast]"));
    clean(c, n);
    await c.pg.close();
  };
  scenarios[`focus on a project step ${v}`] = async (n) => {
    // 12:10 pm: the step's block (12–1 pm) is on, and nothing else is.
    const c = await open({ ...opt, at: "2026-11-03T17:10:00Z" });
    await press(c, ".sheet-project summary", `${n} open project`);
    const has = await shown(c, '.sheet-task[data-id="s1"] [data-act="focus-start"]');
    check(`${n} Start on the step's block`, has);
    if (has) {
      await press(c, '.sheet-task[data-id="s1"] [data-act="focus-start"]', `${n} Start`);
      await sleep(300);
      await c.pg.evaluate(() => { globalThis.__off += 5 * 60_000; });
      await press(c, ".sheet-focus-actions .primary", `${n} Done`);
      await sleep(500);
      check(`${n} step done`, c.db.tasks.find((t) => t.id === "s1").done);
      check(`${n} actuals`, c.db.actuals.length === 1);
      check(`${n} project advances`, /1 of 3 steps/.test(await text(c, ".sheet-project summary")), await text(c, ".sheet-project summary"));
    }
    clean(c, n);
    await c.pg.close();
  };
  scenarios[`proposals ${v}`] = async (n) => {
    const c = await open(opt);
    // Approve from the week.
    check(`${n} Approve in the week`, await shown(c, '.sheet-week [data-act="approve"]'));
    await press(c, '.sheet-week [data-act="approve"][data-block="b3"]', `${n} week Approve`);
    await sleep(300);
    check(`${n} approved`, c.db.blocks.find((b) => b.id === "b3").proposed === false);
    check(`${n} gets a Google event`, Boolean(c.db.blocks.find((b) => b.id === "b3").gcal_id));
    // Plan today: turn down, then approve all.
    await press(c, '[data-act="plan"]', `${n} Plan today`);
    await sleep(500);
    check(`${n} dialog opens`, (await openDialogs(c)).includes("data-plan"));
    await shot(c, `plan-${v}`);
    await layout(c, `${n} dialog`);
    check(`${n} note`, (await text(c, ".sheet-plan-notes")).includes("Lab 5"), await text(c, ".sheet-plan-notes"));
    await press(c, ".sheet-approve-all", `${n} Approve all`);
    await sleep(600);
    check(`${n} approve_proposal called`, c.log.some((l) => l.path === "rpc/approve_proposal"));
    check(`${n} none proposed`, !c.db.blocks.some((b) => b.proposed));
    check(`${n} banner gone`, !(await shown(c, "[data-plan] .sheet-banner")));
    // Completing a task inside the dialog: its Undo has to be reachable.
    await press(c, "[data-plan] .sheet-task .sheet-check", `${n} check in the dialog`);
    await sleep(300);
    const toast = await c.pg.evaluate(() => {
      const t = document.querySelector("[data-toast] [data-act='undo']");
      if (!t?.getClientRects().length) return "hidden";
      const r = t.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === t ? "ok" : `under ${at?.tagName}.${at?.className}`;
    });
    check(`${n} Undo reachable over the dialog`, toast === "ok", toast);
    await press(c, "[data-plan] .sheet-dialog-end .primary", `${n} Done`);
    await sleep(300);
    check(`${n} the toast survives the dialog`, await c.pg.evaluate(() => Boolean(document.querySelector("[data-toast]"))));
    check(`${n} marked planned`, c.db.days.find((d) => d.day === "2026-11-03").planned);
    clean(c, n);
    await c.pg.close();
  };
  scenarios[`dialogs ${v}`] = async (n) => {
    const c = await open(opt);
    const more = async () => { await press(c, '[popovertarget="sheet-more"]', `${n} ⋯`); await sleep(100); };
    await more();
    await layout(c, `${n} ⋯ menu`);
    await press(c, '[data-more] [data-act="help"]', `${n} Help`);
    check(`${n} Help opens`, (await openDialogs(c)).includes("data-help"));
    await layout(c, `${n} Help`);
    await c.pg.keyboard.press("Escape"); await sleep(100);
    await more();
    await press(c, '[data-more] [data-act="settings"]:not([data-feed-menu])', `${n} Settings`);
    await sleep(500);
    check(`${n} Settings opens`, (await openDialogs(c)).includes("data-settings"));
    await shot(c, `settings-${v}`);
    await layout(c, `${n} Settings`);
    check(`${n} alarm link`, /^shortcuts:/.test(await c.pg.$eval("[data-alarm]", (a) => a.getAttribute("href"))), await c.pg.$eval("[data-alarm]", (a) => a.getAttribute("href")));
    check(`${n} alarm text`, /Set iPhone alarm for/.test(await text(c, "[data-alarm]")), await text(c, "[data-alarm]"));
    await press(c, '[data-act="oura-week"]', `${n} Sleep this week`);
    await sleep(500);
    check(`${n} Sleep this week opens Oura`, (await openDialogs(c)).includes("data-oura-day"), (await openDialogs(c)).join());
    await press(c, '[data-act="close-oura-day"]', `${n} close Oura`);
    await sleep(100);
    if (!opt.touch) {
      await press(c, '[data-act="settings"][data-feed-alert]', `${n} Feed failed`);
      await sleep(400);
      check(`${n} Feed failed opens Settings`, (await openDialogs(c)).includes("data-settings"));
      await c.pg.keyboard.press("Escape"); await sleep(100);
    }
    await press(c, '[data-act="needs"]', `${n} Needs you`);
    await sleep(300);
    check(`${n} Needs you opens`, (await openDialogs(c)).includes("data-needs"));
    await layout(c, `${n} Needs you`);
    await c.pg.keyboard.press("Escape"); await sleep(100);
    await press(c, '.sheet-oura', `${n} Oura chip`);
    await sleep(300);
    check(`${n} Oura chip opens`, (await openDialogs(c)).includes("data-oura-day"));
    await layout(c, `${n} Oura`);
    await c.pg.keyboard.press("Escape"); await sleep(100);
    clean(c, n);
    await c.pg.close();
    // Shut down, in its window.
    const d = await open({ ...opt, at: "2026-11-04T03:30:00Z" });
    await press(d, '[data-act="shutdown"]', `${n} Shut down`);
    await sleep(400);
    check(`${n} Shut down opens`, (await openDialogs(d)).includes("data-shut"), (await openDialogs(d)).join());
    await shot(d, `shutdown-${v}`);
    await layout(d, `${n} Shut down`);
    clean(d, `${n} shutdown`);
    await d.pg.close();
  };
  scenarios[`links ${v}`] = async (n) => {
    for (const [q, want] of [["plan", "data-plan"], ["needs", "data-needs"], ["bogus", null]]) {
      const c = await open({ ...opt, path: `/plan/?open=${q}` });
      await sleep(400);
      const open_ = await openDialogs(c);
      check(`${n} ?open=${q}`, want ? open_.includes(want) : !open_.length, open_.join());
      check(`${n} ?open=${q} comes off the address`, !(await c.pg.url()).includes("open="));
      clean(c, `${n} ?open=${q}`);
      await c.pg.close();
    }
    const s = await open({ ...opt, path: "/plan/?open=shutdown", at: "2026-11-04T03:30:00Z" });
    await sleep(400);
    check(`${n} ?open=shutdown`, (await openDialogs(s)).includes("data-shut"), (await openDialogs(s)).join());
    await s.pg.close();
    const f = await open({ ...opt, path: "/plan/?focus=b1" });
    await sleep(500);
    check(`${n} ?focus=`, await shown(f, "dialog.sheet-focus"));
    check(`${n} ?focus= comes off the address`, !(await f.pg.url()).includes("focus="));
    clean(f, `${n} ?focus=`);
    await f.pg.close();
  };
  scenarios[`coming back ${v}`] = async (n) => {
    const c = await open(opt);
    const back = async (ms) => {
      await c.pg.evaluate((ms) => { globalThis.__off += ms; document.dispatchEvent(new Event("visibilitychange")); }, ms);
      await sleep(500);
    };
    const reads = () => c.log.filter((l) => l.method === "GET" && l.path === "tasks").length;
    let r0 = reads();
    await back(30_000);
    check(`${n} under a minute reads nothing`, reads() === r0);
    // Telegram finished a task meanwhile.
    c.db.tasks.find((t) => t.id === "t3").done = true;
    await back(61_000);
    check(`${n} past a minute reloads`, reads() > r0);
    check(`${n} shows the change`, await c.pg.$eval('.sheet-task[data-id="t3"]', (x) => x.classList.contains("is-done")));
    // Mid-edit, no reload.
    r0 = reads();
    await press(c, '.sheet-task[data-id="t1"] .sheet-title', `${n} title`);
    await back(61_000);
    check(`${n} keeps an edit in progress`, await shown(c, ".sheet-edit") && reads() === r0);
    await c.pg.keyboard.press("Escape");
    // Overnight: the tab comes back the next morning.
    await back(20 * 3600_000);
    const today = await c.pg.$eval(".sheet-day.is-today", (x) => x.dataset.day).catch(() => null);
    check(`${n} next morning: today moves`, today === "2026-11-04", today);
    const focusDay = await c.pg.evaluate(() => document.querySelector(".sheet-day.is-focus")?.dataset.day);
    check(`${n} next morning: the day on screen follows`, focusDay === "2026-11-04", focusDay);
    clean(c, n);
    await c.pg.close();
  };
}
scenarios["coming back next week"] = async (n) => {
  // Sunday night, back on Monday morning: the week on screen follows too.
  const c = await open({ w: 390, touch: true, at: "2026-11-09T03:00:00Z" });
  await c.pg.evaluate(() => { globalThis.__off += 10 * 3600_000; document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(600);
  check(`${n} shows the new week`, await c.pg.$eval(".sheet-day.is-focus", (x) => x.dataset.day) === "2026-11-09", await c.pg.$eval(".sheet-day.is-focus", (x) => x.dataset.day));
  await c.pg.close();
};
scenarios["drag onto a project's steps"] = async (n) => {
  const c = await open();
  await press(c, ".sheet-project summary", `${n} open`);
  const pos = (sel) => c.pg.evaluate((sel) => { const x = document.querySelector(sel); x.scrollIntoView({ block: "center" }); const r = x.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; }, sel);
  const blocksBefore = c.db.blocks.filter((b) => b.task_id === "t2").length;
  const a = await pos('.sheet-day.is-today .sheet-task[data-id="t2"] .sheet-title');
  await c.pg.mouse.move(a.x, a.y); await c.pg.mouse.down();
  await c.pg.mouse.move(a.x + 10, a.y + 10);
  // Dropping needs both on screen; the page scrolls so the list is in reach.
  const b = await c.pg.evaluate(() => { const r = document.querySelector('.sheet-project .sheet-task[data-id="s2"]').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; });
  await c.pg.mouse.move(b.x, b.y, { steps: 4 }); await c.pg.mouse.up();
  await sleep(400);
  check(`${n} the task stays on its day`, c.db.tasks.find((t) => t.id === "t2").day === "2026-11-03", JSON.stringify(c.db.tasks.find((t) => t.id === "t2").list));
  check(`${n} its blocks stay`, c.db.blocks.filter((x) => x.task_id === "t2").length === blocksBefore, "blocks deleted");
  check(`${n} nothing failed`, !(await shown(c, "[data-status]")), await text(c, "[data-status]"));
  await c.pg.close();
};
scenarios["stale focus session"] = async (n) => {
  const c = await open();
  await press(c, '.sheet-task[data-id="t2"] [data-act="focus-start"]', `${n} Start`);
  await sleep(300);
  await press(c, ".sheet-focus-leave", `${n} leave`);
  // Two days later the task has rolled onto today.
  await c.pg.evaluate(() => { globalThis.__off += 2 * 86400_000; });
  c.db.tasks.find((t) => t.id === "t2").day = "2026-11-05";
  await c.pg.reload({ waitUntil: "networkidle0" });
  await sleep(300);
  const label = await text(c, '.sheet-task[data-id="t2"] [data-act="focus-start"]');
  check(`${n} a day-old session doesn't still count`, !/Resume/.test(label), label);
  await c.pg.close();
};

// Settings you can jump to (research/plan-improvements.md 12).
for (const [v, opt] of VIEWS) {
  scenarios[`settings sections ${v}`] = async (n) => {
    const c = await open(opt);
    const groups = () => c.pg.evaluate(() => Object.fromEntries([...document.querySelectorAll(".sheet-settings-group")].map((g) => [g.dataset.section, g.open])));
    const inView = (sel) => c.pg.evaluate((sel) => { const x = document.querySelector(sel); const d = x.closest("dialog").getBoundingClientRect(); const r = x.getBoundingClientRect(); return r.top >= d.top - 1 && r.top < d.top + d.height / 2; }, sel);
    // Feed failed: the chip on a wide screen, the ⋯ item on a phone.
    if (opt.w > 500) await press(c, "[data-feed-alert]", `${n} Feed failed`);
    else { await press(c, '[popovertarget="sheet-more"]', `${n} ⋯`); await press(c, "[data-feed-menu]", `${n} Feed failed item`); }
    await sleep(500);
    check(`${n} Feed failed opens Settings`, (await openDialogs(c)).includes("data-settings"));
    const g = await groups();
    check(`${n} Status open`, g.status, JSON.stringify(g));
    check(`${n} the rest ${opt.w > 500 ? "open" : "closed"} on this screen`, opt.w > 500 ? g.accounts && g.day && g.claude : !g.accounts && !g.day && !g.claude, JSON.stringify(g));
    check(`${n} Status is in view`, await inView('[data-section="status"].sheet-settings-group'));
    check(`${n} the failed feed is listed`, /Campus events: failed/.test(await text(c, "[data-feeds]")), await text(c, "[data-feeds]"));
    await shot(c, `settings-status-${v}`);
    await layout(c, `${n} at Status`);
    // The index jumps.
    await press(c, '[data-act="settings-go"][data-section="day"]', `${n} index Day`);
    await sleep(300);
    check(`${n} index opens Day`, (await groups()).day);
    check(`${n} Day is in view`, await inView('[data-section="day"].sheet-settings-group'));
    check(`${n} the alarm link is in Day`, await c.pg.$eval("[data-alarm]", (a) => a.closest(".sheet-settings-group").dataset.section === "day" && /^shortcuts:/.test(a.getAttribute("href"))));
    // More opens the full text.
    await press(c, '[aria-labelledby="sheet-habits-title"] .sheet-settings-more summary', `${n} Habits More`);
    check(`${n} More shows the full text`, (await text(c, '[aria-labelledby="sheet-habits-title"] .sheet-settings-more p')).includes("Firm ones go in before tasks"));
    await c.pg.keyboard.press("Escape"); await sleep(200);
    // Calendars, from ⋯: Settings at Accounts, the IDs box filled and focused, Save says so.
    await press(c, '[popovertarget="sheet-more"]', `${n} ⋯`);
    await press(c, '[data-more] [data-act="calendars"]', `${n} Calendars`);
    await sleep(500);
    check(`${n} Calendars opens Accounts`, (await groups()).accounts && (await openDialogs(c)).includes("data-settings"));
    check(`${n} the IDs box is focused`, await c.pg.evaluate(() => document.activeElement?.id === "sheet-cal-ids"));
    await c.pg.keyboard.type("abc@group.calendar.google.com");
    await press(c, '[data-act="save-calendars"]', `${n} Save calendars`);
    await sleep(400);
    check(`${n} calendars saved`, JSON.stringify(c.db.settings[0].calendars) === '["abc@group.calendar.google.com"]', JSON.stringify(c.db.settings[0].calendars));
    check(`${n} Saved note`, (await text(c, "[data-cal-ids-note]")) === "Saved.");
    check(`${n} Settings stays open`, (await openDialogs(c)).includes("data-settings"));
    check(`${n} no Calendars dialog left`, !(await c.pg.$("[data-calendars]")));
    // S opens it plain.
    await c.pg.keyboard.press("Escape"); await sleep(200);
    await c.pg.keyboard.press("s"); await sleep(400);
    const plain = await groups();
    check(`${n} S opens ${opt.w > 500 ? "every group" : "all closed"}`, Object.values(plain).every((x) => x === opt.w > 500), JSON.stringify(plain));
    clean(c, n);
    await c.pg.close();
  };
}

// --- Run -------------------------------------------------------------------------------------
for (const [name, fn] of Object.entries(scenarios)) {
  if (ONLY && !name.includes(ONLY)) continue;
  console.log(`\n# ${name}`);
  try { await fn(name); } catch (e) { check(`${name}: ran to the end`, false, e.message); }
}
await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} of ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
