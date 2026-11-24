# The Sheet: chat with the bot

Text the Telegram bot and Claude answers in seconds, with the planner in view, and remembers the
conversation: "what's next?", "can I fit the lab report in tomorrow?", "add email Priya by Fri",
"what should I drop today?". Why this has an API key:
[ADR 0008](adr/0008-the-bot-chats-through-the-anthropic-api.md).

## Files

- `supabase/functions/telegram/index.ts`, "Chat with the bot": the webhook side, the stream and
  the tools.
- `src/sheet/chat.mjs`: the prompt, the tools, the conversation window, folding the stream and
  the text sent back. No network. Tested in `test/chat.test.mjs`.
- `src/sheet/planner-snapshot.mjs`: read_planner's snapshot, shared with planner-mcp.
- `supabase/schema.sql`, "Chat with the bot": `chat_turns`.

## What happens to a text

1. The webhook reads it with `readText` (src/sheet/capture.mjs) as before: a plain text from his
   chat, not a command or a key of the thumb keyboard. `/new` or `/reset` starts the conversation
   over ("New chat.").
2. It is saved to `chat_turns` with its Telegram id, which is unique, so a resent update is
   answered once. The webhook then says ok; the answer runs in the background
   (`EdgeRuntime.waitUntil`).
3. A draft shows "Thinking…" at once (`sendMessageDraft` with empty text).
4. The planner snapshot and the conversation are read together: turns since the last `/new`,
   from the last 12 hours, at most 30.
5. Claude (`claude-sonnet-5-5`, or `SHEET_CHAT_MODEL`) answers, streamed into the draft about
   every 0.7 s. It may call, for up to 5 rounds:
   - `add_tasks`: to-dos saved straight away as private tasks, checked by `captureRows`.
   - `send_to_planner`: events at a time, projects or a replan go to the morning task through
     `saveAndFire`, keyed to his text, so its receipt with Undo buttons replies to it in a few
     minutes. Once per text.
   - `web_search`, on Anthropic's side, at most 3 searches.
   The rounds stop after 110 seconds in all, under the function's wall clock.
6. The answer is sent as plain text, as a reply to his text (split at 4096 characters), and saved
   as the assistant's turn. If a round fails after a tool ran, the answer lists what went through
   ("Added: …") and says it stopped early, so he doesn't ask again for something already done. A
   failure before anything was said or done answers "Couldn't answer just now. Try again in a
   minute." and saves no turn.

Without `ANTHROPIC_API_KEY` the function captures texts for the morning task, as in
[sheet-messages.md](sheet-messages.md), "From Telegram".

## Deploy

Run the "Chat with the bot" section of `supabase/schema.sql` in the SQL editor, then:

```sh
npx -y supabase functions deploy telegram --use-api --no-verify-jwt --project-ref bmbsvvprpfdbvalnkowp --yes
```

The function reads `ANTHROPIC_API_KEY`, the secret voice capture already uses
(`tools/voice-setup.sh`). Optionally set `SHEET_CHAT_MODEL` to another model id.
