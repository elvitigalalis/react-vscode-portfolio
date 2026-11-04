// Messages to Claude (docs/sheet-messages.md): plain lines Lisul types into /plan ("dentist Thu
// 3pm"), which the morning task reads and answers with tasks and events. This is their pure
// side: when the message function fires the task, what answer_messages may write, and what
// read_planner adds for them. Kept free of the network and of Node APIs so node --test covers
// it; the message and planner-mcp Edge Functions import it.

// --- Sending (the message function) ----------------------------------------------------------

// A message fired this recently and still pending has a run on its way, which reads every
// pending message, so a new one waits for it rather than starting a second run.
export const FIRE_GAP_MS = 3 * 60_000;

// Whether to fire the task for a new message, from the pending messages ({ fired_at }) and now.
export const shouldFire = (pending, now) =>
  !pending.some((m) => m.fired_at && now.getTime() - Date.parse(m.fired_at) < FIRE_GAP_MS);
