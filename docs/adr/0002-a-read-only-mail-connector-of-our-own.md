# Mail goes through a read-only connector of our own

Lisul wants Claude to read several inboxes during "plan my day": his personal Gmail and his
Stony Brook Gmail, with more possible later. Claude's built-in Gmail connector holds one Google
account, and he turned down forwarding. So The Sheet gets its own MCP connector, `mail-mcp`, a
Supabase Edge Function signed in through Supabase Auth's OAuth server. It can do three things
and only three: list the mail accounts, search mail and read one message. There are no tools for
sending, drafting, labelling or deleting. Each account's Google refresh token is kept in Supabase
Vault and read only by the server.

This replaces ADR 0001's "custom MCP rejected for v1" for mail only. ADR 0001's main rule still
holds: no API key and no AI on a server. Claude still does all the reading and judging, in
Lisul's own Claude app, and only when he asks.

## Considered Options

- **Forwarding Stony Brook mail into the personal Gmail**, read by Claude's built-in connector.
  This was the simplest option. Lisul rejected it because he wants each account connected
  directly.
- **Composio**, a hosted multi-account Gmail connector. It is free and needs no code, but a third
  company would hold the tokens to his Stony Brook inbox (grades, advising). Rejected.
- **IMAP with app passwords.** Google doesn't offer app passwords on school accounts. Rejected.

## Consequences

- The Google app ("The Sheet", project the-sheet-512218) asks for `gmail.readonly`, a restricted
  scope, and is published "In production" without verification. In "Testing" its refresh tokens
  would expire after 7 days. Without verification each account sees Google's "unverified app"
  screen once, and the app is capped at 100 users.
- On 2026-11-03 Stony Brook's Google Workspace let the app reach Google's permission screen. If
  Stony Brook later blocks unconfigured apps, that account stops working until Stony Brook IT
  approves the app.
- Changing the NetID or Google password revokes that account's token, so it has to be
  reconnected.
- Email text is untrusted. Claude treats it as information, never follows instructions inside it,
  and writes nothing to the planner until Lisul approves.
