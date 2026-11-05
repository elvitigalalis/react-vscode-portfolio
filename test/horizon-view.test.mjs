// Horizon planning, part 2, on /plan (docs/sheet-horizon.md, "Part 2", 6): the state chip and
// the one quiet line per task (R11), worked out without the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { horizonChip, horizonLine } from "../src/sheet/horizon-view.mjs";

const TODAY = "2026-11-05"; // a Thursday
const alloc = (day, minutes, over_min = 0) => ({ task_id: "os", day, minutes, over_min });
const st = (extra = {}) => ({ state: "on_track", remaining_min: 240, short_min: 0, finish_day: "2026-11-07", ...extra });

test("horizonLine: what is left, the days it is on, and when it is done", () => {
  const a = [alloc("2026-11-05", 60), alloc("2026-11-06", 90), alloc("2026-11-07", 90)];
  assert.equal(horizonLine(st(), a, "2026-11-09", TODAY), "4h left · today 1h, Fri 1h30, Sat 1h30 · done Sat, 2 days spare");
  assert.equal(horizonLine(st({ finish_day: "2026-11-09" }), a, "2026-11-09", TODAY), "4h left · today 1h, Fri 1h30, Sat 1h30 · done Mon, no day spare");
});

test("horizonLine: past four days it says how many more, and a far day reads as a date", () => {
  const a = ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-16"].map((d) => alloc(d, 60));
  assert.equal(horizonLine(st({ remaining_min: 360, finish_day: "2026-11-16" }), a, "2026-11-17", TODAY),
    "6h left · today 1h, Fri 1h, Sat 1h, Sun 1h, +2 days · done Nov 16, 1 day spare");
});

test("horizonLine: won't fit says the hours short and the fixes; nothing left says so", () => {
  const a = [alloc("2026-11-05", 90), alloc("2026-11-06", 150, 60)];
  assert.equal(horizonLine(st({ state: "wont_fit", remaining_min: 240, short_min: 60, finish_day: "2026-11-06" }), a, "2026-11-06", TODAY),
    "4h left · today 1h30, Fri 2h30 · 1h short: move the due date, cut the estimate or raise a day's cap");
  assert.equal(horizonLine(st({ remaining_min: 0, finish_day: null }), [], "2026-11-06", TODAY), "Nothing left to plan");
});

test("horizonChip: On track, Tight, or Won't fit with the hours short", () => {
  assert.deepEqual(horizonChip(st()), { text: "On track", level: "ok" });
  assert.deepEqual(horizonChip(st({ state: "tight" })), { text: "Tight", level: "risk" });
  assert.deepEqual(horizonChip(st({ state: "wont_fit", short_min: 90 })), { text: "Won't fit · 1h30 short", level: "overdue" });
});
