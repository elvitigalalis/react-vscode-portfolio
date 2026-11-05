// Settings, Oura (docs/sheet-v5.md, "Oura"): when the ring last synced and when he usually wakes,
// the grant's last error, and Connect or Reconnect, and Disconnect. Connecting goes through the
// oura-connect Edge Function, which keeps the tokens in Vault; the browser only ever sees the
// oura_account row's times and error. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { ouraStatus, wakeProfile } from "./sleep.mjs";
import { actHooks, failed, settingsHooks, state } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

// What oura-connect's ?oura=error&reason=… words mean (supabase/functions/oura-connect).
const REASONS = {
  "not-owner": "you weren't signed in as the owner. Sign in again and retry.",
  expired: "the sign-in took longer than 10 minutes, or that link was already used. Try again.",
  denied: "Oura access was declined.",
  "not-offline": "Oura didn't grant lasting access. Try again.",
  oura: "Oura refused the sign-in. Try again.",
  "not-set-up": "the Oura connector isn't set up on the server yet.",
};

async function draw() {
  const [account, nights] = await Promise.all([api.ouraAccount(), api.listSleep()]);
  state.sleep = nights;
  $("[data-oura-status]").textContent = ouraStatus(account, wakeProfile(nights, new Date(), SHEET.timeZone), new Date());
  // A grant from before workouts were asked for can't read them (oura-sync marks workouts_ok).
  $("[data-oura-error]").textContent = account?.last_error ? `Last error: ${account.last_error}. Reconnect to fix.`
    : account?.workouts_ok === false ? "Reconnect to add workouts, so a ring workout ticks your Gym habit." : "";
  $('[data-act="oura-connect"]').textContent = account ? "Reconnect" : "Connect";
  $('[data-act="oura-disconnect"]').hidden = !account;
}

// As calendar-settings.mjs: the function checks the sign-in token, then answers with Oura's
// consent URL. The token goes in a header, never a URL.
async function connect() {
  const token = await api.accessToken();
  if (!token) return location.reload();
  try {
    const res = await fetch(`${SHEET.supabaseUrl}/functions/v1/oura-connect/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.url) return location.assign(out.url);
    say(`Oura wasn't connected: ${REASONS[out.error] ?? "something went wrong. Try again."}`);
  } catch (e) { failed(e); }
}

async function disconnect() {
  if (!confirm("Disconnect Oura? The plan goes back to starting at 7:00, and every saved sleep time, readiness score and hours slept is deleted.")) return;
  try {
    await api.deleteOuraAccount();
    state.sleep = [];
    await draw();
    $('[data-act="oura-connect"]').focus();
  } catch (err) { failed(err); }
}

function say(text) {
  const notice = $("[data-mail-notice]");
  notice.textContent = text;
  notice.hidden = false;
}

// oura-connect sends him back to /plan/?oura=connected or ?oura=error&reason=….
function outcome() {
  const q = new URLSearchParams(location.search);
  const oura = q.get("oura");
  if (!oura) return;
  say(oura === "connected"
    ? "Oura connected. Your sleep times sync every 10 minutes, once the Oura app has synced your ring."
    : `Oura wasn't connected: ${REASONS[q.get("reason")] ?? "something went wrong. Try again."}`);
  history.replaceState(null, "", location.pathname);
}

export function setupOuraSettings(node) {
  root = node;
  settingsHooks.push(draw);
  actHooks["oura-connect"] = connect;
  actHooks["oura-disconnect"] = disconnect;
  outcome();
}
