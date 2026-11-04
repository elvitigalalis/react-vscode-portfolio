// Settings, Habits (docs/sheet-v5.md, "/plan"; v5 H1): the habits Claude places around tasks on
// their days, each with Remove, and a form to add one. Text goes in through textContent only.
import * as api from "./api.mjs";
import { actHooks, el, failed, settingsHooks } from "./planner.mjs";
import { habitLine, readHabit } from "./habits.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

async function draw() {
  const habits = await api.listHabits();
  $("[data-habits]").replaceChildren(...(habits.length ? habits.map((h) => {
    const remove = el("button", { type: "button", className: "sheet-link", textContent: "Remove", ariaLabel: `Remove ${h.name}` });
    remove.dataset.act = "habit-remove";
    remove.dataset.id = h.id;
    return el("li", {}, el("span", { textContent: habitLine(h) }), " ", remove);
  }) : [el("li", { className: "small", textContent: "No habits yet." })]));
}

async function add(e) {
  e.preventDefault();
  const form = $("[data-habit-form]");
  const f = new FormData(form);
  const { habit, error } = readHabit({ ...Object.fromEntries(f), days: f.getAll("days") });
  $("[data-habit-note]").textContent = error ?? "";
  if (error) return;
  try {
    await api.insertHabit({ ...habit, position: Date.now() / 1000 });
    form.reset();
    await draw();
  } catch (err) { failed(err); }
}

async function remove(e) {
  try {
    await api.deleteHabit(e.target.dataset.id);
    await draw();
    $("[data-habit-form] input").focus();
  } catch (err) { failed(err); }
}

export function setupHabitSettings(node) {
  root = node;
  settingsHooks.push(draw);
  $("[data-habit-form]").addEventListener("submit", add);
  actHooks["habit-remove"] = remove;
}
