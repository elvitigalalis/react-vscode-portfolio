// Settings, Calendar (docs/sheet-v5.md, "/plan"): when busy times were last saved, the free/busy
// account with its last error, and Connect or Reconnect, and Disconnect. Connecting goes through
// the calendar-connect Edge Function, which keeps the token in Vault; the browser only ever sees
// the calendar_account row. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { busySaved } from "./freebusy.mjs";
import { actHooks, failed, settingsHooks, state } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

// What calendar-connect's ?calendar=error&reason=… words mean (supabase/functions/calendar-connect).
const REASONS = {
  "not-owner": "you weren't signed in as the owner. Sign in again and retry.",
  "not-owner-account": "that wasn't your own Google account. Pick it on Google's screen.",
  expired: "the sign-in took longer than 10 minutes, or that link was already used. Try again.",
  denied: "Google access was declined.",
  "not-offline": "Google didn't grant lasting access. Try again.",
  "no-freebusy": "the calendar availability permission was unticked. Try again and leave it ticked.",
  "not-set-up": "the calendar connector isn't set up on the server yet.",
};

async function draw() {
  const [account, settings] = await Promise.all([api.calendarAccount(), api.settings()]);
  $("[data-busy-saved]").textContent = busySaved(settings?.busy_as_of ?? state.settings?.busy_as_of, new Date());
  $("[data-cal-account]").textContent = account ? `Connected: ${account.email}` : "Not connected. /plan saves busy times only while it is open.";
  // A grant from before /plan's scopes were added (or with them unticked) saves busy times but
  // can't stand in for /plan's sign-in token (calendar-connect's /token).
  const grant = account && !account.last_error ? await api.calendarGrantStatus() : null;
  $("[data-cal-error]").textContent = account?.last_error ? `Last error: ${account.last_error}. Reconnect to fix.`
    : grant === "needs-scopes" ? "Reconnect to let /plan read events." : "";
  $('[data-act="cal-connect"]').textContent = account ? "Reconnect" : "Connect";
  $('[data-act="cal-disconnect"]').hidden = !account;
}

// As mail-settings.mjs: the function checks the sign-in token, then answers with Google's
// consent URL. The token goes in a header, never a URL.
async function connect() {
  const token = await api.accessToken();
  if (!token) return location.reload();
  try {
    const res = await fetch(`${SHEET.supabaseUrl}/functions/v1/calendar-connect/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.url) return location.assign(out.url);
    say(`The calendar wasn't connected: ${REASONS[out.error] ?? "something went wrong. Try again."}`);
  } catch (e) { failed(e); }
}

async function disconnect() {
  if (!confirm("Disconnect the calendar? The server stops saving busy times and its sign-in is deleted.")) return;
  try {
    await api.deleteCalendarAccount();
    await draw();
    $('[data-act="cal-connect"]').focus();
  } catch (err) { failed(err); }
}

function say(text) {
  const notice = $("[data-mail-notice]");
  notice.textContent = text;
  notice.hidden = false;
}

// calendar-connect sends him back to /plan/?calendar=connected or ?calendar=error&reason=….
function outcome() {
  const q = new URLSearchParams(location.search);
  const cal = q.get("calendar");
  if (!cal) return;
  say(cal === "connected"
    ? "Calendar connected. Busy times are saved every 10 minutes."
    : `The calendar wasn't connected: ${REASONS[q.get("reason")] ?? "something went wrong. Try again."}`);
  history.replaceState(null, "", location.pathname);
}

export function setupCalendarSettings(node) {
  root = node;
  settingsHooks.push(draw);
  actHooks["cal-connect"] = connect;
  actHooks["cal-disconnect"] = disconnect;
  outcome();
}
