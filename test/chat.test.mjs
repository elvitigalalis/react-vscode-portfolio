// Chat with the bot (docs/sheet-chat.md): src/sheet/chat.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addedResult, applyEvent, conversation, draftId, FAILED, finalText, MAX_TURNS, pieces, plain, plannerView, readReset,
  replyText, sentResult, sseEvents, systemBlocks, toolCalls, TOOLS, TURN_WINDOW_MS,
} from "../src/sheet/chat.mjs";

const settings = { telegram_chat_id: 42 };
const msg = (text, chat = 42) => ({ message: { message_id: 7, chat: { id: chat }, text } });
const now = new Date("2026-11-24T15:00:00Z");
const at = (minAgo) => new Date(now.getTime() - minAgo * 60_000).toISOString();

test("readReset: /new and /reset from his chat, not other texts or chats", () => {
  assert.deepEqual(readReset(msg("/new"), settings), { chat_id: 42, message_id: 7 });
  assert.ok(readReset(msg("/reset@SheetBot"), settings));
  assert.equal(readReset(msg("/new", 9), settings), null);
  assert.equal(readReset(msg("new chat"), settings), null);
  assert.equal(readReset(msg("/now"), settings), null);
});

test("conversation: turns after the last reset, oldest first, alternating, ending on his turn", () => {
  const rows = [
    { at: at(50), role: "user", text: "old" },
    { at: at(40), role: "reset", text: "" },
    { at: at(30), role: "assistant", text: "stray" },
    { at: at(20), role: "user", text: "a" },
    { at: at(15), role: "user", text: "b" },
    { at: at(10), role: "assistant", text: "c" },
    { at: at(5), role: "user", text: "d" },
  ].reverse();
  assert.deepEqual(conversation(rows, now), [
    { role: "user", content: "a\n\nb" },
    { role: "assistant", content: "c" },
    { role: "user", content: "d" },
  ]);
});

test("conversation: drops turns older than the window and keeps at most MAX_TURNS", () => {
  const old = { at: new Date(now.getTime() - TURN_WINDOW_MS - 1).toISOString(), role: "user", text: "stale" };
  assert.deepEqual(conversation([old], now), []);
  const many = Array.from({ length: MAX_TURNS + 10 }, (_, i) => ({ at: at(100 - i), role: i % 2 ? "assistant" : "user", text: String(i) }));
  many.push({ at: at(1), role: "user", text: "last" });
  const out = conversation(many, now);
  assert.ok(out.length <= MAX_TURNS);
  assert.equal(out[0].role, "user");
  assert.equal(out.at(-1).content.endsWith("last"), true);
});

test("plannerView: leaves out what changes every read and planning-run-only fields", () => {
  const v = plannerView({ now: "x", read_at: "x", run: {}, message_run: true, messages: [], messages_held: 0, triage_rules: [], tasks: [1], plan_day: "2026-11-24" });
  assert.deepEqual(v, { tasks: [1], plan_day: "2026-11-24" });
});

test("systemBlocks: instructions and planner cached, then local time", () => {
  const b = systemBlocks({ time_zone: "America/New_York", tasks: [], now: "drop me" }, now);
  assert.equal(b.length, 3);
  assert.deepEqual(b[1].cache_control, { type: "ephemeral" });
  assert.match(b[1].text, /^<planner>\n\{"time_zone":"America\/New_York","tasks":\[\]\}\n<\/planner>$/);
  assert.equal(b[2].text, "Now: Tuesday 2026-11-24, 10:00 (America/New_York).");
  assert.match(b[0].text, /untrusted/);
  assert.match(b[0].text, /no Markdown/);
});

test("TOOLS: add_tasks, send_to_planner and web search; nothing that deletes or sends", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ["add_tasks", "send_to_planner", "web_search"]);
});

test("applyEvent: puts a streamed reply together, text and tool input", () => {
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Adding " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "it." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "add_tasks", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"tasks\":[{\"ti" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "tle\":\"Email Priya\"}]}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ];
  const r = events.reduce(applyEvent, null);
  assert.equal(replyText(r), "Adding it.");
  assert.equal(r.stop_reason, "tool_use");
  assert.deepEqual(toolCalls(r), [{ type: "tool_use", id: "t1", name: "add_tasks", input: { tasks: [{ title: "Email Priya" }] } }]);
  assert.throws(() => applyEvent(r, { type: "error", error: { type: "overloaded_error" } }), /overloaded_error/);
});

test("applyEvent: drops citations so the block can go back to the API", () => {
  const r = applyEvent(null, { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: [] } });
  assert.equal("citations" in r.content[0], false);
});

test("sseEvents: whole events parsed, the tail carried", () => {
  const { events, rest } = sseEvents("event: ping\ndata: {\"type\":\"ping\"}\n\nevent: x\ndata: {\"ty");
  assert.deepEqual(events, [{ type: "ping" }]);
  assert.equal(rest, "event: x\ndata: {\"ty");
});

test("plain: strips Markdown marks Telegram would show", () => {
  assert.equal(plain("## Plan\n**Do** `this`\n\n\n\nthen that"), "Plan\nDo this\n\nthen that");
});

test("pieces: splits long replies under Telegram's limit at a line break", () => {
  const text = `${"a".repeat(30)}\n${"b".repeat(30)}`;
  assert.deepEqual(pieces(text, 40), ["a".repeat(30), "b".repeat(30)]);
  assert.deepEqual(pieces("short"), ["short"]);
});

test("draftId: non-zero and stable", () => {
  assert.equal(draftId(0), 1);
  assert.equal(draftId(55), draftId(55));
});

test("addedResult and sentResult: what the model is told", () => {
  assert.equal(addedResult(null).is_error, true);
  assert.equal(addedResult([{ title: "Email Priya", day: null, due: "2026-11-27" }]).content, "Added: Email Priya (Inbox), due 2026-11-27");
  assert.equal(sentResult(null).is_error, true);
  assert.match(sentResult({ fired: true }).content, /few minutes/);
  assert.equal(sentResult({ fired: false, why: "not connected" }).is_error, true);
});

test("finalText: the words, or what went through when it failed or said nothing", () => {
  assert.equal(finalText({ said: "Hi", done: [], failed: false }), "Hi");
  assert.equal(finalText({ said: "", done: [], failed: true }), FAILED);
  assert.equal(finalText({ said: "", done: ["Added: X (Inbox)"], failed: true }), "Added: X (Inbox)\n\nStopped early, so that's all I got to.");
  assert.equal(finalText({ said: "", done: ["Added: X (Inbox)"], failed: false }), "Added: X (Inbox)");
  assert.match(finalText({ said: "", done: [], failed: false }), /No answer/);
});

// --- The telegram function (source checks, as elsewhere) ---------------------------------------

const fn = readFileSync(new URL("../supabase/functions/telegram/index.ts", import.meta.url), "utf8");

test("telegram: a text goes to the chat when the API key is set, else to capture as before", () => {
  assert.match(fn, /if \(t\) return CHAT_KEY \? chat\(t, now\) : capture\(t, now\);/);
});

test("telegram: the chat reads the planner through the shared snapshot, never Hevy or Oura tables itself", () => {
  const chat = fn.slice(fn.indexOf("// --- Chat with the bot"));
  assert.match(chat, /plannerSnapshot\(/);
  assert.doesNotMatch(chat, /hevy_|sleep_|oura_/);
});
