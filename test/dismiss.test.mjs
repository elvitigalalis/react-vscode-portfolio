// lightDismiss in dismiss.mjs: a press and a click both on the backdrop close the dialog the way
// its Close button does; anything that starts or ends inside leaves it open. A fake dialog
// records its listeners and whether close() ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { lightDismiss, onBackdrop, menuStep, holdEscape } from "../src/sheet/dismiss.mjs";

function fakeDialog() {
  const on = {};
  const d = {
    closed: 0,
    addEventListener(type, fn) { on[type] = fn; },
    getBoundingClientRect: () => ({ left: 100, right: 300, top: 100, bottom: 300 }),
    close() { this.closed++; },
    fire(type, target, x, y) { on[type]({ target: target ?? d, clientX: x, clientY: y }); },
  };
  return d;
}
const inner = {};

test("onBackdrop: only the dialog itself, outside its box", () => {
  const d = fakeDialog();
  assert.equal(onBackdrop(d, { target: d, clientX: 50, clientY: 50 }), true);
  assert.equal(onBackdrop(d, { target: d, clientX: 200, clientY: 200 }), false, "its padding");
  assert.equal(onBackdrop(d, { target: inner, clientX: 50, clientY: 50 }), false);
});

test("lightDismiss: press and click on the backdrop close it, once", () => {
  const d = fakeDialog();
  lightDismiss(d);
  d.fire("pointerdown", d, 20, 20);
  d.fire("click", d, 20, 20);
  assert.equal(d.closed, 1);
  d.fire("click", d, 20, 20);
  assert.equal(d.closed, 1, "a click with no press of its own");
});

test("lightDismiss: a drag out of the dialog, or into it, leaves it open", () => {
  const d = fakeDialog();
  lightDismiss(d);
  d.fire("pointerdown", inner, 200, 200);
  d.fire("click", d, 20, 20);
  d.fire("pointerdown", d, 20, 20);
  d.fire("click", inner, 200, 200);
  d.fire("pointerdown", d, 200, 200);
  d.fire("click", d, 200, 200);
  assert.equal(d.closed, 0);
});

test("/plan: every dialog gets lightDismiss, and only holdEscape can keep one open on Escape", () => {
  assert.match(readFileSync("src/sheet/planner.mjs", "utf8"), /for \(const d of root\.querySelectorAll\("dialog"\)\) lightDismiss\(d\)/);
  // The two documented holds (docs/sheet.md, Shutdown while Finish saves; docs/sheet-focus.md,
  // Escape in Stop's question) go through holdEscape; nothing else listens for cancel.
  const holds = [];
  for (const f of readdirSync("src/sheet")) {
    const src = readFileSync(`src/sheet/${f}`, "utf8");
    if (f !== "dismiss.mjs") assert.doesNotMatch(src, /addEventListener\(\s*["']cancel["']|\.oncancel\b|oncancel:/, `${f} listens for cancel`);
    if (f !== "dismiss.mjs" && /\bholdEscape\(dialog/.test(src)) holds.push(f);
    assert.doesNotMatch(src, /createElement\(["']dialog/, `${f} makes a dialog outside the page`);
  }
  assert.deepEqual(holds.sort(), ["focus-view.mjs", "shutdown-view.mjs"]);
});

test("holdEscape: Escape closes as usual unless the dialog holds it, and the hold runs its own step", () => {
  const on = {};
  const d = { addEventListener(type, fn) { on[type] = fn; } };
  let held = false, steps = 0;
  holdEscape(d, () => { if (!held) return false; steps++; return true; });
  const escape = () => { const e = { stopped: false, preventDefault() { this.stopped = true; } }; on.cancel(e); return e.stopped; };
  assert.equal(escape(), false, "not held: the browser closes it");
  held = true;
  assert.equal(escape(), true, "held: stays open");
  assert.equal(steps, 1);
});

test("menuStep: arrow keys move through a menu's items and wrap; Home and End jump; other keys don't move", () => {
  assert.equal(menuStep("ArrowDown", 0, 4), 1);
  assert.equal(menuStep("ArrowDown", 3, 4), 0);
  assert.equal(menuStep("ArrowUp", 0, 4), 3);
  assert.equal(menuStep("ArrowUp", -1, 4), 3); // focus not on an item yet
  assert.equal(menuStep("Home", 2, 4), 0);
  assert.equal(menuStep("End", 0, 4), 3);
  assert.equal(menuStep("Enter", 1, 4), null);
  assert.equal(menuStep("ArrowDown", 0, 0), null);
});
