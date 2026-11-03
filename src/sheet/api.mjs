// The Sheet's network side: Supabase Auth and REST through plain fetch (no client library), and
// Google Calendar with the Google token Supabase hands back at sign-in (docs/sheet.md).
import { SHEET } from "../site.mjs";
import { blockReminders } from "./logic.mjs";

export const configured = Boolean(SHEET.supabaseUrl && SHEET.anonKey);

const SCOPES = "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.events.readonly";
// The top bar (src/components/Header.astro) reads this key too, to show the owner a Plan link.
const KEY = "sheet.session";
// Google access tokens last an hour; treat them as stale a few minutes early.
const GOOGLE_TTL = 55 * 60 * 1000;

// --- Session -----------------------------------------------------------------------------

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = (s) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {} };

export function signIn() {
  const q = new URLSearchParams({ provider: "google", redirect_to: `${location.origin}/plan/`, scopes: SCOPES });
  location.assign(`${SHEET.supabaseUrl}/auth/v1/authorize?${q}`);
}

export function signOut() { save(null); }

// After the Google redirect the tokens arrive in the URL fragment; keep them and clean the URL.
export function takeRedirect() {
  if (!location.hash.includes("access_token=")) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const now = Date.now();
  save({
    access_token: h.get("access_token"),
    refresh_token: h.get("refresh_token"),
    expires_at: now + Number(h.get("expires_in") ?? 3600) * 1000,
    provider_token: h.get("provider_token"),
    provider_expires_at: h.get("provider_token") ? now + GOOGLE_TTL : 0,
  });
  history.replaceState(null, "", location.pathname);
}

async function session() {
  const s = read();
  if (!s) return null;
  if (Date.now() < s.expires_at - 60_000) return s;
  const res = await fetch(`${SHEET.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SHEET.anonKey, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok) { save(null); return null; }
  const t = await res.json();
  const next = { ...s, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  save(next);
  return next;
}

export const signedIn = async () => Boolean(await session());
export const googleReady = () => { const s = read(); return Boolean(s?.provider_token && Date.now() < s.provider_expires_at); };

// --- Supabase REST -----------------------------------------------------------------------

export class SheetError extends Error {}

async function rest(path, { method = "GET", body, prefer, anon = false } = {}) {
  const s = anon ? null : await session();
  const res = await fetch(`${SHEET.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SHEET.anonKey,
      // Visitors send only the project key, which works for both legacy anon keys and the
      // newer publishable keys (those cannot be sent as a Bearer token).
      ...(s ? { authorization: `Bearer ${s.access_token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new SheetError(`${method} ${path.split("?")[0]}: ${res.status}`);
  // Writes without return=representation answer 201 or 204 with an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Public views, readable by anyone.
export const publicWeek = (from, to) => rest(`public_week?day=gte.${from}&day=lte.${to}&order=day,position`, { anon: true });
export const publicDays = (from, to) => rest(`public_days?day=gte.${from}&day=lte.${to}`, { anon: true });
export const publicNow = async () => (await rest("public_now", { anon: true }))[0] ?? null;

// Owner tables.
export const listTasks = (from, to) => rest(`tasks?or=(day.is.null,and(day.gte.${from},day.lte.${to}))&order=position`);
export const listBlocks = (from, to) => rest(`blocks?starts_at=gte.${from}&starts_at=lt.${to}&order=starts_at`);
// The approved blocks with a Google event that start at or after `from`.
export const eventBlocksFrom = (from) => rest(`blocks?starts_at=gte.${from}&proposed=is.false&gcal_id=not.is.null`);
export const listDays = (from, to) => rest(`days?day=gte.${from}&day=lte.${to}`);
export const parkedOn = (day) => rest(`tasks?select=id&parked_on=eq.${day}`);
export const settings = async () => (await rest("settings"))[0] ?? null;

const one = (rows) => rows[0];
export const insertTask = async (task) => one(await rest("tasks", { method: "POST", body: task, prefer: "return=representation" }));
export const updateTask = async (id, patch) => one(await rest(`tasks?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=representation" }));
export const deleteTask = (id) => rest(`tasks?id=eq.${id}`, { method: "DELETE" });
export const insertBlock = async (block) => one(await rest("blocks", { method: "POST", body: block, prefer: "return=representation" }));
export const updateBlock = async (id, patch) => one(await rest(`blocks?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=representation" }));
export const deleteBlock = (id) => rest(`blocks?id=eq.${id}`, { method: "DELETE" });
export const upsertDay = (day, patch) => rest("days", { method: "POST", body: { day, ...patch }, prefer: "resolution=merge-duplicates" });
// A save also updates the row the Google calls below read, so a switch takes effect at once.
export async function saveSettings(patch) {
  await rest("settings?id=eq.true", { method: "PATCH", body: patch });
  if (settingsRow) Object.assign(settingsRow, patch);
}
export const shutDown = (d, reflection) => rest("rpc/shut_down", { method: "POST", body: { d, reflection } });
// Google edits a Telegram tap left for the browser (supabase/schema.sql, gcal_pending).
export const listGcalPending = () => rest("gcal_pending");
export const clearGcalPending = (gcalId) => rest(`gcal_pending?gcal_id=eq.${encodeURIComponent(gcalId)}`, { method: "DELETE" });

// --- Google Calendar ---------------------------------------------------------------------

const GCAL = "https://www.googleapis.com/calendar/v3";

async function google(path, { method = "GET", body } = {}) {
  const s = read();
  if (!googleReady()) throw new SheetError("google: signed out");
  const res = await fetch(`${GCAL}/${path}`, {
    method,
    headers: { authorization: `Bearer ${s.provider_token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { save({ ...s, provider_expires_at: 0 }); throw new SheetError("google: signed out"); }
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new SheetError(`google ${method}: ${res.status}`);
  return res.status === 204 || method === "DELETE" ? null : res.json();
}

// His events between two instants, from his main calendar and any extra calendars he added.
// Only his browser reads them; they are never saved. An extra calendar that fails is skipped.
// "busy" is false for events Google marks as free; those don't take time from the day.
export async function calendarEvents(fromIso, toIso, extra = []) {
  const q = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: "true", orderBy: "startTime" });
  const lists = await Promise.all(["primary", ...extra].map(async (id) => {
    try { return (await google(`calendars/${encodeURIComponent(id)}/events?${q}`)).items ?? []; }
    catch (e) { if (id === "primary") throw e; console.error(e); return []; }
  }));
  // The same event can sit on two calendars he reads; show it once.
  const seen = new Set();
  return lists.flat().filter((e) => {
    const key = `${e.iCalUID}|${e.start?.dateTime ?? e.start?.date}`;
    if (e.status === "cancelled" || !e.start || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((e) => ({
    title: e.summary ?? "Busy",
    allDay: !e.start.dateTime,
    busy: e.transparency !== "transparent",
    starts_at: e.start.dateTime ?? e.start.date,
    ends_at: e.end.dateTime ?? e.end.date,
    link: e.htmlLink ?? null,
  }));
}

// The settings row, read once; saveSettings keeps it current.
let settingsRow;
// The "Time blocks" calendar, created on first use and remembered in settings.
let calendarId = null;
const settingsOnce = async () => (settingsRow ??= await settings());
async function blocksCalendar() {
  if (calendarId) return calendarId;
  calendarId = (await settingsOnce())?.gcal_calendar_id ?? null;
  if (calendarId) return calendarId;
  const cal = await google("calendars", { method: "POST", body: { summary: "Time blocks", timeZone: SHEET.timeZone } });
  calendarId = cal.id;
  await saveSettings({ gcal_calendar_id: calendarId });
  return calendarId;
}

// A private task's block is titled "Busy" in Google. It has no alerts while Telegram nudges him.
const eventBody = (title, isPublic, starts_at, ends_at, reminders) => ({
  summary: isPublic ? title : "Busy",
  ...eventTimes(starts_at, ends_at),
  reminders,
});

export async function createEvent(title, isPublic, starts_at, ends_at) {
  const cal = await blocksCalendar();
  const body = eventBody(title, isPublic, starts_at, ends_at, blockReminders(await settingsOnce()));
  const ev = await google(`calendars/${encodeURIComponent(cal)}/events`, { method: "POST", body });
  return ev.id;
}

export async function patchEvent(id, patch) {
  await google(`calendars/${encodeURIComponent(await blocksCalendar())}/events/${id}`, { method: "PATCH", body: patch });
}

export async function deleteEvent(id) {
  await google(`calendars/${encodeURIComponent(await blocksCalendar())}/events/${id}`, { method: "DELETE" });
}

// An event's times; a null start leaves the start as it is.
export const eventTimes = (starts_at, ends_at) => ({ ...(starts_at && { start: { dateTime: starts_at } }), end: { dateTime: ends_at } });
export const eventTitle = (title, isPublic) => ({ summary: isPublic ? title : "Busy" });
export const eventReminders = (settings) => ({ reminders: blockReminders(settings) });
