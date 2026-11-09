// Voice capture (docs/sheet-voice.md): what Haiku is asked for, and what its answer may become.
// The server only keeps tasks that pass messages.mjs's taskRow, the rules Claude's other tasks
// follow. Anything else leaves the raw words in the Inbox.
import { taskRow } from "./messages.mjs";
import { cutTitle } from "./logic.mjs";

export const MODEL = "claude-haiku-5-5";
export const MAX_TASKS = 5;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (day) => DAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];

export const ADD_TASKS_TOOL = {
  name: "add_tasks",
  description: "Add what the speaker said to their to-do list.",
  input_schema: {
    type: "object",
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: MAX_TASKS,
        items: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", description: "Short imperative to-do, under 80 characters, with no date words that moved to another field." },
            day: { type: ["string", "null"], description: "YYYY-MM-DD, only when they said when to do it. Otherwise null." },
            due: { type: ["string", "null"], description: "YYYY-MM-DD, only when they gave a deadline. Otherwise null." },
            at_time: { type: ["string", "null"], description: "24-hour HH:MM, only for a stated clock time. Needs day and est_min." },
            est_min: { type: ["integer", "null"], description: "15 to 480, only when they gave a length or at_time is set." },
          },
        },
      },
    },
  },
};

export function systemPrompt(today) {
  return `You turn a dictated note into to-do items. Today is ${weekday(today)} ${today}. The note is speech-to-text, so fix obvious mishearings, drop filler, and keep names as heard. Make one task unless they clearly list separate things. Never invent a date, time or length they didn't imply. "By" or "due" sets due; "on", "tomorrow" or "at" sets day. Always call add_tasks.`;
}

// The tasks rows Haiku's input becomes, or null if any is invalid or there are none.
export function captureRows(input, today) {
  const tasks = input?.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_TASKS) return null;
  const errors = [];
  // tasks has no why column (taskRow keeps one for answer_message's reply), and a bulk insert
  // needs every row to have the same keys.
  const rows = tasks.map((t, i) => taskRow({ ...t, why: null }, `tasks[${i}]`, errors, today));
  return errors.length ? null : rows;
}

// The add_tasks input from an Anthropic reply, or undefined. A reply cut off by max_tokens can
// hold a shorter but valid list, which would replace the raw words and lose the rest.
export const toolInput = (reply) =>
  reply?.stop_reason === "tool_use" ? reply.content?.find((c) => c.type === "tool_use" && c.name === ADD_TASKS_TOOL.name)?.input : undefined;

// The raw words, saved before Haiku is called so a failure loses nothing.
// `position` puts it after what's already on the list (the default 0 would be at the top), and
// stays past the end of any day list it moves to.
export const rawRow = (text, position) => ({ title: cutTitle(text.replace(/\s+/g, " ")), list: "Inbox", public: false, position });

const when = (r) => (r.due ? `, due ${weekday(r.due)}` : r.day ? `, ${weekday(r.day)}` : "");

// The one line the Shortcut shows.
export function replyLine(rows) {
  if (!rows) return "Saved to Inbox";
  if (rows.length === 1) return `Added: ${rows[0].title}${when(rows[0])}`;
  return `Added ${rows.length}: ${rows.map((r) => r.title).join("; ")}`;
}
