// The message box on /plan (docs/sheet-messages.md): Lisul types a plain line to Claude ("dentist
// Thu 3pm"), it goes to the message Edge Function, and the morning task answers it with tasks and
// events. The box shows each message sent from this tab with "Sending to Claude…", then polls its
// row (every 5 s, at most 3 min, only while the tab is visible) for the reply. An answered
// message's events go into Google Calendar from here, since the Google token lives only in the
// browser (ADR 0001): on the reply, and on load for any left over from a closed tab.
// Text goes in through textContent only.
import * as api from "./api.mjs";
import { addedLine } from "./messages.mjs";
import { el, load, failed } from "./planner.mjs";

const POLL_MS = 5_000;
const POLL_FOR_MS = 3 * 60_000;

let form, input, log;

export function setupMessages(root) {
  form = root.querySelector("[data-message-form]");
  input = form.querySelector("input");
  log = root.querySelector("[data-message-log]");
  form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  // Only the owner gets a settings row; anyone else signed in sees no box.
  api.settings().then((row) => {
    if (!row) return;
    form.hidden = false;
    return createLeftovers();
  }).catch((e) => console.error(e));
}

const SENT = {
  true: "Sent. Claude is on it…",
  batched: "Sent. Claude is already reading your messages and takes this one too…",
  rate_limited: "Saved. Claude is busy right now and picks it up on its next run.",
};

async function send() {
  const text = input.value.replace(/\s+/g, " ").trim();
  if (!text) return;
  input.value = "";
  const status = el("span", { className: "sheet-message-status", textContent: "Sending to Claude…" });
  const li = el("li", {}, el("span", { className: "sheet-message-text", textContent: text }), " ", status);
  log.prepend(li);
  let out;
  try {
    out = await api.sendMessage(text);
  } catch (e) {
    console.error(e);
    status.textContent = "Not sent. Try again.";
    input.value ||= text;
    return;
  }
  status.textContent = SENT[out.fired ? "true" : out.why] ?? "Saved. Claude picks it up on its next run.";
  if (out.fired || out.why === "batched") poll(out.id, li, status);
}

// Polls the message's row until it is answered, the 3 minutes run out, or the tab is closed.
function poll(id, li, status) {
  const until = Date.now() + POLL_FOR_MS;
  const tick = async () => {
    if (Date.now() > until) {
      status.textContent = "No answer yet. Claude adds it on its next run.";
      return;
    }
    if (document.visibilityState === "visible") {
      try {
        const m = await api.getMessage(id);
        if (m && m.status !== "pending") return answered(m, li, status);
      } catch (e) { console.error(e); }
    }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}

async function answered(m, li, status) {
  status.textContent = addedLine(m);
  if (m.reply) li.append(el("span", { className: "sheet-message-reply", textContent: m.reply }));
  if (m.status !== "done") return;
  await createEvents(m);
  if (m.tasks_added) await load().catch(failed);
}

// The message's events in the Time blocks calendar, as private ("Busy") events, once: the claim
// flips created_in_calendar first, so a second tab finds nothing to do. Without Google access
// they wait for a load that has it. A create that fails before any event is made gives the claim
// back; after one, the rest are dropped rather than risk a copy.
async function createEvents(m) {
  if (!m.events?.length || m.created_in_calendar || !api.googleReady()) return;
  try {
    if (!(await api.claimEvents(m.id))) return;
  } catch (e) { return console.error(e); }
  let made = 0;
  try {
    for (const e of m.events) { await api.createEvent(e.title, false, e.starts_at, e.ends_at); made++; }
  } catch (e) {
    console.error(e);
    if (!made) await api.unclaimEvents(m.id).catch(() => {});
  }
}

async function createLeftovers() {
  if (!api.googleReady()) return;
  for (const m of await api.uncreatedMessages()) await createEvents(m);
}
