// The Log under the Someday lists (logic.mjs, somedayLog). Expected values are by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { somedayLog } from "../src/sheet/logic.mjs";

test("somedayLog: done Someday tasks only, newest first", () => {
  const rows = [
    { id: "old", day: null, done: true, updated_at: "2026-11-01T00:00:00Z" },
    { id: "new", day: null, done: true, updated_at: "2026-11-08T00:00:00Z" },
    { id: "open", day: null, done: false },
    { id: "dated", day: "2026-11-08", done: true },
    { id: "step", day: null, done: true, project_id: "p" },
  ];
  assert.deepEqual(somedayLog(rows).map((t) => t.id), ["new", "old"]);
});
