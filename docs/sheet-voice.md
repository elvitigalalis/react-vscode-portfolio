# The Sheet: voice capture

Say a task to the iPhone and it lands in the planner. A Shortcut dictates the words and POSTs them
to the capture function, which saves them to the Inbox, has Haiku tidy them, and answers with one
line for a notification ("Added: Email Priya, due Fri"). Why this one feature has an API key:
[ADR 0007](adr/0007-voice-capture-calls-the-anthropic-api.md).

## Files

- `supabase/functions/capture/index.ts`: the function.
- `src/sheet/voice.mjs`: the prompt, the `add_tasks` tool, what Haiku's answer may become, and the
  reply line. No network. Tested in `test/voice.test.mjs`.
- `tools/voice-setup.sh`: sets the two secrets.

## What happens to a note

1. The request needs `Authorization: Bearer SHEET_CAPTURE_TOKEN`; otherwise 403. Blank text gets
   400 "Didn't catch that" and nothing is saved.
2. The raw words go in the Inbox as a private task, cut to 500 characters.
3. Haiku (`claude-haiku-5-5`, forced `add_tasks`, 10 second limit) gets the note, today's date and
   up to 40 recent open task titles, so it can spell names and course codes the way the planner
   does. If reading the titles fails it goes on without them.
4. Every task is checked by `taskRow`. The first replaces the raw row and any others (at most 5 in
   all) are added as private tasks. These land at the end of their list.
5. If Haiku fails, times out, is cut off or gives anything invalid, the raw row stays and the reply
   is "Saved to Inbox". If the raw row itself can't be saved the reply is "Couldn't save. Try again".

## Deploy

```sh
npx -y supabase functions deploy capture --use-api --no-verify-jwt --project-ref bmbsvvprpfdbvalnkowp --yes
tools/voice-setup.sh   # asks for the Anthropic API key, sets both secrets, copies the capture token
```

The URL is `https://bmbsvvprpfdbvalnkowp.supabase.co/functions/v1/capture`. Until the secrets are
set it answers 403 to every POST.

## Phone setup

In Shortcuts, make a new shortcut named **Sheet** with three actions:

1. **Dictate Text**, with Stop Listening set to **After Pause**.
2. **Get Contents of URL**: the URL above, Method POST, a header `Authorization` with the value
   `Bearer ` followed by the pasted capture token, Request Body JSON with a text field `text` set
   to Dictated Text.
3. **Show Notification** with Contents of URL as its body.

Then, to start it:

- **Back Tap**: Settings > Accessibility > Touch > Back Tap > Double Tap > Sheet.
- **"Hey Siri, Sheet"**: Siri runs a shortcut by its name, with no further setup.

With no signal the Shortcut itself fails and nothing is saved.

## Rotating the token

Run `tools/voice-setup.sh` again and paste the new token into the Shortcut's header; the old one
stops working as soon as the secret is set. It also asks for the API key, so have that ready, or
revoke and replace it at the same time.
