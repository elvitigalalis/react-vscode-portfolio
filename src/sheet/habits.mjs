// v5 H1, habits in /plan's Settings (docs/sheet-v5.md, "/plan"): the line each habit shows and
// the check on a new one before it is saved. The habits table (supabase/schema.sql, "v5 H1")
// checks everything again.
import { formatClock, formatMinutes } from "./logic.mjs";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayWords(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return "every day";
  if (d.join() === "1,2,3,4,5") return "weekdays";
  return d.map((n) => DAY_NAMES[n - 1]).join(", ");
}

// "Gym · Mon, Wed, Fri · 7:30 am ± 30 min · 1h · flexible"
export function habitLine(h) {
  const [hh, mm] = h.ideal.split(":").map(Number);
  const when = `${formatClock(hh * 60 + mm)}${h.flex_min ? ` ± ${h.flex_min} min` : " sharp"}`;
  return `${h.name} · ${dayWords(h.days)} · ${when} · ${formatMinutes(h.minutes)} · ${h.defence}`;
}

// The form's values ({ name, days: ["1".."7"], ideal: "HH:MM", minutes, flex_min, defence }) as a
// habits row, or { error } in words for the form. The form's own constraints (required, min, max,
// step) already hold the time and the minutes, so only the name and the days are checked here.
export function readHabit(v) {
  const name = String(v.name ?? "").replace(/\s+/g, " ").trim();
  const days = [...new Set((v.days ?? []).map(Number))].sort((a, b) => a - b);
  if (name.length < 1 || name.length > 40) return { error: "A name of 1 to 40 characters." };
  if (!days.length || days.some((d) => !(d >= 1 && d <= 7))) return { error: "Pick at least one day." };
  return { habit: { name, days, ideal: v.ideal, minutes: Number(v.minutes), flex_min: Number(v.flex_min), defence: v.defence } };
}
