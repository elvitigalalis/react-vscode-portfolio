// Settings, Triage rules (docs/sheet-v5.md, "/plan", v5 L1): always show or never show, by sender
// address or domain. The planner reads them, and the server drops Needs you items a never rule
// covers. Patterns go in lowercased (api.addTriageRule); text goes in through textContent only.
import * as api from "./api.mjs";
import { el, failed, settingsHooks } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);
const WORDS = { always: "Always show", never: "Never show" };

async function draw() {
  const rules = await api.listTriageRules();
  $("[data-triage-rules]").replaceChildren(...(rules.length ? rules.map((r) => {
    // A sender rule (made from a Needs you offer) holds a hash; it shows the sender's name.
    const shown = r.match === "sender" ? r.label || "a sender" : r.pattern;
    const remove = el("button", { type: "button", className: "sheet-link", textContent: "Remove", ariaLabel: `Remove the rule for ${shown}` });
    remove.dataset.triageRemove = r.id;
    return el("li", {}, `${WORDS[r.action]} · ${r.match === "sender" ? "sender" : r.match === "domain" ? "domain" : "address"} `, el("strong", { textContent: shown }), " ", remove);
  }) : [el("li", { className: "small", textContent: "No rules yet." })]));
}

async function add(e) {
  e.preventDefault();
  const form = e.target;
  const pattern = form.elements.pattern.value.trim().toLowerCase();
  const match = pattern.includes("@") ? "address" : "domain";
  try {
    await api.addTriageRule(match, pattern, form.elements.action.value);
    form.reset();
    await draw();
  } catch (err) { failed(err); }
}

export function setupTriageSettings(node) {
  root = node;
  settingsHooks.push(draw);
  $("[data-triage-add]").addEventListener("submit", add);
  $("[data-triage-rules]").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-triage-remove]");
    if (!b) return;
    try { await api.deleteTriageRule(b.dataset.triageRemove); await draw(); } catch (err) { failed(err); }
  });
}
