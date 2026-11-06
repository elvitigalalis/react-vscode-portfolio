// Settings, Pace (docs/sheet-v5.md, "/plan"): how long each kind of task really takes next to its
// estimate, from the actuals Telegram's Finished answer records. Text goes in through
// textContent only.
import * as api from "./api.mjs";
import { el, settingsHooks } from "./planner.mjs";
import { PACE_KINDS, paceByKind, paceLine, paceRangeByKind } from "./pace.mjs";

async function draw(root) {
  const actuals = await api.listActuals();
  const pace = paceByKind(actuals), range = paceRangeByKind(actuals);
  root.querySelector("[data-pace]").replaceChildren(...PACE_KINDS.map((k) => el("li", { textContent: paceLine(k, pace[k], range[k]) })));
}

// Filled each time Settings opens (planner.mjs, settingsHooks).
export function setupPaceSettings(root) {
  settingsHooks.push(() => draw(root));
}
