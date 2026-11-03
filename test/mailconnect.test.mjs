// The mail-connect helpers (src/sheet/mailconnect.mjs), beyond the verification tests in
// test/v3-f.verify.test.mjs: the edges of the signed state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signState, verifyState } from "../src/sheet/mailconnect.mjs";

const SECRET = "test-state-secret-one";
const NOW = Date.parse("2026-11-03T14:00:00Z");

test("a state stamped more than a minute ahead of the clock is refused", async () => {
  const ahead = await signState({ owner: "a@example.com" }, SECRET, NOW + 5 * 60_000);
  assert.equal(await verifyState(ahead, SECRET, NOW), null);
  const skew = await signState({ owner: "a@example.com" }, SECRET, NOW + 30_000);
  assert.deepEqual(await verifyState(skew, SECRET, NOW), { owner: "a@example.com" });
});

test("a state is refused at 10 minutes and one millisecond, kept at exactly 10", async () => {
  const state = await signState({ n: 1 }, SECRET, NOW);
  assert.deepEqual(await verifyState(state, SECRET, NOW + 600_000), { n: 1 });
  assert.equal(await verifyState(state, SECRET, NOW + 600_001), null);
});

test("a state with padding added to its mac is refused", async () => {
  const state = await signState({ n: 1 }, SECRET, NOW);
  assert.equal(await verifyState(`${state}=`, SECRET, NOW), null);
});
