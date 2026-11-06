// The wake alarm (docs/sheet-alarms.md): /plan can't set an iPhone Clock alarm itself, so it opens
// his "Sheet Alarm" shortcut through the shortcuts:// URL scheme with the time as text, and the
// shortcut's Create Alarm sets it. The time is the next morning's typical wake (sleep.mjs), else
// half an hour before the plan's default start. Only that derived time leaves the page.
import { SHEET } from "../site.mjs";
import { tonight } from "./bedtime.mjs";
import { addDays } from "./logic.mjs";
import { hhmm, isWeekend, wakeProfile } from "./sleep.mjs";

// The shortcut he builds on his phone, by this exact name.
export const SHORTCUT = "Sheet Alarm";

// The morning after tonight's night: { day, time "HH:MM", source "typical" | "default" }.
export function alarmFor(now, sleep, tz) {
  const day = addDays(tonight(now, tz), 1);
  const p = wakeProfile(sleep ?? [], now, tz);
  const wake = isWeekend(day) ? p.weekend : p.weekday;
  if (wake != null) return { day, time: hhmm(Math.floor(wake / 5) * 5), source: "typical" };
  const [h, m] = SHEET.dayStartAt.split(":").map(Number);
  return { day, time: hhmm(h * 60 + m - 30), source: "default" };
}

// shortcuts://run-shortcut?name=…&input=text&text=… (Shortcuts User Guide, "Run a shortcut using a
// URL scheme"): opens Shortcuts and runs the shortcut with `time` as its input.
export const alarmUrl = (time) => `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT)}&input=text&text=${encodeURIComponent(time)}`;
