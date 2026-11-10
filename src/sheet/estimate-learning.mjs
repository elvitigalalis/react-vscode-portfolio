// Estimate learning in Plan today (docs/sheet-focus.md, "Estimates against actuals"): how long
// his finished tasks took next to their estimates, over all kinds, as one plain line. The
// planning fallacy (Buehler, Griffin & Ross 1994) makes guesses run short; his own history is
// the fix, so the line waits for enough of it and says how much. Per-kind pace stays in pace.mjs.
import { formatMinutes } from "./logic.mjs";
import { PACE_LIMITS } from "./pace.mjs";

// Nothing shows below LEARN_MIN finished tasks with an estimate; the newest LEARN_WINDOW count.
export const LEARN_MIN = 8;
export const LEARN_WINDOW = 30;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Rows of actuals → { pace, n, bound }: the median of minutes / est_min over the newest
// LEARN_WINDOW rows with an estimate, to one decimal and held to pace.mjs's PACE_LIMITS; null
// below LEARN_MIN. `bound` is "at least" or "at most" when the limit held it, else null, so the
// line never states a held pace as the real one.
export function estimateLearning(actuals) {
  const rows = [...(actuals ?? [])].filter((a) => a.est_min > 0 && a.minutes > 0)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LEARN_WINDOW);
  if (rows.length < LEARN_MIN) return null;
  const [lo, hi] = PACE_LIMITS;
  const raw = median(rows.map((a) => a.minutes / a.est_min));
  const bound = raw > hi ? "at least" : raw < lo ? "at most" : null;
  return { pace: Math.round(Math.min(hi, Math.max(lo, raw)) * 10) / 10, n: rows.length, bound };
}

// "You usually take 1.4× your estimates (median of your last 12 finished tasks). Today's 4h of
// estimates is about 5h35." Past a limit: "at least 3.0×" and "is at least 12h". The day's part
// is left out with nothing estimated, or at 1.0×.
export function learningLine(l, plannedMin = 0) {
  if (!l) return null;
  const right = l.pace === 1 && !l.bound;
  const head = right ? "Your estimates have been about right" : `You usually take ${l.bound ? `${l.bound} ` : ""}${l.pace.toFixed(1)}× your estimates`;
  const line = `${head} (median of your last ${l.n} finished tasks).`;
  if (right || !plannedMin) return line;
  return `${line} Today's ${formatMinutes(plannedMin)} of estimates is ${l.bound ?? "about"} ${formatMinutes(Math.round((plannedMin * l.pace) / 5) * 5)}.`;
}
