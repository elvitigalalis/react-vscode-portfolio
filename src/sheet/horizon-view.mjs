// Horizon planning on /plan (docs/sheet-horizon.md, "Part 2", 6): a task's state chip and its one
// quiet line, from its horizon_state row and horizon_alloc rows. Pure, so node --test covers it,
// and small, since /plan loads it up front (the engine stays on the server).
import { addDays, dayLabel, formatMinutes, plural, weekdayName } from "./logic.mjs";

const SHOWN_DAYS = 4;
const FIXES = "move the due date, cut the estimate or raise a day's cap";

// "today", "Fri" within the coming week, else "Nov 16".
const dayName = (d, today) => (d === today ? "today" : d > today && d < addDays(today, 7) ? weekdayName(d) : dayLabel(d).date);
const between = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

// The chip: { text, level }, level as the due date's look (ok, risk in amber, overdue in red).
export function horizonChip(s) {
  if (s.state === "wont_fit") return { text: `Won't fit · ${formatMinutes(s.short_min)} short`, level: "overdue" };
  return s.state === "tight" ? { text: "Tight", level: "risk" } : { text: "On track", level: "ok" };
}

// "4h left · today 1h, Fri 1h30 · done Sat, 2 days spare" (R11). `allocs` are the task's rows
// from today on; won't fit ends with the hours short and the fixes instead (R7).
export function horizonLine(s, allocs, due, today) {
  if (!s.remaining_min) return "Nothing left to plan";
  const days = allocs.filter((a) => a.day >= today && a.minutes > 0).sort((a, b) => a.day.localeCompare(b.day));
  const shown = days.slice(0, SHOWN_DAYS).map((a) => `${dayName(a.day, today)} ${formatMinutes(a.minutes)}`);
  if (days.length > SHOWN_DAYS) shown.push(`+${plural(days.length - SHOWN_DAYS, "day")}`);
  const spare = s.finish_day ? between(s.finish_day, due) : 0;
  const end = s.state === "wont_fit" ? `${formatMinutes(s.short_min)} short: ${FIXES}`
    : `done ${dayName(s.finish_day ?? due, today)}, ${spare > 0 ? `${plural(spare, "day")} spare` : "no day spare"}`;
  return [`${formatMinutes(s.remaining_min)} left`, shown.join(", "), end].filter(Boolean).join(" · ");
}
