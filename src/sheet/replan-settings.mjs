// Settings, Replans (v5 R1, docs/sheet-v5.md "/plan"): whether the server may start the morning
// task again during the day when something changes (settings.replans_on), and Auto-approve
// (docs/sheet-v5.md, "Auto-approval"): whether a plan's blocks count at once
// (settings.auto_approve, on unless turned off). A toggle keeps one label and says its state
// with aria-pressed, as the Nudges chip does.
import * as api from "./api.mjs";
import { actHooks, failed, settingsHooks, state } from "./planner.mjs";

let root;

// Each toggle: its settings column, its button's data-act, its note and whether it is on.
const TOGGLES = [
  { key: "replans_on", act: "replans", note: "data-replans-note", on: (s) => Boolean(s?.replans_on) },
  { key: "auto_approve", act: "auto-approve", note: "data-auto-approve-note", on: (s) => s?.auto_approve !== false },
];

function draw() {
  for (const t of TOGGLES) {
    const on = t.on(state.settings);
    root.querySelector(`[data-act="${t.act}"]`).setAttribute("aria-pressed", String(on));
    root.querySelector(`[${t.note}]`).textContent = on ? "On" : "Off";
  }
}

const toggle = (t) => async () => {
  const change = { [t.key]: !t.on(state.settings) };
  try {
    await api.saveSettings(change);
    state.settings = { ...state.settings, ...change };
    draw();
  } catch (e) { failed(e); }
};

export function setupReplanSettings(node) {
  root = node;
  settingsHooks.push(draw);
  for (const t of TOGGLES) actHooks[t.act] = toggle(t);
}
