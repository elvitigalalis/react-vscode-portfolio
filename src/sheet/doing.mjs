// The phone's Doing view (docs/sheet.md, "On the phone"): the plain logic, with no DOM, so node
// --test covers it. doing-view.mjs draws it.
import { nowNext } from "./now-next.mjs";

const isOpen = (r) => (r.kind === "task" ? !r.task.done : !r.done && !r.allDay);
const byStart = (a, b) => a.start - b.start;

// What the card shows from today's rows (event-todos.mjs, dayRows) at `minutes` past midnight,
// and the two after it. The card is the task a focus session is running on, else the open row on
// now (an event too: a lecture is what he is doing), else the next to start, else the first
// untimed task. A row that ended undone is left out: Reflow rest of today is for those. The two
// after it are the timed rows still to start, then untimed tasks.
// Returns { card, kind: "focus" | "now" | "next" | "untimed" | null, next: [row, row] }.
export function doingPick(rows, minutes, sessionTask = null) {
  const open = rows.filter(isOpen);
  const timed = open.filter((r) => r.start != null && r.end > minutes).sort(byStart);
  const untimed = open.filter((r) => r.kind === "task" && r.start == null);
  const session = sessionTask ? open.find((r) => r.kind === "task" && r.task.id === sessionTask) ?? null : null;
  const { now } = nowNext(timed, minutes);
  const card = session ?? now ?? timed.find((r) => r.start > minutes) ?? untimed[0] ?? null;
  const kind = !card ? null : card === session ? "focus" : card === now ? "now" : card.start != null ? "next" : "untimed";
  const next = [...timed.filter((r) => r !== card && r.start > minutes), ...untimed.filter((r) => r !== card)].slice(0, 2);
  return { card, kind, next };
}

// Which view a phone opens to: the one he picked today (`stored`, { day, mode }), else Doing
// during his day (from its start to the shutdown line, not shut down) when there is a card,
// else the week.
export function doingMode({ stored = null, today, minutes, dayStart, shutdown, shutDown = false, hasCard }) {
  if (stored?.day === today && (stored.mode === "doing" || stored.mode === "week")) return stored.mode;
  return hasCard && !shutDown && minutes >= dayStart && minutes < shutdown ? "doing" : "week";
}

// "25 min", "1h05": time left on the card's ring, rounded up to the minute.
export function minutesLeft(ms) {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
