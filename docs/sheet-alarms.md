# iPhone alarms from The Sheet

Settings → Oura → Sleep on /plan has **Set iPhone alarm for 9:40 am**. Tapping it on the iPhone
opens Shortcuts, which runs your **Sheet Alarm** shortcut with "09:40" as its input, and the
shortcut adds the alarm in Clock. The time is your usual wake for the next morning (weekday or
weekend), or 9:00 am until Oura has 3 wakes of that kind. Logic: `src/sheet/alarm.mjs`.

## What a web page can and can't do (checked 2026-11-06, iOS 18 / iOS 26)

- **No web API sets a Clock alarm.** Safari has no alarm API; Apple's own alarm framework,
  AlarmKit (iOS 26), is for native apps only
  ([developer.apple.com/documentation/alarmkit](https://developer.apple.com/documentation/alarmkit)).
- **A Shortcut can.** Clock's actions in Shortcuts are Create Alarm, Toggle Alarm, Get All Alarms
  and Start Timer ([What's new in Shortcuts](https://support.apple.com/en-us/101583), iOS 16.1
  note). Create Alarm takes a time, a label and repeat days; its Time can be a variable (third-party
  reference: [matthewcassinelli.com/actions/create-alarm](https://matthewcassinelli.com/actions/create-alarm/)).
  There is no "delete alarm" action, so each run adds a new alarm.
- **A link can run a named shortcut with text input**:
  `shortcuts://run-shortcut?name=[name]&input=text&text=[text]`
  ([Run a shortcut using a URL scheme](https://support.apple.com/guide/shortcuts/run-a-shortcut-from-a-url-apd624386f42/ios)).
  It needs a tap, and iOS may ask "Open in Shortcuts?" the first time.
- **Telegram:** a `shortcuts://` link isn't a web link, so Telegram doesn't make it tappable and
  inline buttons take only http(s) or tg:// URLs. Not added to the bedtime nudge.
- **Fully automatic (not built).** A personal automation can run at a Time of Day, and you can
  turn off asking so it runs without a tap
  ([Intro to personal automation](https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios)).
  Get Contents of URL plus Get Dictionary Value can read a JSON answer
  ([Request your first API](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios)).
  So a nightly automation could fetch the time and set the alarm itself, but it would need a new
  server endpoint and a token stored in plain text inside the shortcut. That isn't worth it for
  one tap a night, and each run would still pile up alarms. Revisit if the tap gets old.

## Build the shortcut (once, about 2 minutes)

1. Open **Shortcuts**, tap **+** (top right) to make a new shortcut.
2. Tap the name at the top, choose **Rename**, and name it exactly **Sheet Alarm**.
3. Tap **Search Actions**, type **Get Dates from Input**, and tap it. Its input should read
   **Shortcut Input**; if it doesn't, tap the blue field and pick **Shortcut Input**.
4. Search **Create Alarm** (Clock) and tap it. (If iOS calls it something else, search "Alarm".)
5. In Create Alarm, tap the blue time field, choose **Select Variable**, and tap **Dates** (the
   output of step 3).
6. Tap **Show More** on Create Alarm and set **Label** to `Sheet wake`. Leave Repeat empty.
7. Tap **Done**.

## Use it

1. On your iPhone, open lisul-elvi.com/plan → Settings → Oura → Sleep.
2. Tap **Set iPhone alarm for …**. Allow "Open in Shortcuts?" if asked. The alarm appears in Clock.
3. Every so often, swipe away old "Sheet wake" alarms in Clock (Shortcuts can't delete them).

To test without the page, open this in Safari on the phone:
`shortcuts://run-shortcut?name=Sheet%20Alarm&input=text&text=07%3A05` should add a 7:05 am alarm.
