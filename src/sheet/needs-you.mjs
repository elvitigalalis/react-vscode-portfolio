// Needs you in /plan (docs/sheet-morning.md, "/plan"): mail the morning task found waiting on
// Lisul. A top-bar chip with the count, shown while any row isn't done, opens a dialog (also M)
// grouped by kind, where each row opens in Gmail or is marked done. Mail text is untrusted: every
// field goes in through textContent, and only a Gmail link becomes a link.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { dueLabel, localNow } from "./logic.mjs";
import { el, icon, state, renderHooks, keyHooks, actHooks, offerUndo, failed } from "./planner.mjs";
import { needsGroups, gmailLink } from "./morning.mjs";
import { needsFeedback, neverOffers } from "./triage.mjs";

let root, dialog;
let rows = [];          // needs_you rows not done when read; Done flips them here too
let names = new Map();  // account email → its label, or the email
let note = null;        // "Done: …", while its undo lasts
let offers = [];        // v5 L1: From addresses to offer a never-show rule for

async function refresh() {
  const [needs, accounts] = await Promise.all([api.listNeeds(), api.listMailAccounts().catch(() => [])]);
  rows = needs;
  names = new Map(accounts.map((a) => [a.email, a.label || a.email]));
  draw();
  if (dialog.open) await refreshOffers();
}

// v5 L1: after two Not needed from one sender, "Never show mail from <address>", which adds a
// never rule once he confirms. Without the log or the rules, no offer.
async function refreshOffers() {
  try {
    const [feedback, rules] = await Promise.all([api.listNeedsFeedback(), api.listTriageRules()]);
    offers = neverOffers(feedback, rules);
  } catch (e) { console.error(e); offers = []; }
  draw();
}

// The chip: the mail icon and "Needs you · 3". Phones hide the words and keep the count.
function chip() {
  const n = rows.filter((r) => !r.done).length;
  const b = root.querySelector("[data-needs-chip]");
  b.hidden = !n;
  b.querySelector("[data-needs-n]").textContent = String(n);
  b.ariaLabel = `Needs you · ${n}`;
}

function item(r) {
  const link = gmailLink(r.link);
  const done = el("button", { type: "button", className: "sheet-btn", ariaLabel: `Done: ${r.subject}` }, icon("check"), " Done");
  done.dataset.needDone = r.id;
  // v5 L1: Not needed is done as well, and teaches the planner what isn't worth showing.
  const skip = el("button", { type: "button", className: "sheet-link", ariaLabel: `Not needed: ${r.subject}`, textContent: "Not needed" });
  skip.dataset.needSkip = r.id;
  const today = state.today ?? localNow(new Date(), SHEET.timeZone).day;
  return el("li", { className: "sheet-needs-item" },
    el("p", { className: "sheet-needs-head" }, el("strong", { textContent: r.sender }), " · ", el("span", { textContent: r.subject })),
    el("p", { className: "sheet-needs-why", textContent: r.why }),
    el("p", { className: "sheet-meta", textContent: [names.get(r.account) ?? r.account, r.due && dueLabel(r.due, today)].filter(Boolean).join(" · ") }),
    el("p", { className: "sheet-needs-acts" },
      link ? el("a", { className: "sheet-link", href: link, target: "_blank", rel: "noopener noreferrer", textContent: "Open in Gmail" }) : null,
      done, " ", skip));
}

function offerLine(address) {
  const b = el("button", { type: "button", className: "sheet-btn", textContent: "Never show" });
  b.dataset.needNever = address;
  return el("p", { className: "sheet-notice" }, "Never show mail from ", el("strong", { textContent: address }), "? ", b);
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
    ...offers.map(offerLine),
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

// Done or (v5 L1) Not needed, each logged in feedback, as is its Undo.
async function markDone(id, notNeeded = false) {
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  try {
    await api.setNeedState(id, true, notNeeded);
    r.done = true;
    await api.logFeedback(needsFeedback(r, notNeeded ? "not_needed" : "done")).catch(console.error);
    note = `${notNeeded ? "Not needed" : "Done"}: ${r.subject}`;
    offerUndo(note, async () => {
      await api.setNeedState(id, false, false);
      r.done = false;
      note = null;
      await api.logFeedback(needsFeedback(r, "undo")).catch(console.error);
      refreshOffers();
    });
    if (notNeeded) refreshOffers();
  } catch (e) { failed(e); }
  draw();
  (dialog.querySelector("[data-need-done]") ?? dialog.querySelector(".sheet-btn"))?.focus();
}

async function addNever(address) {
  if (!confirm(`Never show mail from ${address} in Needs you?`)) return;
  try { await api.addTriageRule("address", address, "never"); } catch (e) { failed(e); }
  await refreshOffers();
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
    const skip = e.target.closest("[data-need-skip]");
    if (skip) markDone(skip.dataset.needSkip, true);
    const never = e.target.closest("[data-need-never]");
    if (never) addNever(never.dataset.needNever);
  });
  dialog.addEventListener("close", () => { note = null; });
  refresh().catch(console.error);
}
