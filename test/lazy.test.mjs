// lazy (src/sheet/logic.mjs): a module loaded on demand is loaded once, and a failed load is
// tried again instead of failing for good (planner.mjs's snapshot()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lazy } from "../src/sheet/logic.mjs";

test("a load runs once and its result is kept", async () => {
  let runs = 0;
  const get = lazy(async () => ++runs);
  assert.equal(await get(), 1);
  assert.equal(await get(), 1);
  assert.equal(runs, 1);
});

test("a failed load is tried again on the next call", async () => {
  let runs = 0;
  const get = lazy(async () => { if (++runs === 1) throw new Error("offline"); return "module"; });
  await assert.rejects(get(), /offline/);
  assert.equal(await get(), "module");
  assert.equal(runs, 2);
});
