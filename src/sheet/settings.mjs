// Settings' sections that are needed only once Settings opens (docs/sheet-v5.md, "/plan"). The
// page imports this module on demand (planner.mjs, openSettings), so /plan's first-load script
// stays small; each section's setup runs once, the first time Settings opens. Settings' styles
// (plan-settings.css) come with it, before the dialog first opens.
import css from "../styles/plan-settings.css?inline";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
export { setupMailSettings } from "./mail-settings.mjs";
export { setupCalendarSettings } from "./calendar-settings.mjs";
export { setupPaceSettings } from "./pace-settings.mjs";
export { setupEnrollmentSettings } from "./enrollment-settings.mjs";
export { setupReplanSettings } from "./replan-settings.mjs";
export { setupTriageSettings } from "./triage-settings.mjs";
export { setupHabitSettings } from "./habit-settings.mjs";
export { setupOuraSettings } from "./oura-settings.mjs";
export { setupHevySettings } from "./hevy-settings.mjs";
export { setupBedtimeSettings } from "./bedtime-settings.mjs";
export { setupSettingsSections } from "./settings-sections.mjs";
