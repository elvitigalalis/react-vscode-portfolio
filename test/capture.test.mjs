// Texting the bot (src/sheet/capture.mjs, docs/sheet-messages.md "From Telegram"): which updates
// count as a message to Claude, what the bot answers straight away, the receipt it sends once
// Claude has answered, and what Undo on it changes. Expected values are worked out by hand.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readText, ackText } from "../src/sheet/capture.mjs";

const settings = { time_zone: "America/New_York", telegram_chat_id: 42 };
// A text from Lisul's own chat, as Telegram's webhook sends it (core.telegram.org/bots/api#update).
const text = (t, extra = {}) => ({ update_id: 1, message: { message_id: 7, date: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: t, ...extra } });

// ---------------------------------------------------------------- readText

test("readText: a text from Lisul's chat is a message to Claude, cleaned as the box cleans it", () => {
  assert.deepEqual(readText(text("dentist  Thu 3pm "), settings), { text: "dentist Thu 3pm", chat_id: 42, message_id: 7 });
  // Line breaks stay, as in the box.
  assert.equal(readText(text("Project 2 due Nov 14\n\n\n\nquiz Tue"), settings).text, "Project 2 due Nov 14\n\nquiz Tue");
});

test("readText: any other chat, a command, a non-text message, an edit or a tap is not one", () => {
  assert.equal(readText({ message: { ...text("dentist").message, chat: { id: 99, type: "private" } } }, settings), null);
  assert.equal(readText(text("/start"), settings), null);
  assert.equal(readText(text("   "), settings), null);
  assert.equal(readText({ message: { message_id: 7, chat: { id: 42 }, photo: [{}] } }, settings), null);
  assert.equal(readText({ edited_message: text("dentist").message }, settings), null);
  assert.equal(readText({ callback_query: { id: "q", data: "done:x", message: text("x").message } }, settings), null);
  assert.equal(readText(text("dentist"), { ...settings, telegram_chat_id: null }), null);
});

// ---------------------------------------------------------------- ackText

test("ackText: the bot says at once where the message stands, in the box's words", () => {
  assert.equal(ackText({ fired: true }), "Sent to Claude. Claude is reading…");
  assert.equal(ackText({ fired: false, why: "batched" }), "Sent to Claude. Claude is reading…");
  assert.equal(ackText({ fired: false, why: "rate_limited" }), "Sent to Claude. Queued: Claude is busy, so this runs with the next plan.");
  assert.equal(ackText({ fired: false, why: "not connected" }), "Sent to Claude. Queued: this runs with the next plan.");
  assert.equal(ackText({ fired: false, why: "failed" }), "Sent to Claude. Queued: this runs with the next plan.");
});
