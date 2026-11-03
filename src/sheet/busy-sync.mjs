// Busy times for the morning task (docs/sheet-morning.md, "/plan"). The server has no Google
// token, so each time /plan loads his events it saves the busy times from now through 7 days
// ahead into `busy`, start and end only, and stamps settings.busy_as_of. It runs in the
// background (planner.mjs, eventHooks); a failure is logged and the page carries on.
import * as api from "./api.mjs";
import { state, eventHooks } from "./planner.mjs";
import { busyRows } from "./morning.mjs";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function saveBusy() {
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + WEEK_MS).toISOString();
  // The calendars it shows, but never "Time blocks": those events are his own blocks.
  const tb = state.settings?.gcal_calendar_id ?? null;
  const events = await api.calendarEvents(from, to, state.calendars.filter((id) => id !== tb));
  await api.replaceBusy(from, to, busyRows(events, now, tb));
  await api.saveSettings({ busy_as_of: from });
}

// At most one save at a time; a load while one runs is covered by it.
let saving = null;

export function setupBusy() {
  eventHooks.push(() => (saving ??= saveBusy().finally(() => { saving = null; })));
}
