// Needs you in /plan (docs/sheet-morning.md, "/plan"): mail the morning task found waiting on
// Lisul. A top-bar chip with the count, shown while any row isn't done, opens a dialog (also M)
// grouped by kind, where each row opens in Gmail or is marked done. Mail text is untrusted: every
// field goes in through textContent, and only a Gmail link becomes a link.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { dueLabel, localNow } from "./logic.mjs";
import { el, icon, state, renderHooks, keyHooks, actHooks, offerUndo, failed } from "./planner.mjs";
import { needsGroups, gmailLink } from "./morning.mjs";

let root, dialog;
let rows = [];          // needs_you rows not done when read; Done flips them here too
let names = new Map();  // account email → its label, or the email
let note = null;        // "Done: …", while its undo lasts

async function refresh() {
  const [needs, accounts] = await Promise.all([api.listNeeds(), api.listMailAccounts().catch(() => [])]);
  rows = needs;
  names = new Map(accounts.map((a) => [a.email, a.label || a.email]));
  draw();
}

// The chip: the mail icon and "Needs you · 3". Phones hide the words and keep the count.
function chip() {
  const n = rows.filter((r) => !r.done).length;
  const b = root.querySelector("[data-needs-chip]");
  b.hidden = !n;
  b.querySelector("[data-needs-n]").textContent = ` ${n}`;
  b.ariaLabel = `Needs you · ${n}`;
}

function item(r) {
  const link = gmailLink(r.link);
  const done = el("button", { type: "button", className: "sheet-btn", ariaLabel: `Done: ${r.subject}` }, icon("check"), " Done");
  done.dataset.needDone = r.id;
  const today = state.today ?? localNow(new Date(), SHEET.timeZone).day;
  return el("li", { className: "sheet-needs-item" },
    el("p", { className: "sheet-needs-head" }, el("strong", { textContent: r.sender }), " · ", el("span", { textContent: r.subject })),
    el("p", { className: "sheet-needs-why", textContent: r.why }),
    el("p", { className: "sheet-meta", textContent: [names.get(r.account) ?? r.account, r.due && dueLabel(r.due, today)].filter(Boolean).join(" · ") }),
    el("p", { className: "sheet-needs-acts" },
      link ? el("a", { className: "sheet-link", href: link, target: "_blank", rel: "noopener noreferrer", textContent: "Open in Gmail" }) : null,
      done));
}

// The page's toast sits behind the modal dialog, so the dialog offers the same undo.
function undoButton() {
  const b = el("button", { type: "button", className: "sheet-link", textContent: "Undo" });
  b.dataset.act = "undo";
  return b;
}

function draw() {
  chip();
  if (!dialog.open) return;
  const groups = needsGroups(rows);
  dialog.replaceChildren(...[
    el("h2", { id: "sheet-needs-title", textContent: "Needs you" }),
    note ? el("p", { className: "sheet-notice", role: "status" }, note, " ", undoButton()) : null,
    groups.length ? null : el("p", { className: "sheet-notice", textContent: "Nothing needs you right now." }),
    ...groups.map((g) => el("section", { className: "sheet-needs-group" },
      el("h3", { textContent: g.title }),
      el("ul", { className: "sheet-needs-list" }, ...g.rows.map(item)))),
    el("form", { method: "dialog", className: "sheet-dialog-end" }, el("button", { type: "submit", className: "sheet-btn", textContent: "Close" })),
  ].filter(Boolean));
}

async function open() {
  dialog.showModal();
  draw();
  try { await refresh(); } catch (e) { failed(e); }
}

async function markDone(id) {
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  try {
    await api.setNeedDone(id, true);
    r.done = true;
    note = `Done: ${r.subject}`;
    offerUndo(note, async () => { await api.setNeedDone(id, false); r.done = false; note = null; });
  } catch (e) { failed(e); }
  draw();
  (dialog.querySelector("[data-need-done]") ?? dialog.querySelector(".sheet-btn"))?.focus();
}

export function setupNeedsYou(node) {
  root = node;
  dialog = root.querySelector("[data-needs]");
  renderHooks.push(draw);
  actHooks.needs = () => open();
  keyHooks.push((e) => { if (e.key === "m" || e.key === "M") { open(); return true; } return false; });
  dialog.addEventListener("click", (e) => {
    const b = e.target.closest("[data-need-done]");
    if (b) markDone(b.dataset.needDone);
  });
  dialog.addEventListener("close", () => { note = null; });
  refresh().catch(console.error);
}
