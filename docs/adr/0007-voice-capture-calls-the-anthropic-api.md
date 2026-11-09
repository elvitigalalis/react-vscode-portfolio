# Voice capture calls the Anthropic API from the server

Lisul wants to say a task to his iPhone and see it on the list before he has put the phone away.
[ADR 0001](0001-claude-through-mcp-not-an-api-key.md) kept Anthropic API keys off the server, and
[ADR 0003](0003-the-morning-plan-runs-as-a-cloud-scheduled-task.md) kept that rule for unattended
runs. Voice capture is the one exception: the capture Edge Function holds an `ANTHROPIC_API_KEY`
and calls Haiku directly. Every other AI step still runs through his subscription.

## Why

- A note is done in seconds. A message run takes minutes to start and answer, which is too slow
  for a notification saying what was added.
- It costs about 5 to 10 cents a month at Haiku's price, for a few short notes a day.
- It doesn't start a subscription session for each note.

## What bounds it

- The model's only tool is `add_tasks`, and the call forces it. It can't read or change anything.
- Its output is checked by `taskRow`, the rule `answer_messages` uses. If any task fails, or the
  reply was cut off, none are written and the raw words stay in the Inbox.
- The raw words are saved before the model is called, so a failed tidy keeps the words (a note over 500 characters keeps its first 500).
- All rows are private. Nothing it writes reaches /now.
- It sends the note, the date and up to 40 open task titles, as spelling vocabulary only. No Oura
  data ([ADR 0005](0005-oura-data-never-reaches-claude.md)), no mail bodies, and no titles of
  mail-suggested tasks.
- `SHEET_CAPTURE_TOKEN` opens this one function and nothing else, and can be rotated at any time
  (docs/sheet-voice.md). Without it set, the function answers 403 to everything.

## Consequences

- The token sits in plain text inside the Shortcut on his phone. Accepted: anyone holding the
  unlocked phone could add tasks anyway, and the token can do nothing more than that, so the worst
  case is junk in the Inbox and a few cents, until it is rotated.
- There is now a billed key to guard. It is stored only as a Supabase secret and is never logged
  or returned.
- This does not reopen the API-key option for planning. Any other server use needs its own decision.
