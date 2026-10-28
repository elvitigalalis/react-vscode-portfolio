# Claude plans through Lisul's own Claude, never from a server

The Sheet's AI runs only when Lisul asks Claude in his own Claude app, which reaches the planner
through Supabase's MCP connector. There is no Anthropic API key and no AI on a server. That
keeps the cost at zero beyond his subscription and keeps a billed key out of the stack. The
price is that nothing writes itself while he is away: a proposal exists only after he asks
for one, and every nudge, morning brief and check-in is a fixed template.

## Considered Options

- **An API key in an Edge Function**: it could plan unattended and write each message, but it
  means a second bill and a secret to guard. Rejected.
- **A custom MCP server with planner-only actions**: tighter access than Supabase's connector,
  but it means new server code and a sign-in flow. Rejected for v1. Supabase's connector is
  limited to the planner's own project, and nothing else lives there.

## Consequences

- Proposals are written to the database. They turn into blocks, and into Google Calendar
  events, only when Lisul approves them in /plan, because the Google token lives only in his
  browser.
- If unattended planning is wanted later, the API-key option has to come back as a new decision.
