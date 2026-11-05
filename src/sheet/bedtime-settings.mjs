// Settings, Oura, Sleep (docs/sheet-v5.md, "Wind-down"): the bedtime target, Ease in and the
// Wind-down switch (settings.bedtime_target, bedtime_ease, wind_down_on), and tonight's line from
// bedtime.mjs. A new target, or turning Ease in on, starts easing from tonight (bedtime_set_on).
// The toggles keep one label and say their state with aria-pressed, as Replans does.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { bedtimeFor, bedtimeStatus, tonight } from "./bedtime.mjs";
import { actHooks, failed, render, settingsHooks, state } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

function draw() {
  const s = state.settings ?? {};
  const input = $("#sheet-bedtime");
  if (document.activeElement !== input) input.value = s.bedtime_target ? s.bedtime_target.slice(0, 5) : "";
  $('[data-act="bedtime-ease"]').setAttribute("aria-pressed", String(s.bedtime_ease !== false));
  $('[data-act="wind-down"]').setAttribute("aria-pressed", String(s.wind_down_on !== false));
  const tz = SHEET.timeZone;
  const b = bedtimeFor(tonight(new Date(), tz), { settings: s, sleep: state.sleep, sleepTimes: state.sleepTimes, tz });
  $("[data-bedtime-note]").textContent = bedtimeStatus(b, s);
}

async function save(patch) {
  try {
    await api.saveSettings(patch);
    state.settings = { ...state.settings, ...patch };
    draw();
    render();
  } catch (e) { failed(e); }
}

const night = () => tonight(new Date(), SHEET.timeZone);

function saveTarget() {
  const v = $("#sheet-bedtime").value;
  const bedtime_target = v ? `${v}:00` : null;
  if (bedtime_target === (state.settings?.bedtime_target ?? null)) return draw();
  return save({ bedtime_target, bedtime_set_on: bedtime_target ? night() : null });
}

function toggleEase() {
  const bedtime_ease = state.settings?.bedtime_ease === false;
  return save(bedtime_ease ? { bedtime_ease, bedtime_set_on: night() } : { bedtime_ease });
}

export function setupBedtimeSettings(node) {
  root = node;
  settingsHooks.push(async () => {
    state.sleepTimes = await api.listSleepTimes();
    draw();
  });
  actHooks["save-bedtime"] = saveTarget;
  actHooks["bedtime-ease"] = toggleEase;
  actHooks["wind-down"] = () => save({ wind_down_on: state.settings?.wind_down_on === false });
}
