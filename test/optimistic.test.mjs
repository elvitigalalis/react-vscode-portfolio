// Changes shown before they are saved (src/sheet/optimistic.mjs): what shows always ends up as
// what the server holds, whatever order saves, failures and loads come in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ledger } from "../src/sheet/optimistic.mjs";

// A table of rows and a ledger over it; `rows` can be swapped wholesale, as a load does.
function setup(seed = { t1: { id: "t1", done: false, day: "2026-11-03" } }) {
  const box = { rows: new Map(Object.entries(seed)) };
  const l = ledger({ get: (k) => box.rows.get(k), set: (k, r) => box.rows.set(k, r) });
  return { box, l };
}
// A save the test settles by hand.
function later() {
  let ok, no;
  const p = new Promise((a, b) => { ok = a; no = b; });
  return { p, ok, no, save: () => p };
}

test("a change shows at once and the saved row replaces it", async () => {
  const { box, l } = setup();
  const s = later();
  const done = l.write("t1", { done: true }, s.save);
  assert.equal(box.rows.get("t1").done, true);
  assert.equal(l.pending("t1"), true);
  s.ok({ id: "t1", done: true, day: "2026-11-03", done_at: "x" });
  await done;
  assert.equal(box.rows.get("t1").done_at, "x");
  assert.equal(l.pending("t1"), false);
});

test("a save that answers nothing keeps the change as saved", async () => {
  const { box, l } = setup();
  await l.write("t1", { done: true }, async () => null);
  assert.equal(box.rows.get("t1").done, true);
});

test("a failed save puts the row back and rejects", async () => {
  const { box, l } = setup();
  await assert.rejects(l.write("t1", { done: true }, async () => { throw new Error("500"); }), /500/);
  assert.equal(box.rows.get("t1").done, false);
  assert.equal(l.pending("t1"), false);
});

test("saves of one row run in order, one after the other", async () => {
  const { box, l } = setup();
  const a = later();
  const order = [];
  const first = l.write("t1", { day: "2026-11-04" }, () => { order.push("a"); return a.p; });
  const second = l.write("t1", { day: "2026-11-05" }, async () => { order.push("b"); return { id: "t1", done: false, day: "2026-11-05" }; });
  await Promise.resolve();
  assert.deepEqual(order, ["a"]);
  assert.equal(box.rows.get("t1").day, "2026-11-05");
  a.ok({ id: "t1", done: false, day: "2026-11-04" });
  await first;
  // The later change still shows while its save is out.
  assert.equal(box.rows.get("t1").day, "2026-11-05");
  await second;
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(box.rows.get("t1").day, "2026-11-05");
});

test("when the first of two saves fails, the second still shows and lands", async () => {
  const { box, l } = setup();
  const first = l.write("t1", { done: true }, async () => { throw new Error("500"); });
  const second = l.write("t1", { day: "2026-11-04" }, async () => ({ id: "t1", done: false, day: "2026-11-04" }));
  await assert.rejects(first);
  assert.deepEqual(box.rows.get("t1"), { id: "t1", done: false, day: "2026-11-04" });
  await second;
  assert.deepEqual(box.rows.get("t1"), { id: "t1", done: false, day: "2026-11-04" });
});

test("when both saves fail the row is the server's again, not the first change", async () => {
  const { box, l } = setup();
  const boom = async () => { throw new Error("500"); };
  const a = l.write("t1", { day: "2026-11-04" }, boom);
  const b = l.write("t1", { day: "2026-11-05" }, boom);
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(box.rows.get("t1").day, "2026-11-03");
});

test("a load that read before a save landed keeps the saved row", async () => {
  const { box, l } = setup();
  const since = l.now();
  await l.write("t1", { done: true }, async () => ({ id: "t1", done: true, day: "2026-11-03" }));
  // The load's read came back from before the save.
  box.rows = new Map([["t1", { id: "t1", done: false, day: "2026-11-03" }]]);
  l.keep(since);
  assert.equal(box.rows.get("t1").done, true);
  // The next load reads after it, and its rows stand.
  const next = l.now();
  box.rows = new Map([["t1", { id: "t1", done: true, day: "2026-11-03", title: "new" }]]);
  l.keep(next);
  assert.equal(box.rows.get("t1").title, "new");
});

test("a load while a save is out shows the change on the new row", async () => {
  const { box, l } = setup();
  const s = later();
  const done = l.write("t1", { done: true }, s.save);
  const since = l.now();
  box.rows = new Map([["t1", { id: "t1", done: false, day: "2026-11-03", title: "renamed" }]]);
  l.keep(since);
  assert.deepEqual(box.rows.get("t1"), { id: "t1", done: true, day: "2026-11-03", title: "renamed" });
  // It fails: the row is the one just read, not the copy from before the load.
  s.no(new Error("500"));
  await assert.rejects(done);
  assert.deepEqual(box.rows.get("t1"), { id: "t1", done: false, day: "2026-11-03", title: "renamed" });
});

test("a load doesn't roll back a row whose earlier save landed while a later one is out", async () => {
  const { box, l } = setup();
  const since = l.now();
  await l.write("t1", { day: "2026-11-04" }, async () => ({ id: "t1", done: false, day: "2026-11-04" }));
  const s = later();
  const second = l.write("t1", { done: true }, s.save);
  box.rows = new Map([["t1", { id: "t1", done: false, day: "2026-11-03" }]]); // read before the first landed
  l.keep(since);
  assert.deepEqual(box.rows.get("t1"), { id: "t1", done: true, day: "2026-11-04" });
  s.no(new Error("500"));
  await assert.rejects(second);
  assert.deepEqual(box.rows.get("t1"), { id: "t1", done: false, day: "2026-11-04" });
});

test("a new row noted as saved survives a load that read before it", () => {
  const { box, l } = setup();
  const since = l.now();
  l.note("t9", { id: "t9", title: "Buy milk" });
  box.rows = new Map();
  l.keep(since);
  assert.equal(box.rows.get("t9").title, "Buy milk");
});

test("a row it doesn't have just saves", async () => {
  const { box, l } = setup();
  assert.equal(await l.write("zz", { done: true }, async () => "saved"), "saved");
  assert.equal(box.rows.has("zz"), false);
});

test("a row forgotten while its save is out isn't put back when the save lands", async () => {
  const { box, l } = setup();
  const s = later();
  const done = l.write("t1", { done: true }, s.save);
  l.forget("t1");
  box.rows.delete("t1");
  s.ok({ id: "t1", done: true, day: "2026-11-03" });
  await done;
  assert.equal(box.rows.has("t1"), false);
  assert.equal(l.pending("t1"), false);
});

test("nor when it fails", async () => {
  const { box, l } = setup();
  const s = later();
  const done = l.write("t1", { done: true }, s.save);
  l.forget("t1");
  box.rows.delete("t1");
  s.no(new Error("gone"));
  await assert.rejects(done);
  assert.equal(box.rows.has("t1"), false);
});
