// Voice capture (src/sheet/voice.mjs): what Haiku's answer may become. Expected values are by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText } from "../src/sheet/messages.mjs";
import { captureRows, rawRow, replyLine, systemPrompt, toolInput } from "../src/sheet/voice.mjs";

const TODAY = "2026-11-09"; // a Monday

test("systemPrompt names today's weekday", () => assert.match(systemPrompt(TODAY), /Mon 2026-11-09/));

test("captureRows: a deadline with no day goes to the Inbox with its due date", () => {
  const [r] = captureRows({ tasks: [{ title: "Email Priya", due: "2026-11-13" }] }, TODAY);
  assert.deepEqual([r.title, r.day, r.list, r.due], ["Email Priya", null, "Inbox", "2026-11-13"]);
});

test("captureRows: refuses all of a bad answer, so the raw words stay", () => {
  assert.equal(captureRows({ tasks: [{ title: "ok" }, { title: "x", day: "friday" }] }, TODAY), null);
  assert.equal(captureRows({ tasks: [] }, TODAY), null);
  assert.equal(captureRows(undefined, TODAY), null);
  assert.equal(captureRows({ tasks: [{ title: "x", at_time: "15:00", day: TODAY }] }, TODAY), null);
});

test("rawRow: a private Inbox task on one line", () => {
  assert.deepEqual(rawRow("call\nmom", 12), { title: "call mom", list: "Inbox", public: false, position: 12 });
});

test("rawRow fits the title column", () => assert.equal(rawRow("x".repeat(8000), 1).title.length, 500));

test("captureRows: a why from the model never reaches the rows", () => {
  const rows = captureRows({ tasks: [{ title: "A", why: "because" }, { title: "B" }] }, TODAY);
  assert.deepEqual(Object.keys(rows[0]), Object.keys(rows[1]));
  assert.equal("why" in rows[0], false);
});

test("toolInput: only a finished tool call counts", () => {
  const content = [{ type: "tool_use", name: "add_tasks", input: { tasks: [{ title: "A" }] } }];
  assert.deepEqual(toolInput({ stop_reason: "tool_use", content }), content[0].input);
  assert.equal(toolInput({ stop_reason: "max_tokens", content }), undefined);
  assert.equal(toolInput({ stop_reason: "tool_use", content: [{ type: "text", text: "hi" }] }), undefined);
  assert.equal(toolInput(null), undefined);
});

test("blank dictation is refused before anything is saved", () => {
  for (const blank of ["", "  \n\t ", null, 42]) assert.equal(messageText(blank), null);
});

test("replyLine says what was added", () => {
  assert.equal(replyLine(null), "Saved to Inbox");
  assert.equal(replyLine([{ title: "Email Priya", due: "2026-11-13" }]), "Added: Email Priya, due Fri");
  assert.equal(replyLine([{ title: "Gas", day: "2026-11-10" }]), "Added: Gas, Tue");
  assert.equal(replyLine([{ title: "A" }, { title: "B" }]), "Added 2: A; B");
});
