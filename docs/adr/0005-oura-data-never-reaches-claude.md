# Oura data never reaches Claude; only code-derived plan constraints do

Oura's API and MCP Agreement (cloud.ouraring.com/legal/api-agreement, in force since 2026-06-08)
says in §4(d) that the API may not be used to "prompt, or otherwise provide input or data to any
AI Model", and that Oura data used with a language model must go "solely through the MCP Server",
whose data §3(m) bars storing. The morning plan's cloud scheduled task
([ADR 0003](0003-the-morning-plan-runs-as-a-cloud-scheduled-task.md)) is an AI model reading
read_planner, so v5's first Oura cut, which gave it typical and actual wake times and
"readiness 64, slept 5h40" in `day_rules.cap_reason`, does not fit.

## Decision

**Oura data never goes to the routine.** The server keeps what oura-sync reads, works out plan
constraints from it in plain code, and read_planner carries only those:

- `window.from` (when the plan starts, after his wake) and `window.to` (cut to wind-down);
- `day_rules.workload_cap_min` and `break_after_min`, with `cap_reason` only "lighter day" or
  "fuller day", never the readiness or hours behind it;
- `day_rules.bedtime` and `wind_down_from`, as plain "HH:MM" times;
- the replan reason name `woke_late` (a fixed name; the change row's ref never goes out).

No Oura field or figure (readiness, sleep score, hours, HRV, heart rate, bedtime_start or
bedtime_end, wake times, offsets) is in read_planner, and test/sleep.test.mjs checks that.
Messages that show Oura numbers, such as the brief's cap line or wind-down's "lights out at
12:30 am", are composed by server code (the telegram function, from the database), never by the
routine. /plan may show his numbers to him: no AI is involved there. /now never shows them.

## Considered Options

- **The routine reads Oura's MCP Server.** Allowed, but nothing it read could be stored, so the
  wake time, woke-late replans and the cap couldn't be worked out between runs, and the routine
  would need another connector. Rejected for now.
- **Drop Oura from planning.** Loses the wake-based start and the lighter day, which code can
  derive without the model ever seeing the data.
