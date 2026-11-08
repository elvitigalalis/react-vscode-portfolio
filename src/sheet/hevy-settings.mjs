// Settings, Hevy (docs/sheet-hevy.md): when hevy-sync last read his workouts, its last error, a
// field to paste the API key, Disconnect, and the Gym start nudge (settings.gym_nudge_on). The
// key goes to hevy_key_save, which keeps it in Vault; nothing ever reads it back, so the field is
// write-only: cleared after Save and never filled in. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { hevyError, hevyKey, hevyStatus } from "./hevy-status.mjs";
import { actHooks, failed, settingsHooks, state } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);
const nudgeOn = () => Boolean(state.settings?.gym_nudge_on);

async function draw() {
  const account = await api.hevyAccount();
  $("[data-hevy-status]").textContent = hevyStatus(account, new Date(), SHEET.timeZone);
  $("[data-hevy-error]").textContent = hevyError(account);
  $("[data-hevy-form] button").textContent = account ? "Save new key" : "Save";
  $('[data-act="hevy-disconnect"]').hidden = !account;
  $('[data-act="gym-nudge"]').setAttribute("aria-pressed", String(nudgeOn()));
  $("[data-gym-nudge-note]").textContent = nudgeOn() ? "On" : "Off";
}

async function save(e) {
  e.preventDefault();
  const field = $("#sheet-hevy-key");
  const key = hevyKey(field.value);
  field.value = "";
  if (!key) return void ($("[data-hevy-note]").textContent = "That isn't a Hevy API key. Copy it again from Hevy.");
  try {
    await api.saveHevyKey(key);
    $("[data-hevy-note]").textContent = "Saved. Your workouts sync within 15 minutes.";
    await draw();
  } catch (err) { failed(err); }
}

async function disconnect() {
  if (!confirm("Disconnect Hevy? The key is deleted, and so is every workout copied from Hevy. Your workouts in Hevy stay.")) return;
  try {
    await api.disconnectHevy();
    $("[data-hevy-note]").textContent = "";
    await draw();
    $("#sheet-hevy-key").focus();
  } catch (err) { failed(err); }
}

async function toggleNudge() {
  const change = { gym_nudge_on: !nudgeOn() };
  try {
    await api.saveSettings(change);
    state.settings = { ...state.settings, ...change };
    await draw();
  } catch (err) { failed(err); }
}

export function setupHevySettings(node) {
  root = node;
  settingsHooks.push(draw);
  $("[data-hevy-form]").addEventListener("submit", save);
  actHooks["hevy-disconnect"] = disconnect;
  actHooks["gym-nudge"] = toggleNudge;
}
