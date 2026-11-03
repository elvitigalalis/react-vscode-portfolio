# The server syncs metadata only and starts replans by polling

v5 keeps the day's plan current. That needs the server to notice changes on its own: new mail,
a moved busy time, a new course task. ADR 0001's rule still holds: no API key and no AI on a
server. So the server only notices, with plain code, and the morning plan's cloud scheduled task
([ADR 0003](0003-the-morning-plan-runs-as-a-cloud-scheduled-task.md)) still does all the
planning. Three decisions follow.

1. **The server reads mail metadata, never mail text.** The mail sync reads Gmail history and
   fetches each new message with labels and dates only (`messages.get` with `format=minimal`).
   From those it works out Reply owed and Awaiting reply. It reads the To headers of sent mail
   only to keep salted hashes of known senders; no address is stored in plain text. Mail text
   still reaches only Claude, through `mail-mcp`
   ([ADR 0002](0002-a-read-only-mail-connector-of-our-own.md)).
2. **Calendar free/busy is its own grant.** A calendar connect flow, a sibling of the mail one,
   asks Lisul's Google account for the free/busy scope only. Its refresh token is a separate
   Vault secret, so a mail token never carries calendar scope and the calendar token never
   carries mail scope. Free/busy returns start and end times only, never titles, which is all the
   busy table keeps.
3. **Replans start from a server-held routine token, by polling.** Syncs poll Gmail every 5
   minutes and free/busy every 10, and log each change with a weight. The existing every-minute
   Telegram tick decides, in plain code and inside daily limits, whether the changes matter
   enough. If they do, it records the replan and then calls the routine's documented fire
   endpoint. The fire token is an Edge Function secret, never in a database call, and the
   request carries only fixed reason names and counts, never mail subjects or event titles.

## Considered Options

- **Gmail and Calendar push notifications.** Gmail push needs a Cloud Pub/Sub topic, a watch
  renewed at least every 7 days, a public webhook and code to verify Pub/Sub's signed tokens.
  Calendar push needs a watch channel per calendar, renewed by hand before it expires. Both
  can delay or drop notifications, so a polling fallback is needed anyway. For one person, a
  5-minute delay is fine for a planner, and polling stays far inside Gmail's quota. Rejected.
- **Reading mail text on the server** to judge Reply owed. It would put untrusted text on a
  server path, and the result would be the model's guess from snippets, not the thread's
  state. Rejected.
- **Adding free/busy to the mail grant.** One token would then carry both scopes, so a leak of
  either would expose both. Rejected.
- **Calling the fire endpoint from a database trigger** (`pg_net`). The token would sit in the
  request queue, which any database login can read. Rejected.

## Consequences

- Busy times no longer depend on /plan being open. The browser-side save stays as a fallback.
- Disconnecting the calendar deletes its stored token. A calendar link that stops working shows
  in Settings as a failed feed.
- Adding the free/busy scope shows Google's "unverified app" screen again on consent.
- The fire endpoint has no idempotency key, so a retry would start a second run. Each replan is
  therefore recorded before its request is sent, and a retry needs a new record. On a 429 the
  tick waits for Retry-After.
- If the fire token leaks, someone can start runs and use up Lisul's Claude usage, but can't read
  anything. It is rotated by regenerating it in the web UI.
- The run's own proposals and Lisul's edits on /plan never log changes, so a plan can't trigger
  itself. A replan also waits until 10 minutes after his last edit on /plan.
- Routines are a research preview, and their fire endpoint may change. If it goes away, the
  morning plan still runs on its schedule.
