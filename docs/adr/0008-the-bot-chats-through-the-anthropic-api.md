# The Telegram bot chats through the Anthropic API

Lisul wants to text the bot like a person: ask what's next, whether Friday still works, or what to
drop, and get a short, thought-through answer in seconds, then go back and forth. A text to the bot
was a message to the morning task ([sheet-messages.md](../sheet-messages.md)), which takes minutes
to start and only adds tasks and events. [ADR 0007](0007-voice-capture-calls-the-anthropic-api.md)
said any other server use of the API key needs its own decision; this is it.

## Decision

With `ANTHROPIC_API_KEY` set, the telegram function answers a text itself: it reads the planner
with read_planner's own snapshot (`src/sheet/planner-snapshot.mjs`), adds the recent turns from
`chat_turns`, and calls the Messages API (`claude-sonnet-5-5` by default, `SHEET_CHAT_MODEL` to
change it), streaming the answer into a Telegram draft. Without the key, texts go to the morning
task as before.

## What bounds it

- **What it reads** is what read_planner gives the morning task, less the run-only fields. No Oura
  figure ([ADR 0005](0005-oura-data-never-reaches-claude.md)) and no Hevy row reaches it, since
  planSnapshot carries only code-derived plan constraints and never reads Hevy.
- **What it can do**: `add_tasks` (checked by `captureRows`, voice capture's rule, private rows
  only), `send_to_planner` (the request goes through the morning task, once per text, with its
  receipt and Undo), and Anthropic's server-side web search. It can't delete, move, complete,
  approve or send anything. Text from strangers reaches it (mail subjects and names in the
  planner, campus titles, search results), and the prompt says to act only on what Lisul asked.
  If that fails, the worst is junk tasks, or a request to the morning task that adds tasks or
  events, or replans today (auto-approved unless he turned that off). Each shows in a receipt
  with Undo, and the morning task treats requests as additions only.
- **Who can reach it**: only `settings.telegram_chat_id`, behind the webhook's secret token.
- **What is kept**: his texts and the answers, in `chat_turns`, owner-only, 30 days.

## Cost

Each answer sends the planner (a few thousand tokens) with the conversation. The planner and
instructions are marked for prompt caching, so a back-and-forth within five minutes reads them
from the cache while the planner hasn't changed. At a dozen chats a day on Sonnet this is a few
dollars a month; Haiku (`SHEET_CHAT_MODEL=claude-haiku-5-5`) is cheaper and faster but less
careful.

## Considered Options

- **Keep the morning task for texts.** No new bill, but minutes per answer and no conversation.
- **Give the model planner tools to call** instead of the snapshot up front. Fewer tokens, but a
  round trip per lookup, which is slower for the common question about today.
