// v5 H1, habits in /plan's Settings (docs/sheet-v5.md, "/plan"): the line each habit shows and
// the check on a new one before it is saved. The checks are the habits table's own
// (supabase/schema.sql, "v5 H1"), so a refused save never reaches the database.
import { formatClock, formatMinutes } from "./logic.mjs";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
// habits row, or { error } in words for the form.
export function readHabit(v) {
  const name = String(v.name ?? "").replace(/\s+/g, " ").trim();
  const days = [...new Set((v.days ?? []).map(Number))].sort((a, b) => a - b);
  const minutes = Number(v.minutes);
  const flex_min = Number(v.flex_min);
  if (name.length < 1 || name.length > 40) return { error: "A name of 1 to 40 characters." };
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { error: "Pick at least one day." };
  if (!HHMM.test(String(v.ideal ?? ""))) return { error: "An ideal time, like 07:30." };
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240 || minutes % 5) return { error: "15 to 240 minutes, in fives." };
  if (!Number.isInteger(flex_min) || flex_min < 0 || flex_min > 240) return { error: "Flex of 0 to 240 minutes." };
  if (!["flexible", "firm"].includes(v.defence)) return { error: "Flexible or firm." };
  return { habit: { name, days, ideal: v.ideal, minutes, flex_min, defence: v.defence } };
}
