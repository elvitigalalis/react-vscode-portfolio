// Texting the bot (src/sheet/capture.mjs, docs/sheet-messages.md "From Telegram"): which updates
// count as a message to Claude, what the bot answers straight away, the receipt it sends once
// Claude has answered, and what Undo on it changes. Expected values are worked out by hand.
//
// Wednesday 2026-11-04 in New York, EST (UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readText, ackText, ackReaction, ANSWERED, readMedia, mediaReply, refireDue, receipt, readUndo, undoChanges } from "../src/sheet/capture.mjs";

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

// ---------------------------------------------------------------- ackReaction

test("ackReaction: a text Claude is reading gets 👀, one queued for the next plan gets ✍", () => {
  assert.deepEqual(ackReaction({ fired: true }), [{ type: "emoji", emoji: "👀" }]);
  assert.deepEqual(ackReaction({ fired: false, why: "batched" }), [{ type: "emoji", emoji: "👀" }]);
  assert.deepEqual(ackReaction({ fired: false, why: "not connected" }), [{ type: "emoji", emoji: "✍" }]);
  assert.deepEqual(ackReaction({ fired: false, why: "failed" }), [{ type: "emoji", emoji: "✍" }]);
});

test("ackReaction: a rate-limited fire gets no reaction, so the text ack says why it waits", () => {
  assert.equal(ackReaction({ fired: false, why: "rate_limited" }), null);
});

test("ANSWERED: the receipt turns the reaction to 👌", () => {
  assert.deepEqual(ANSWERED, [{ type: "emoji", emoji: "👌" }]);
});

// ---------------------------------------------------------------- voice notes and photos

test("readMedia: a voice note, audio, photo, video or file from Lisul's chat is one; text, stickers and other chats aren't", () => {
  const msg = (extra) => ({ message: { message_id: 8, chat: { id: 42, type: "private" }, from: { id: 42 }, ...extra } });
  for (const kind of ["voice", "audio", "photo", "video", "video_note", "document"]) {
    assert.deepEqual(readMedia(msg({ [kind]: kind === "photo" ? [{}] : {} }), settings), { chat_id: 42, message_id: 8 }, kind);
  }
  assert.equal(readMedia(msg({ sticker: {} }), settings), null);
  assert.equal(readMedia(text("dentist"), settings), null);
  assert.equal(readMedia({ message: { ...msg({ voice: {} }).message, chat: { id: 99 } } }, settings), null);
  assert.equal(readMedia({ edited_message: msg({ voice: {} }).message }, settings), null);
});

test("mediaReply: says the bot reads only text, at most once an hour", () => {
  const now = new Date("2026-11-04T15:00:00Z");
  const words = "I can only read text for now. Hold the mic on your keyboard to dictate, or type it.";
  assert.equal(mediaReply(null, now), words);
  assert.equal(mediaReply("2026-11-04T14:00:00Z", now), words);
  assert.equal(mediaReply("2026-11-04T14:00:01Z", now), null);
});

// ---------------------------------------------------------------- refireDue

test("refireDue: a message whose fire failed is fired once more after 5 minutes, or after a 429's retry_at", () => {
  const now = new Date("2026-11-04T15:00:00Z");
  const m = (id, extra) => ({ id, at: "2026-11-04T14:50:00Z", fired_at: null, fire_error: "failed", retry_at: null, refired_at: null, ...extra });
  assert.deepEqual(refireDue([m("a"), m("b", { at: "2026-11-04T14:57:00Z" })], [], now), ["a"]);
  assert.deepEqual(refireDue([m("a", { fire_error: "rate_limited", retry_at: "2026-11-04T15:30:00Z" })], [], now), []);
  assert.deepEqual(refireDue([m("a", { fire_error: "rate_limited", retry_at: "2026-11-04T14:59:00Z" })], [], now), ["a"]);
});

test("refireDue: never twice, never a message that fired or didn't fail, and not when a run on its way reads it", () => {
  const now = new Date("2026-11-04T15:00:00Z");
  const m = (id, extra) => ({ id, at: "2026-11-04T14:50:00Z", fired_at: null, fire_error: "failed", retry_at: null, refired_at: null, ...extra });
  assert.deepEqual(refireDue([m("a", { refired_at: "2026-11-04T14:55:00Z" })], [], now), []);
  assert.deepEqual(refireDue([m("a", { fire_error: null })], [], now), []);
  // Another message fired 2 minutes ago: its run reads every pending message.
  assert.deepEqual(refireDue([m("a"), m("b", { fire_error: null, fired_at: "2026-11-04T14:58:00Z" })], [], now), []);
  // A replan started after it: that run reads it too.
  assert.deepEqual(refireDue([m("a")], [{ at: "2026-11-04T14:52:00Z", result: "started" }], now), []);
  assert.deepEqual(refireDue([m("a")], [{ at: "2026-11-04T14:40:00Z", result: "started" }], now), ["a"]);
});

// ---------------------------------------------------------------- receipt

const TZ = "America/New_York";
const M = "0b6f3c1e-0000-4000-8000-000000000001";
const T1 = "7d0e2a4b-1111-4c3d-9e8f-aabbccddeeff";
const E1 = "00000000-0000-4000-8000-000000000abc";
// The ids as the Undo buttons carry them: each UUID's 16 bytes in base64url, 22 characters.
const UNDO_T1 = "mu:C288HgAAQACAAAAAAAAAAQ:fQ4qSxERTD2ej6q7zN3u_w";
const UNDO_E1 = "mu:C288HgAAQACAAAAAAAAAAQ:AAAAAAAAQACAAAAAAAAKvA";
const answered = (extra = {}) => ({
  id: M, status: "done", reply: "Added the lab report and the dentist.", tasks_added: 1,
  tasks: [{ id: T1, title: "Lab report", day: "2026-11-06", list: null, due: "2026-11-06", at_time: null }],
  events: [{ id: E1, title: "Dentist", starts_at: "2026-11-05T20:00:00.000Z", ends_at: "2026-11-05T21:00:00.000Z" }],
  ...extra,
});

test("receipt: what was added, Claude's reply and each item, with an Undo for each, as /plan lists them", () => {
  assert.deepEqual(receipt(answered(), TZ), {
    text: "Added: 1 task, 1 event\nAdded the lab report and the dentist.\nTo-do: Lab report · Fri Nov 6 · due Fri Nov 6\nEvent: Dentist · Thu Nov 5, 3–4 pm",
    buttons: [[{ text: "Undo to-do: Lab report", callback_data: UNDO_T1 }], [{ text: "Undo event: Dentist", callback_data: UNDO_E1 }]],
  });
  // Every Undo fits Telegram's 64 bytes of callback data (core.telegram.org/bots/api#inlinekeyboardbutton).
  assert.ok(UNDO_T1.length <= 64);
});

test("receipt: a message Claude couldn't act on says so with its reply, and has nothing to undo", () => {
  assert.deepEqual(receipt({ id: M, status: "failed", reply: "No date or time in it.", tasks_added: 0, tasks: [], events: [] }, TZ), {
    text: "Couldn't parse it: nothing added\nNo date or time in it.", buttons: [],
  });
});

test("receipt: after an Undo it names what was undone and keeps the rest", () => {
  const m = answered({ tasks: [], tasks_added: 0 });
  assert.deepEqual(receipt(m, TZ, "Undone: Lab report"), {
    text: "Undone: Lab report\nAdded: 1 event\nAdded the lab report and the dentist.\nEvent: Dentist · Thu Nov 5, 3–4 pm",
    buttons: [[{ text: "Undo event: Dentist", callback_data: UNDO_E1 }]],
  });
  assert.equal(receipt({ ...m, events: [] }, TZ, "Undone: Dentist").text, "Undone: Dentist\nAll undone\nAdded the lab report and the dentist.");
});

// ---------------------------------------------------------------- readUndo and undoChanges

const tap = (data, chat = 42) => ({ callback_query: { id: "q1", data, message: { message_id: 9, chat: { id: chat } } } });

test("readUndo: an Undo tap from Lisul's chat names the message and the item", () => {
  assert.deepEqual(readUndo(tap(UNDO_T1), settings), { message: M, item: T1, query_id: "q1", chat_id: 42, message_id: 9 });
  assert.deepEqual(readUndo(tap(UNDO_E1), settings).item, E1);
});

test("readUndo: another chat, another button or a malformed id is not one", () => {
  assert.equal(readUndo(tap(UNDO_T1, 99), settings), null);
  assert.equal(readUndo(tap("done:7d0e2a4b-1111-4c3d-9e8f-aabbccddeeff"), settings), null);
  assert.equal(readUndo(tap("mu:short:fQ4qSxERTD2ej6q7zN3u_w"), settings), null);
  assert.equal(readUndo(text("mu:x"), settings), null);
});

test("undoChanges: a to-do comes off as /plan's Undo takes it: its blocks' Google events, then the item", () => {
  const blocks = [
    { id: "b1", task_id: T1, gcal_id: "g1" },
    { id: "b2", task_id: T1, gcal_id: null },
    { id: "b3", task_id: "other", gcal_id: "g3" },
  ];
  assert.deepEqual(undoChanges(answered(), T1, blocks), {
    title: "Lab report",
    changes: [
      { table: "gcal_pending", insert: { gcal_id: "g1", ends_at: null } },
      { rpc: "undo_message_item", args: { m: M, item: T1 } },
    ],
  });
});

test("undoChanges: an event's Google event goes when /plan made one, then the item; one already undone changes nothing", () => {
  assert.deepEqual(undoChanges(answered(), E1, []), { title: "Dentist", changes: [{ rpc: "undo_message_item", args: { m: M, item: E1 } }] });
  const made = answered({ events: [{ ...answered().events[0], gcal_id: "gE" }] });
  assert.deepEqual(undoChanges(made, E1, []).changes, [
    { table: "gcal_pending", insert: { gcal_id: "gE", ends_at: null } },
    { rpc: "undo_message_item", args: { m: M, item: E1 } },
  ]);
  assert.equal(undoChanges(answered({ events: [] }), E1, []), null);
  assert.equal(undoChanges(null, E1, []), null);
});
