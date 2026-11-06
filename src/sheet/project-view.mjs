// Projects on /plan (docs/sheet-projects.md): a project's one-line summary from its steps and
// their horizon states. Pure, so node --test covers it; project-list.mjs draws it.
import { dayLabel, formatMinutes } from "./logic.mjs";
import { horizonChip } from "./horizon-view.mjs";

const WORST = ["on_track", "tight", "wont_fit"];

// project { title, due }, its steps (tasks rows with step and done), and states (task id ->
// horizon_state row). Returns { line: "3 of 7 steps · 6h left · due Dec 10", chip, steps in
// order, done }. The hours left are the open steps' horizon remaining_min, or their estimate
// without one; the chip is the worst open step's state, its hours short added up.
export function projectSummary(project, steps, states) {
  const ordered = [...steps].sort((a, b) => a.step - b.step);
  const open = ordered.filter((t) => !t.done);
  const left = open.reduce((n, t) => n + (states.get(t.id)?.remaining_min ?? t.est_min ?? 0), 0);
  const rows = open.map((t) => states.get(t.id)).filter(Boolean);
  const state = rows.reduce((w, s) => (WORST.indexOf(s.state) > WORST.indexOf(w) ? s.state : w), rows.length ? "on_track" : null);
  const short_min = rows.reduce((n, s) => n + (s.short_min ?? 0), 0);
  const line = [`${ordered.length - open.length} of ${ordered.length} steps`, left ? `${formatMinutes(left)} left` : null, `due ${dayLabel(project.due).date}`]
    .filter(Boolean).join(" · ");
  return { line, chip: state ? horizonChip({ state, short_min }) : null, steps: ordered, done: open.length === 0 };
}
