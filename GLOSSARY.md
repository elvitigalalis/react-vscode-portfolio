# The Sheet

Lisul's week planner: the private page at /plan and its public mirror at /now. This glossary
covers planning a day and being reminded of the plan.

## Planning

**Task**:
One thing to do, either on a day or in a Someday list.
_Avoid_: To-do, item, todo

**Event to-do**:
A Google Calendar event shown as a row in its day's list, in time order among the tasks, so Lisul plans from one list. He can check it off or hide it; it is not a task.
_Avoid_: Calendar task, event row

**Someday list**:
A named column of tasks with no day. "Inbox" is the one that takes rolled-out tasks.
_Avoid_: Backlog, capture list

**Due date**:
The day a task must be finished by. It is optional and separate from the day the task is planned for.
_Avoid_: Deadline

**At risk**:
An undone task that is tight or won't fit. A due task with no horizon state yet (one with a fixed time, or before the first re-flow) is at risk when due today or within the next two days with no approved block starting before its due day ends.
_Avoid_: Urgent

**Overdue**:
An undone task whose due date has passed.
_Avoid_: Late, past due

**Message**:
A plain line Lisul types to Claude in /plan or texts to the bot, such as "dentist Thu 3pm". Claude answers it with tasks, events and a one-line reply, and nothing else.
_Avoid_: Chat, prompt, command

**Receipt**:
What a message added, item by item, each with an Undo: under the message in /plan, and as the bot's reply to a text.
_Avoid_: Confirmation, summary, result

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

**Catch-up**:
A replan with only new items behind it (mail, Slack, campus, course and the like), five hours after the last plan at the soonest. Until then those items wait for a replan that fires for another reason.
_Avoid_: Refresh, sweep

**Locked block**:
An approved block, other than an auto block not yet started. A replan never moves it or removes it.
_Avoid_: Pinned block, fixed block, confirmed block

**Auto-approve**:
The setting (on by default) that approves each revision as soon as Claude submits it, as Approve all would.
_Avoid_: Auto-accept, auto-confirm

**Auto block**:
A block an auto-approved revision placed. Until it starts, and until Lisul moves it, a later revision may move or remove it; then it is a locked block.
_Avoid_: Soft block, tentative block

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

**Shutdown line**:
When the day's plan window ends: the time Lisul set for the day, else when wind-down starts (5 pm to 11 pm), else 5 pm.
_Avoid_: Cutoff, end of day

**Pace**:
For one kind of task, the median of actual time over estimate, which shows how far off Lisul's guesses run.
_Avoid_: Speed, velocity, accuracy

**Workload cap**:
The most planned work a day may hold. On a day with Oura numbers it follows his readiness and how long he slept.
_Avoid_: Daily limit, capacity, budget

**Horizon**:
The days from today to a task's due date, however far off. Horizon planning gives each undone task with a due date planned minutes on the working days in its horizon.
_Avoid_: Backlog plan, long-range plan

**Allocation**:
The minutes of one task planned on one day of its horizon. Future days hold minutes only, never times; today's become blocks in the morning plan or a replan.
_Avoid_: Ghost block, tentative block, reservation

**Today's minutes**:
A task's allocation on the day being planned, less any part past the workload cap. The morning plan or a replan turns it into blocks; it never moves minutes to another day.
_Avoid_: Daily quota, today's share

**Re-flow**:
Server code working the allocations out again after something changed, keeping the last ones and moving only the minutes the change forces. It is not a replan: Claude takes no part.
_Avoid_: Reschedule, rebalance

**Frozen day**:
A day a re-flow leaves as it is: tomorrow, once today is shut down. Today's locked blocks are fixed the same way.
_Avoid_: Locked day

**Working day**:
A day of the horizon with free time for tasks, or one that is frozen or holds a locked block.
_Avoid_: Business day, weekday

**Target day**:
The day horizon planning aims to finish a task by: the last working day before its due day, when that is 2 or more days off, else the due day; earlier still when the days after it can't hold a fifth of the task's minutes. The days after it are the task's buffer.
_Avoid_: Soft deadline, internal deadline

**Slack**:
How many minutes of free time a task has to spare by its due day, after every task due by then.
_Avoid_: Float, margin

**On track**:
A task whose allocations finish by its target day with at least one day's chunk of slack.
_Avoid_: On time, safe

**Tight**:
A task whose allocations fit by its due day only by using its buffer, or with less than one day's chunk of slack, or that is already overdue. Tight and won't fit are what at risk means for a task with a due date.
_Avoid_: Close

**Won't fit**:
A task with more minutes left than its horizon's free time holds at 90 minutes a day (120 for programming and writing). The rest sits on its due day past the workload cap, with the hours short, and is never dropped.
_Avoid_: Overbooked, impossible

**Wake time**:
When Lisul got up today, from the end of his main sleep on his Oura ring. The plan starts 30 minutes after it.
_Avoid_: Wake-up, alarm, start time

**Light start**:
The first stretch of the day, until 90 minutes after his wake (120 after a short night), when only light tasks go: mail, admin, or 30 minutes or less. The hardest task comes right after it.
_Avoid_: Warm-up, slow start

**Short night**:
A main sleep under 6 hours, or a sleep debt: three nights averaging under 6.5 hours. It gives a lighter day.
_Avoid_: Bad night, tired day

**Long break**:
A gap of 15 minutes or more, due after about 3 hours of blocks; on a day of 4 hours or more of blocks, one of 30 minutes falls in the middle third of the plan window for a meal.
_Avoid_: Rest, pause

**Typical wake**:
The median wake time of his last 14 weekday nights, or of his last 14 weekend nights, used until today's wake time has synced.
_Avoid_: Usual wake, average wake, chronotype

**Habit**:
A recurring time Lisul protects, such as gym or lunch, with set days, an ideal time, a flex window and a defence level (flexible or firm).
_Avoid_: Routine, recurring task, ritual

**Morning plan**:
The proposal Claude makes on its own at 6:07 each morning, delivered with the morning brief for Lisul to approve or skip, or approved at once with Auto-approve on.
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

**First step**:
The concrete action a block starts with, such as "open HW4, do Q1", which its nudge leads with.
_Avoid_: Subtask, next action

**Next free slot**:
The first quarter hour later today that holds a block, which a Didn't start answer offers as a button that moves the block there.
_Avoid_: Reschedule, retry

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

**Now message**:
The one pinned Telegram message that says which block is on until when, and what's next. It is edited in place, never sent again, so it makes no notification.
_Avoid_: Status, pinned nudge, ticker

**Quiet hours**:
11 pm to 8 am, when nothing is sent.
_Avoid_: Do not disturb, sleep mode
