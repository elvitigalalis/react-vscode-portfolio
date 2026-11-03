// Starting the morning task from the server (spec 47, "Replan decision"; ticket 50). The task is
// a Claude Code routine with an API trigger: a POST to its /fire URL with its own bearer token
// starts one new session and returns that session's id and URL.
//   platform.claude.com/docs/en/api/claude-code/routines-fire (the reference: headers, body,
//     errors, rate limits)
//   code.claude.com/docs/en/routines, "Add an API trigger" and "Trigger a scheduled task"
// The endpoint is experimental. The token is scoped to this one routine and can only start it.
// Each success is a new session and there is no idempotency key, so nothing here retries: a
// caller that wants another run records a new replans row first.
//
// The text sent is built only from fixed reason names and counts, never from mail or events. It
// reaches the run wrapped in a <routine-fire-payload> block marked as untrusted data.
// The token comes from the caller (an Edge Function secret); it is never logged or returned.

const FIRE_BASE = "https://api.anthropic.com/v1/claude_code/routines";
// "The endpoint accepts every version from 2023-06-01 on and behaves the same in each."
const API_VERSION = "2023-06-01";

// The request for one fire: { url, init } for fetch. A routine id is prefixed trig_ ("Despite
// the parameter name, the value is prefixed trig_"); anything else is refused before it reaches
// the URL.
export function fireRequest(routineId, token, text) {
  if (!/^trig_[A-Za-z0-9]+$/.test(routineId ?? "")) throw new Error("fire: bad routine id");
  if (!token) throw new Error("fire: no token");
  return {
    url: `${FIRE_BASE}/${routineId}/fire`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": API_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  };
}

// The only words the text can hold. Triggers: the morning plan, a replan, and the one-off test
// fire (ticket 50). Reasons are the change kinds of spec 47's changes table, in its order.
export const TRIGGERS = ["morning", "replan", "test"];
export const REASONS = ["mail", "busy", "course", "campus", "github", "jira", "slack", "handshake"];

// The text for one fire, such as "trigger: replan\nreasons: busy 2, course 1". `counts` maps a
// reason to how many changes of that kind there were; a count of 0 is left out. Anything that
// isn't a fixed name or a whole number from 0 to 9999 is refused, so no outside text can get in.
export function fireText(trigger, counts) {
  if (!TRIGGERS.includes(trigger)) throw new Error("fire: unknown trigger");
  for (const [name, n] of Object.entries(counts)) {
    if (!REASONS.includes(name)) throw new Error("fire: unknown reason");
    if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error("fire: bad count");
  }
  const reasons = REASONS.filter((name) => counts[name] > 0).map((name) => `${name} ${counts[name]}`);
  return `trigger: ${trigger}\nreasons: ${reasons.join(", ") || "none"}`;
}
