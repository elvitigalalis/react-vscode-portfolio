// The message box on /plan (docs/sheet-messages.md): Lisul types a line to Claude ("dentist Thu
// 3pm") or pastes a long one (a class announcement), it goes to the message Edge Function, and the
// morning task answers it with tasks and events. Under the box, a collapsible Recent list keeps
// the newest 10 messages, from the table, so what happened survives a reload: each with where it
// stands (Sending, Claude is reading, Queued, Added, Couldn't parse), Claude's reply, and every
// to-do and event it added, each with an Undo. While Claude works it shows the time since the fire
// and the run's steps (progress), with a link to the run on claude.ai; once answered they fold
// into "4 steps · 52 s · How Claude decided", with Claude's note on each item. A message being read is polled (every 5 s, at most
// 6 min, only while the tab is visible). An answered message's events go into Google Calendar from
// here, since the Google token lives only in the browser (ADR 0001): on the reply, and on load for
// any left over from a closed tab. Text goes in through textContent only.
import * as api from "./api.mjs";
import { itemLines, MAX_TEXT, messageState, messageText, progress } from "./messages.mjs";
import { SHEET } from "../site.mjs";
import { dropBlocks, el, load, failed } from "./planner.mjs";

const POLL_MS = 5_000;
const POLL_FOR_MS = 6 * 60_000;
const RECENT = 10;

let form, input, count, recent, log;
// The rows shown, newest first; a message being sent has none yet.
let rows = [];

// The box grows with its text, up to the CSS max-height, and says how much room is left.
function grow() {
  input.style.height = "auto";
  if (input.value) input.style.height = `${input.scrollHeight}px`;
  count.textContent = `${(MAX_TEXT - input.value.length).toLocaleString("en-US")} characters left`;
}

export function setupMessages(root) {
  form = root.querySelector("[data-message-form]");
  input = form.querySelector("textarea");
  count = form.querySelector("[data-message-count]");
  recent = root.querySelector("[data-message-recent]");
  log = root.querySelector("[data-message-log]");
  form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  // A textarea, since pasted announcements run many lines: Enter adds a line, and Cmd or Ctrl
  // with Enter sends, as the Send button does (the only way on a phone).
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", grow);
  grow();
  // The running timers, counted here each second; the steps come with each poll.
  setInterval(() => {
    for (const span of log.querySelectorAll(".sheet-message-elapsed")) {
      const m = rows.find((r) => r.id === span.closest("[data-id]")?.dataset.id);
      const p = m && progress(m, new Date());
      if (p?.running && p.elapsed) span.textContent = p.elapsed;
    }
  }, 1000);
  // Only the owner gets a settings row; anyone else signed in sees no box.
  api.settings().then(async (row) => {
    if (!row) return;
    form.hidden = false;
    rows = await api.recentMessages();
    showAll();
    // The list starts closed; sending a message opens it (send).
    for (const m of rows) if (messageState(m, rows, new Date()).key === "reading") poll(m.id);
    return createLeftovers();
  }).catch((e) => console.error(e));
}

const SENT = {
  true: "Claude is reading…",
  batched: "Claude is reading…",
  rate_limited: "Queued: Claude is busy, so this runs with the next plan.",
};

async function send() {
  const text = messageText(input.value);
  if (!text) return;
  input.value = "";
  grow();
  recent.hidden = false;
  recent.open = true;
  const li = el("li", { className: "sheet-message-item" });
  log.prepend(li);
  draw(li, { text, status: "sending" }, "Sending to Claude…");
  let out;
  try {
    out = await api.sendMessage(text);
  } catch (e) {
    console.error(e);
    draw(li, { text, status: "sending" }, "Not sent. Try again.");
    input.value ||= text;
    grow();
    return;
  }
  const fired = out.fired ? new Date().toISOString() : null;
  const m = { id: out.id, at: out.at, text, status: "pending", fired_at: fired, tasks: [], events: [],
    steps: fired ? [{ at: fired, kind: "started", text: "Started Claude" }] : [] };
  rows = [m, ...rows].slice(0, RECENT);
  li.dataset.id = m.id;
  draw(li, m, SENT[out.fired ? "true" : out.why] ?? "Queued: this runs with the next plan.");
  while (log.children.length > RECENT) log.lastElementChild.remove();
  if (out.fired || out.why === "batched") poll(m.id);
}

// The whole list, from rows.
function showAll() {
  log.replaceChildren(...rows.map((m) => {
    const li = el("li", { className: "sheet-message-item" });
    li.dataset.id = m.id;
    draw(li, m);
    return li;
  }));
  recent.hidden = !rows.length;
}

// One message: its text (long ones folded), where it stands, the reply, and what it added.
// words and key, when given, say where it stands instead of its row (sending, or "late" once
// polling gives up).
function draw(li, m, words = messageState(m, rows, new Date()).words, key = m.status === "sending" ? "sending" : messageState(m, rows, new Date()).key) {
  const text = el("p", { className: "sheet-message-text", textContent: m.text });
  const long = m.text.length > 160 || m.text.split("\n").length > 2;
  if (long) text.classList.add("is-folded");
  li.replaceChildren(...[
    text,
    long ? el("button", { type: "button", className: "sheet-link sheet-message-more", textContent: "Show all", onclick: (e) => {
      const folded = text.classList.toggle("is-folded");
      e.target.textContent = folded ? "Show all" : "Show less";
      e.target.setAttribute("aria-expanded", String(!folded));
    } }) : null,
    el("p", { className: `sheet-message-status is-${key}`, textContent: words }, key === "reading" ? timer(m) : null),
    key === "reading" ? running(m) : null,
    m.reply ? el("p", { className: `sheet-message-reply is-${key}`, textContent: m.reply }) : null,
    items(m),
    key === "added" || key === "unparsed" ? decided(m) : null,
    m.session_url && key !== "sending" ? el("a", { className: "sheet-message-run", href: m.session_url, target: "_blank", rel: "noopener", textContent: "Open the run" }) : null,
  ].filter(Boolean));
  li.querySelector(".sheet-message-more")?.setAttribute("aria-expanded", "false");
}

// The time since the fire, beside "Claude is reading…".
function timer(m) {
  const p = progress(m, new Date());
  return p?.elapsed ? el("span", { className: "sheet-message-elapsed", textContent: p.elapsed, ariaHidden: "true" }) : null;
}

// While Claude works: its steps, ticked, the newest current, and a note when it is slow.
function running(m) {
  const p = progress(m, new Date());
  if (!p?.running) return null;
  const box = el("div", { className: "sheet-message-progress" },
    p.steps.length ? stepList(p.steps) : null,
    p.note ? el("p", { className: "sheet-message-note", textContent: p.note }) : null);
  return box;
}

const stepList = (steps) => el("ol", { className: "sheet-message-steps" }, ...steps.map((x) =>
  el("li", { className: x.done ? "is-done" : "is-current" },
    el("span", { className: "sheet-message-tick", textContent: x.done ? "✓" : "●", ariaHidden: "true" }), " ",
    x.text, x.done ? null : el("span", { className: "visually-hidden", textContent: " (now)" }))));

// Once answered: the steps folded into one line, and Claude's note on each item it added.
function decided(m) {
  const p = progress(m, new Date());
  const notes = itemLines(m, SHEET.timeZone).filter((l) => l.why);
  if (!p && !notes.length) return null;
  const summary = [p?.summary, notes.length ? "How Claude decided" : null].filter(Boolean).join(" · ");
  return el("details", { className: "sheet-message-decided" },
    el("summary", { textContent: summary }),
    notes.length ? el("ul", { className: "sheet-message-notes", ariaLabel: "Claude's notes" }, ...notes.map((l) =>
      el("li", {}, el("span", { className: "sheet-message-title", textContent: l.title }), ": ", l.why))) : null,
    p ? stepList(p.steps) : null);
}

// Each to-do and event the message added, with an Undo.
function items(m) {
  const lines = m.status === "done" ? itemLines(m, SHEET.timeZone) : [];
  if (!lines.length) return null;
  return el("ul", { className: "sheet-message-added", ariaLabel: "Added" }, ...lines.map((line) => {
    const undo = line.id && el("button", { type: "button", className: "sheet-link", textContent: "Undo", ariaLabel: `Undo ${line.kind === "task" ? "to-do" : "event"}: ${line.title}` });
    const li = el("li", {},
      el("span", { className: "sheet-message-kind", textContent: line.kind === "task" ? "To-do" : "Event" }), " ",
      el("span", { className: "sheet-message-title", textContent: line.title }), " ",
      el("span", { className: "sheet-message-when", textContent: line.when }), " ",
      undo);
    if (undo) undo.onclick = () => undoItem(m, line, li, undo);
    return li;
  }));
}

// Undo one item: a to-do is deleted (its calendar blocks first); an event comes out of Google
// Calendar when /plan made it there, then off the message and out of busy (undo_message_item).
async function undoItem(m, line, li, button) {
  button.disabled = true;
  try {
    if (line.kind === "task") await dropBlocks(line.id);
    else {
      const ev = m.events.find((e) => e.id === line.id);
      if (ev?.gcal_id) {
        if (!api.googleReady()) {
          button.disabled = false;
          return li.append(el("span", { className: "sheet-message-note", textContent: " Sign in again with Google to undo this event." }));
        }
        // Gone already (deleted in Google) is fine.
        await api.deleteEvent(ev.gcal_id).catch((e) => { if (!/: 4(04|10)$/.test(e.message)) throw e; });
      }
    }
    await api.undoMessageItem(m.id, line.id);
    const fresh = await api.getMessage(m.id);
    if (fresh) Object.assign(m, fresh);
    const row = li.closest(".sheet-message-item");
    draw(row, m);
    row.querySelector(".sheet-message-status").after(el("p", { className: "sheet-message-note", role: "status", textContent: `Undone: ${line.title}` }));
    await load().catch(failed);
  } catch (e) {
    button.disabled = false;
    failed(e);
  }
}

// Polls the message's row until it is answered, the 6 minutes run out, or the tab is closed.
function poll(id) {
  const until = Date.now() + POLL_FOR_MS;
  const tick = async () => {
    const li = log.querySelector(`[data-id="${id}"]`);
    if (!li) return;
    if (Date.now() > until) {
      const m = rows.find((r) => r.id === id) ?? { text: "", status: "pending" };
      return draw(li, m, "No answer yet. Open the run to see what happened, or it's picked up on the next run.", "late");
    }
    if (document.visibilityState === "visible") {
      try {
        const m = await api.getMessage(id);
        if (m && m.status !== "pending") return answered(m, li);
        // New steps: draw them, keeping a long message unfolded if he opened it.
        const was = rows.find((r) => r.id === id);
        const seen = (r) => r && JSON.stringify([r.steps, r.session_url, progress(r, new Date())?.note]);
        if (m && (seen(m) !== li.dataset.seen || !was)) {
          li.dataset.seen = seen(m);
          rows = rows.map((r) => (r.id === id ? m : r));
          const open = li.querySelector(".sheet-message-text:not(.is-folded)") && li.querySelector(".sheet-message-more");
          draw(li, m);
          if (open) li.querySelector(".sheet-message-more").click();
        }
      } catch (e) { console.error(e); }
    }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}

async function answered(m, li) {
  rows = rows.map((r) => (r.id === m.id ? m : r));
  draw(li, m);
  if (m.status !== "done") return;
  await createEvents(m);
  if (m.tasks_added) await load().catch(failed);
}

// The message's events in the Time blocks calendar, with their titles and Google's private
// visibility (createMessageEvent), once: the claim flips created_in_calendar first, so a second
// tab finds nothing to do, and each event's Google id is kept for its Undo. Without Google access
// they wait for a load that has it. A create that fails before any event is made gives the claim
// back; after one, the rest are dropped rather than risk a copy.
async function createEvents(m) {
  if (!m.events?.length || m.created_in_calendar || !api.googleReady()) return;
  try {
    if (!(await api.claimEvents(m.id))) return;
  } catch (e) { return console.error(e); }
  let made = 0;
  try {
    for (const e of m.events) {
      const gcal = await api.createMessageEvent(e.title, e.starts_at, e.ends_at);
      made++;
      if (e.id) { e.gcal_id = gcal; await api.messageEventCreated(m.id, e.id, gcal); }
    }
  } catch (e) {
    console.error(e);
    if (!made) await api.unclaimEvents(m.id).catch(() => {});
  }
}

async function createLeftovers() {
  if (!api.googleReady()) return;
  for (const m of await api.uncreatedMessages()) await createEvents(m);
}
