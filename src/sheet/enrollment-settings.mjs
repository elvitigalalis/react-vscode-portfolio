// Settings, Enrollment (docs/sheet-v5.md, "/plan"): when spring enrollment opens, entered once.
// The server's ical-sync turns it into one private task at that time ("Enrollment opens"), within
// the hour. Blank clears it, and the task with it until it's done.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { actHooks, failed, settingsHooks, state } from "./planner.mjs";
import { enrollmentFromInput, enrollmentInput } from "./sources.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

function draw() {
  $("#sheet-enroll").value = enrollmentInput(state.settings?.enrollment_at, SHEET.timeZone);
  $("[data-enroll-note]").textContent = "";
}

async function save() {
  const enrollment_at = enrollmentFromInput($("#sheet-enroll").value, SHEET.timeZone);
  if (enrollment_at === undefined) return void ($("[data-enroll-note]").textContent = "A date and a time, or blank.");
  try {
    await api.saveSettings({ enrollment_at });
    state.settings = { ...state.settings, enrollment_at };
    $("[data-enroll-note]").textContent = enrollment_at ? "Saved. The task appears within the hour." : "Cleared.";
  } catch (e) { failed(e); }
}

export function setupEnrollmentSettings(node) {
  root = node;
  settingsHooks.push(draw);
  actHooks["save-enroll"] = save;
}
