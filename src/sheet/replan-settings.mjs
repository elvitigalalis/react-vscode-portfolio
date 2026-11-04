// Settings, Replans (v5 R1, docs/sheet-v5.md "/plan"): whether the server may start the morning
// task again during the day when something changes (settings.replans_on). A toggle keeps one
// label and says its state with aria-pressed, as the Nudges chip does.
import * as api from "./api.mjs";
import { actHooks, failed, settingsHooks, state } from "./planner.mjs";

let root;

function draw() {
  const on = Boolean(state.settings?.replans_on);
  root.querySelector('[data-act="replans"]').setAttribute("aria-pressed", String(on));
  root.querySelector("[data-replans-note]").textContent = on ? "On" : "Off";
}

async function toggle() {
  const replans_on = !state.settings?.replans_on;
  try {
    await api.saveSettings({ replans_on });
    state.settings = { ...state.settings, replans_on };
    draw();
  } catch (e) { failed(e); }
}

export function setupReplanSettings(node) {
  root = node;
  settingsHooks.push(draw);
  actHooks.replans = toggle;
}
