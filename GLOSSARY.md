# The Sheet

Lisul's week planner: the private page at /plan and its public mirror at /now. This glossary
covers planning a day and being reminded of the plan.

## Planning

**Task**:
One thing to do, either on a day or in a Someday list.
_Avoid_: To-do, item, todo

**Someday list**:
A named column of tasks with no day. "Inbox" is the one that takes rolled-out tasks.
_Avoid_: Backlog, capture list

**Due date**:
The day a task must be finished by. It is optional and separate from the day the task is planned for.
_Avoid_: Deadline

**At risk**:
An undone task due today or within the next two days, with no approved block starting before its due day ends. A block any time on the due day clears it.
_Avoid_: Urgent

**Overdue**:
An undone task whose due date has passed.
_Avoid_: Late, past due

**Message**:
A plain line Lisul types to Claude in /plan, such as "dentist Thu 3pm". Claude answers it with tasks, events and a one-line reply, and nothing else.
_Avoid_: Chat, prompt, command

**Block**:
A stretch of time on a day reserved for one task, mirrored to the "Time blocks" calendar.
_Avoid_: Event, slot, session

**Plan today**:
The morning step where today's tasks get blocks on the timeline.
_Avoid_: Morning plan, daily planning

**Proposal**:
A set of blocks Claude suggests for today. It is not part of the plan until approved, and it lapses at the end of its day.
_Avoid_: Suggestion, AI plan, draft

**Revision**:
One numbered proposal for a day. A day can have several; the newest pending one is current, and a newer one supersedes it.
_Avoid_: Version, draft, new plan

**Replan**:
A revision made during the day because something changed. It plans only from now until shutdown.
_Avoid_: Re-run, refresh, update

**Locked block**:
An approved block. A replan never moves it or removes it.
_Avoid_: Pinned block, fixed block, confirmed block

**Approve**:
To accept a proposed block (or a whole proposal), turning it into a real block.
_Avoid_: Accept, confirm, commit

**Turn down**:
To remove a proposed block (× on the timeline) without approving it. Completing a task turns down its proposed blocks.
_Avoid_: Reject, decline, dismiss

**Roll**:
A task left undone at the end of its day moving to the next day.
_Avoid_: Carry over, postpone

**Shutdown**:
The end-of-day step that moves missed tasks to tomorrow and closes the day.
_Avoid_: Review, wrap-up

**Pace**:
For one kind of task, the median of actual time over estimate, which shows how far off Lisul's guesses run.
_Avoid_: Speed, velocity, accuracy

**Workload cap**:
The most planned work a day may hold. On a day with Oura numbers it follows his readiness and how long he slept.
_Avoid_: Daily limit, capacity, budget

**Wake time**:
When Lisul got up today, from the end of his main sleep on his Oura ring. The plan starts 30 minutes after it.
_Avoid_: Wake-up, alarm, start time

**Typical wake**:
The median wake time of his last 14 weekday nights, or of his last 14 weekend nights, used until today's wake time has synced.
_Avoid_: Usual wake, average wake, chronotype

**Habit**:
A recurring time Lisul protects, such as gym or lunch, with set days, an ideal time, a flex window and a defence level (flexible or firm).
_Avoid_: Routine, recurring task, ritual

**Morning plan**:
The proposal Claude makes on its own at 6:07 each morning, delivered with the morning brief for Lisul to approve or skip.
_Avoid_: Auto-plan, daily run, routine

**Busy time**:
A stretch of Lisul's calendar that is taken, known only by its start and end, which the morning plan fits around.
_Avoid_: Event, free/busy, slot

**Needs you**:
The list of emails and Slack mentions that need something from Lisul (a reply owed, a deadline, a meeting, school or admin), each with a one-line reason. He clears an item by marking it done or not needed.
_Avoid_: Inbox, triage list, action items

**Reply owed**:
A mail thread whose newest message is someone else's and is two or more business days old, so Lisul has not answered. It clears itself when the thread moves.
_Avoid_: Follow-up, unanswered

**Awaiting reply**:
A mail thread where Lisul wrote last and nobody has answered for three or more business days. It clears itself when the thread moves.
_Avoid_: Waiting on, follow-up, no response

**Triage rule**:
Lisul's standing instruction to always show or never show mail from a sender address or a domain in Needs you.
_Avoid_: Filter, block list, allow list

**Known sender**:
Someone Lisul has emailed before. Mail from a known sender is never filtered out.
_Avoid_: Contact, trusted sender

## Sources

**Feed**:
A calendar subscription link (iCal) The Sheet reads on a schedule: Brightspace, SB Engaged, Handshake and the SBU academic calendar.
_Avoid_: Integration, sync, calendar link

**Change**:
One difference a sync found since the last plan, such as new mail, a moved busy time or a new course task, with a kind and a weight for how much it matters.
_Avoid_: Event, update, diff

**Course task**:
A task created from a Brightspace feed item. It carries the item's due date and lives in the "Brightspace" Someday list.
_Avoid_: Assignment, Brightspace item

**Campus event**:
A public event from SB Engaged (Stony Brook's CampusGroups site). It is something Lisul might go to, not a task.
_Avoid_: Club event, CampusGroups event, activity

**RSVP count**:
How many people have registered for a campus event, read from its SB Engaged page and shown as "42 going". The list ranks by it.
_Avoid_: Attendees, popularity score, going count

**Campus pick**:
A campus event Claude points out during "plan my day" because it fits the interest profile.
_Avoid_: Suggestion, recommendation

**Interest profile**:
Lisul's own short description of what he enjoys, which Claude matches campus events against.
_Avoid_: Preferences, persona

**Mail account**:
One email inbox Lisul has connected for Claude to read, such as his personal Gmail or his Stony Brook Gmail.
_Avoid_: Email, inbox connection

**Inbox sweep**:
The part of "plan my day" where Claude reads recent mail across every mail account and lists what may need Lisul: deadlines, meetings, requests.
_Avoid_: Email check, triage

## Reminders

**Nudge**:
A message to Lisul when an approved block starts, naming its task.
_Avoid_: Reminder, notification, ping, alert

**Repeat**:
The single second nudge sent when a block's task is still not done 10 minutes after the block starts.
_Avoid_: Follow-up, re-nudge

**Snooze**:
Asking for a nudge to be sent again in 10 minutes, in place of the repeat. The block stays where it is.
_Avoid_: Remind me later, postpone

**Morning brief**:
The first message of the day, at 8 am, saying what today holds and which tasks are at risk.
_Avoid_: Digest, daily summary

**Check-in**:
The message at shutdown time that asks Lisul to do the shutdown; skipped if the day is already shut down.
_Avoid_: End-of-day reminder, review prompt

**Finished? check**:
The message when a nudged block ends, asking whether its task is done: Finished, More time, Didn't start or Tomorrow. It is not the check-in.
_Avoid_: Check-in, follow-up, time log

**Nudge budget**:
The most nudges Lisul gets in one day: six, counting repeats and snoozes but not the morning brief or the check-in. The first six blocks' nudges are kept for them; repeats and snoozes get only the slots left.
_Avoid_: Limit, cap

**Quiet hours**:
11 pm to 8 am, when nothing is sent.
_Avoid_: Do not disturb, sleep mode
