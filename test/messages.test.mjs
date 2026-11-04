// Messages to Claude (src/sheet/messages.mjs, docs/sheet-messages.md): when the message function
// fires the morning task, what answer_messages accepts and how it turns local times into
// instants, and what read_planner adds for them. Expected values are worked out by hand.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFire } from "../src/sheet/messages.mjs";
import { fireText } from "../src/sheet/routine-fire.mjs";

const NOW = new Date("2026-11-04T15:00:00Z"); // 10:00 am EST
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const M1 = "0b6f3c1e-0000-4000-8000-000000000001";
const M2 = "0b6f3c1e-0000-4000-8000-000000000002";

// ---------------------------------------------------------------- shouldFire

test("shouldFire: fires when no other pending message was fired in the last 3 minutes", () => {
  assert.equal(shouldFire([], NOW), true);
  assert.equal(shouldFire([{ id: M1, fired_at: null }], NOW), true);
  assert.equal(shouldFire([{ id: M1, fired_at: ago(3) }], NOW), true);
  assert.equal(shouldFire([{ id: M1, fired_at: ago(10) }, { id: M2, fired_at: null }], NOW), true);
});

test("shouldFire: holds off while a message fired under 3 minutes ago is still pending, since that run reads this one too", () => {
  assert.equal(shouldFire([{ id: M1, fired_at: ago(2) }], NOW), false);
  assert.equal(shouldFire([{ id: M2, fired_at: null }, { id: M1, fired_at: ago(0.5) }], NOW), false);
});

test("fireText: a message fire says only its trigger", () => {
  assert.equal(fireText("message", {}), "trigger: message\nreasons: none");
});
