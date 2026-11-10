// Habits as rates on /plan (docs/sheet-habits.md): each habit's last seven days as dots and how
// many of its last seven scheduled days it was done, never a streak. Pure, so node --test covers
// it (test/habit-rate.test.mjs). Days are local date strings, as in logic.mjs.
import { addDays, localNow } from "./logic.mjs";

// A habit day runs from 4 am to 4 am: a 1 am gym check-in still counts for the day before.
export const DAY_TURNS_AT = 4 * 60;
export function habitDay(now, timeZone) {
  const { day, minutes } = localNow(now, timeZone);
  return minutes < DAY_TURNS_AT ? addDays(day, -1) : day;
}

// ISO weekday, 1 = Monday, as habits.days.
const isoDay = (day) => ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
export const scheduledOn = (habit, day) => habit.days.includes(isoDay(day));

export const RATE_OF = 7;

// One habit's row: `done` is the Set of days it was done, `today` the habit day now, `since` the
// habit day it was made. Counting starts the day after it was made (it was likely made partway
// through that day), or on that day if it was ticked then; days before are never misses.
// - dots: the seven days ending today, each "done", "missed" (a scheduled day gone by), "due"
//   (scheduled today, not yet done) or "off".
// - done / of: done on how many of its last seven scheduled days; today counts only once done,
//   so a day still under way is never a miss. `of` is 0 for a habit too new to have any.
// - back: the last scheduled day before today was missed and today is scheduled and open, so the
//   row asks "Back on it today?" instead of saying anything about the miss.
export function habitView(habit, done, today, made = null) {
  const since = made && !done.has(made) ? addDays(made, 1) : made;
  const counts = (d) => scheduledOn(habit, d) && (!since || d >= since);
  const dots = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(today, i - 6);
    const state = done.has(day) ? "done" : day === today ? (scheduledOn(habit, day) ? "due" : "off") : !counts(day) ? "off" : "missed";
    return { day, state };
  });
  let of = 0;
  let n = 0;
  let last = null; // the last scheduled day before today
  for (let i = done.has(today) ? 0 : 1; i <= RATE_OF * 7 && of < RATE_OF; i++) {
    const day = addDays(today, -i);
    if (since && day < since) break;
    if (!scheduledOn(habit, day)) continue;
    if (i > 0 && last === null) last = day;
    of++;
    if (done.has(day)) n++;
  }
  const back = last !== null && !done.has(last) && scheduledOn(habit, today) && !done.has(today);
  return { dots, done: n, of, back };
}

// "5 of last 7"; nothing until the habit has a scheduled day behind it.
export const rateText = ({ done, of }) => (of ? `${done} of last ${of}` : "");
