# The morning plan runs as a Claude cloud scheduled task, with a planner connector of our own

Lisul wants "plan my day" done for him each morning, without asking. Claude's cloud scheduled
tasks now run unattended on his subscription, with his claude.ai connectors and without his
laptop. So the morning plan runs as one of those tasks at 6:07 am, still with no Anthropic API
key and no AI on our server. This supersedes the last line of
[ADR 0001](0001-claude-through-mcp-not-an-api-key.md). An unattended run still couldn't sign in
with an API key, but it no longer needs one.

Nobody watches that run, and it reads mail, which is untrusted text. So it gets exactly two
connectors:

- `mail-mcp`, which is read-only ([ADR 0002](0002-a-read-only-mail-connector-of-our-own.md));
- a new **planner connector** (`planner-mcp`), with two tools:
  - `read_planner`
  - `submit_proposal`, which can only write a proposal for today or tomorrow.

The full Supabase connector is never attached to it. Supabase's connector is what Lisul uses
in chat, where he approves every `execute_sql` call. In a cloud run, auto mode would decide in
his place. `execute_sql` can write any table, and through `pg_net` a SQL statement can even send
data out. That would give an agent reading untrusted mail all three legs of the "lethal
trifecta": private data, untrusted input, and a way to act or send. `submit_proposal` is the
only write, and the server checks every field. A proposal turns into blocks only when Lisul taps
Approve.

## Considered Options

- **A local scheduled task, `claude -p` from a LaunchAgent:** it fires only while the Mac is
  awake, and a sleeping laptop skips the run or catches it up at 11 pm. Rejected.
- **The full Supabase connector on the cloud task:** this is ADR 0001's setup. Rejected for the
  trifecta reason above.
- **An API key in an Edge Function:** a second bill and a secret to guard, as ADR 0001 found.
  Rejected again.

## Consequences

- `planner-mcp` is new server code. It signs in like `mail-mcp`, through Supabase Auth's OAuth
  server and the site's consent page.
- The server has no Google token, so it can't read Lisul's calendar. /plan saves his busy times
  (start and end only, no titles) each time it opens, and the run plans around those.
- Telegram delivers the plan, and Lisul approves it there with one tap. Plain code approves, not
  AI. The Google events for blocks approved this way are created the next time /plan opens.
- The task's "Succeeded" status can be wrong: a run can fail quietly, for example when a
  connector is missing. The morning brief therefore says when no plan came in.
- Cloud scheduled tasks are a research preview. If they change or go away, "plan my day" in chat
  still works as before.
