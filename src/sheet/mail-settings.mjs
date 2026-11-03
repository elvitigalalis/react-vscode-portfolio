// Settings, mail accounts (docs/sheet-sources.md, "/plan"): the accounts Claude reads during
// "plan my day", each with its last error, plus Connect an account and Remove. Connecting goes
// through the mail-connect Edge Function, which keeps each account's token in Vault; the browser
// only ever sees the mail_accounts rows. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { actHooks, failed } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

// What mail-connect's ?mail=error&reason=… words mean (supabase/functions/mail-connect).
const REASONS = {
  "not-owner": "you weren't signed in as the owner. Sign in again and retry.",
  expired: "the sign-in took longer than 10 minutes. Try again.",
  denied: "Google access was declined.",
  "not-offline": "Google didn't grant lasting access. Try again.",
  "no-gmail": "the Gmail permission was unticked. Try again and leave it ticked.",
  "not-set-up": "the mail connector isn't set up on the server yet.",
};

async function draw() {
  const list = $("[data-mail-accounts]");
  const rows = await api.listMailAccounts();
  list.replaceChildren(...rows.map((a) => {
    const li = $("[data-mail-row]").content.firstElementChild.cloneNode(true);
    li.dataset.id = a.id;
    li.querySelector("[data-mail-name]").textContent = a.label ? `${a.label} (${a.email})` : a.email;
    li.querySelector("[data-mail-error]").textContent = a.last_error ? `Last error: ${a.last_error}. Connect it again to fix.` : "";
    const remove = li.querySelector('[data-act="mail-remove"]');
    remove.dataset.email = a.email;
    remove.setAttribute("aria-label", `Remove ${a.email}`);
    return li;
  }));
  if (!rows.length) list.append(Object.assign(document.createElement("li"), { className: "small", textContent: "No accounts yet." }));
}

async function open() {
  $("[data-settings]").showModal();
  try { await draw(); } catch (e) { failed(e); }
}

// The function checks the access_token is the owner's before sending him to Google; it leaves
// this page, so the token goes in the query (it is not a header the browser can add here).
async function connect() {
  const token = await api.accessToken();
  if (!token) return location.reload();
  location.assign(`${SHEET.supabaseUrl}/functions/v1/mail-connect/start?access_token=${encodeURIComponent(token)}`);
}

async function remove(e) {
  const button = e.target.closest("[data-act]");
  const email = button.dataset.email;
  if (!confirm(`Remove ${email}? Claude stops reading it and its sign-in is deleted.`)) return;
  try {
    await api.deleteMailAccount(button.closest("li").dataset.id);
    await draw();
    $('[data-act="mail-connect"]').focus();
  } catch (err) { failed(err); }
}

// mail-connect sends him back to /plan/?mail=connected or ?mail=error&reason=…; say which, then
// clean the URL.
function outcome() {
  const q = new URLSearchParams(location.search);
  const mail = q.get("mail");
  if (!mail) return;
  const notice = $("[data-mail-notice]");
  notice.textContent = mail === "connected"
    ? "Mail account connected."
    : `The mail account wasn't connected: ${REASONS[q.get("reason")] ?? "something went wrong. Try again."}`;
  notice.hidden = false;
  history.replaceState(null, "", location.pathname);
}

export function setupMailSettings(node) {
  root = node;
  actHooks.settings = open;
  actHooks["mail-connect"] = connect;
  actHooks["mail-remove"] = remove;
  outcome();
}
