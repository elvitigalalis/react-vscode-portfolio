// How to raise his Oura scores (docs/sheet-v5.md, "Tips"): one short tip per score contributor,
// each from Oura's own guidance (the source beside it), and a picker that chooses today's one or
// two. Rule-based code, never Claude (docs/adr/0005): /plan's day dialog and today's chip show
// them, and the telegram function puts one in the brief, and an evening one in Wind down.
import { addDays, formatClock } from "./logic.mjs";

const SLEEP_SCORE = "https://support.ouraring.com/hc/en-us/articles/360025445574-Sleep-Score";
const SLEEP_CONTRIB = "https://support.ouraring.com/hc/en-us/articles/360057792293-Sleep-Contributors";
const READINESS = "https://support.ouraring.com/hc/en-us/articles/360025589793-Readiness-Score";
const READINESS_CONTRIB = "https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors";
const HRV = "https://support.ouraring.com/hc/en-us/articles/360025441974-Heart-Rate-Variability";
const RHR = "https://support.ouraring.com/hc/en-us/articles/360025588793-Resting-Heart-Rate";
const TEMP = "https://support.ouraring.com/hc/en-us/articles/360025587493-Body-Temperature";

// ctx: { bed, windDown, target } as clock text ("12:30 am") or null, and gym ("5:00 pm") or null.
// evening: a tip about tonight, which Wind down may carry too.
export const TIPS = {
  total_sleep: { score: "sleep", label: "Total sleep", evening: true, source: SLEEP_SCORE,
    text: (c) => `Give yourself an 8-9 hour window in bed${c.bed ? `: lights out at ${c.bed}` : ""}.` },
  efficiency: { score: "sleep", label: "Efficiency", evening: false, source: SLEEP_SCORE,
    text: () => "Keep the bed for sleep: if you're awake for long, get up and read in dim light, then try again." },
  restfulness: { score: "sleep", label: "Restfulness", evening: false, source: SLEEP_SCORE,
    text: () => "Cooler, darker room, and no caffeine after 2 pm." },
  rem_sleep: { score: "sleep", label: "REM", evening: true, source: SLEEP_CONTRIB,
    text: () => "Skip alcohol tonight and keep to the same wake time: REM comes late in the night." },
  deep_sleep: { score: "sleep", label: "Deep", evening: true, source: SLEEP_SCORE,
    text: () => "No heavy or sugary meal in the 3 hours before bed." },
  latency: { score: "sleep", label: "Latency", evening: true, source: SLEEP_SCORE,
    text: (c) => `Screens off and lights dim for the last hour${c.windDown ? `: your wind-down starts at ${c.windDown}` : ""}.` },
  timing: { score: "sleep", label: "Timing", evening: true, source: SLEEP_SCORE,
    text: (c) => `Go to bed within 30 minutes of the same time each night${c.target ? `; your bedtime is easing toward ${c.target}` : ""}.` },
  activity_balance: { score: "readiness", label: "Activity balance", evening: false, source: READINESS,
    text: () => "Light movement today: a 20-minute walk or stretching, not a hard session." },
  body_temperature: { score: "readiness", label: "Body temperature", evening: false, source: TEMP,
    text: () => "Your temperature is off your normal: take it easy and rest if you feel run down." },
  hrv_balance: { score: "readiness", label: "HRV balance", evening: false, source: HRV,
    text: () => "Your body is under strain: an easier day and an early night help HRV recover." },
  previous_day_activity: { score: "readiness", label: "Previous day", evening: false, source: READINESS_CONTRIB,
    text: () => "Yesterday was heavy or idle: aim for steady, moderate movement today." },
  previous_night: { score: "readiness", label: "Previous night", evening: true, source: READINESS_CONTRIB,
    text: (c) => `Last night was short or restless: protect tonight's sleep${c.bed ? ` and be in bed by ${c.bed}` : ""}.` },
  recovery_index: { score: "readiness", label: "Recovery index", evening: true, source: READINESS,
    text: (c) => `Finish your last meal and workout 3+ hours before bed${c.gym && c.bed ? ` (gym at ${c.gym}, bed at ${c.bed})` : ""}.` },
  resting_heart_rate: { score: "readiness", label: "Resting heart rate", evening: true, source: RHR,
    text: () => "No late meal, alcohol or hard workout tonight, so your heart rate can settle early." },
  sleep_balance: { score: "readiness", label: "Sleep balance", evening: true, source: READINESS_CONTRIB,
    text: () => "Several short nights in a row: protect 8 hours tonight." },
  sleep_regularity: { score: "readiness", label: "Sleep regularity", evening: true, source: READINESS_CONTRIB,
    text: () => "Same bedtime and wake time every day, weekends too." },
};

// "Pay attention" and "fair" both: under 70 (Oura's bands).
const LOW = 70;
const MAX = 2;
const BACK = 13;

// A day's candidates: its contributors under 70, lowest first (ties by name, so it's stable).
const low = (c) => Object.entries(c ?? {}).filter(([k, v]) => TIPS[k] && Number.isInteger(v) && v < LOW)
  .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));

// Today's tips: [{ key, value, score, label, text, source, evening }], at most 2, from the
// lowest contributors under 70, leaving out a tip picked on either of the 2 days before. Days are
// worked forward from 13 days back, so every view picks the same. rows are sleep_days rows with
// contributors.
export function pickTips(rows, day, ctx = {}) {
  const byDay = new Map((rows ?? []).map((r) => [r.day, r.contributors]));
  const picked = new Map();
  for (let i = BACK; i >= 0; i--) {
    const d = addDays(day, -i);
    const recent = new Set([...(picked.get(addDays(d, -1)) ?? []), ...(picked.get(addDays(d, -2)) ?? [])]);
    picked.set(d, low(byDay.get(d)).filter(([k]) => !recent.has(k)).slice(0, MAX).map(([k]) => k));
  }
  const c = byDay.get(day) ?? {};
  return picked.get(day).map((key) => {
    const t = TIPS[key];
    return { key, value: c[key], score: t.score, label: t.label, text: t.text(ctx), source: t.source, evening: t.evening };
  });
}

// The personal times a tip may use, from tonight's bedtime (bedtime.mjs) and the Gym habit's
// ideal time ("HH:MM:SS"), as clock text.
export function tipContext(bed, gymIdeal = null) {
  const clock = (m) => formatClock(m % 1440);
  const g = typeof gymIdeal === "string" ? Number(gymIdeal.slice(0, 2)) * 60 + Number(gymIdeal.slice(3, 5)) : null;
  return {
    bed: bed ? clock(bed.minutes) : null,
    windDown: bed ? clock(bed.wind_down) : null,
    target: bed?.source === "easing" && bed.target != null ? clock(bed.target) : null,
    gym: g == null ? null : formatClock(g),
  };
}
