// Texting the bot (docs/sheet-messages.md, "From Telegram"): a plain text Lisul sends the bot
// becomes a message to Claude, exactly as if he had typed it into /plan's box, and once Claude
// has answered, the bot sends the receipt with an Undo for each item. This is the pure side: which
// updates count, the words, and what an Undo changes. Kept free of the network so node --test
// covers it; the telegram Edge Function imports it, and messages.mjs keeps the pipeline's rules.
import { addedLine, itemLines, messageState, messageText } from "./messages.mjs";

// A Telegram update (core.telegram.org/bots/api#update: `message` is "New incoming message of any
// kind"; #message: `text`, `chat`, `message_id`), read as a message to Claude:
//   { text, chat_id, message_id }   text cleaned by messageText, as the box cleans it
// or null for anything else, which the webhook leaves to the taps: a chat that isn't Lisul's
// (settings.telegram_chat_id, the chat the nudges go to), an edit, a message with no text (a
// photo, a sticker), a command ("/start"), or text that cleans to nothing.
export function readText(update, settings) {
  const m = update?.message;
  if (!m || settings?.telegram_chat_id == null || String(m.chat?.id) !== String(settings.telegram_chat_id)) return null;
  if (typeof m.text !== "string" || m.text.trimStart().startsWith("/")) return null;
  const text = messageText(m.text);
  return text ? { text, chat_id: m.chat.id, message_id: m.message_id } : null;
}

// What the bot answers straight away, from the save's outcome ({ fired, why }, as the message
// function answers /plan): the box's own words for Sending done (message-box.mjs).
export function ackText(saved) {
  const where = saved.fired || saved.why === "batched" ? "Claude is reading…"
    : saved.why === "rate_limited" ? "Queued: Claude is busy, so this runs with the next plan."
    : "Queued: this runs with the next plan.";
  return `Sent to Claude. ${where}`;
}

// research/plan-phone.md P4: the bot reacts to his text instead of sending an ack message, so a
// capture costs one bot message (the receipt), not two. setMessageReaction takes "A
// JSON-serialized list of reaction types"; "as non-premium users, bots can set up to one
// reaction per message", and a ReactionTypeEmoji is { type: "emoji", emoji } with the emoji from
// a fixed list, which holds 👀, ✍ and 👌 (core.telegram.org/bots/api#setmessagereaction,
// #reactiontypeemoji; Bot API 10.3). Setting a new list replaces the old reaction.
// 👀 Claude is reading it (fired, or riding on a run fired a moment ago); ✍ it is queued for the
// next plan. null for a rate-limited fire: those words matter, so ackText still goes as a reply.
const emoji = (e) => [{ type: "emoji", emoji: e }];
export function ackReaction(saved) {
  if (saved.fired || saved.why === "batched") return emoji("👀");
  return saved.why === "rate_limited" ? null : emoji("✍");
}
// What the reaction becomes once Claude has answered and the receipt went out.
export const ANSWERED = emoji("👌");

// --- The receipt -------------------------------------------------------------------------------

// A UUID in Undo's callback data as its 16 bytes in base64url (22 characters), and back, so a
// message's id and an item's both fit Telegram's 1-64 bytes of callback_data
// (core.telegram.org/bots/api#inlinekeyboardbutton): "mu:" and two of them is 48.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (uuid) => btoa(String.fromCharCode(...uuid.replace(/-/g, "").match(/../g).map((h) => parseInt(h, 16))))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function long(s) {
  if (!/^[\w-]{22}$/.test(s)) return null;
  const hex = [...atob(s.replace(/-/g, "+").replace(/_/g, "/"))].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID.test(id) ? id : null;
}
const undoData = (m, item) => `mu:${short(m)}:${short(item)}`;

const KIND = { task: "To-do", event: "Event" };

// The message the bot sends once Claude has answered message m (a messages row), in /plan's
// words: where it stands (addedLine, or Couldn't parse), Claude's reply, then each to-do and
// event it added (itemLines), one a line. `note` ("Undone: Lab report") goes first after an
// Undo. Returns { text, buttons }: buttons are the inline keyboard's rows, one Undo a row, for
// each item with an id. Titles and the reply passed answer_messages' checks (one line, no link).
/** @param {string | null} [note] */
export function receipt(m, timeZone, note = null) {
  const lines = m.status === "done" ? itemLines(m, timeZone) : [];
  const text = [
    note,
    m.status === "done" ? addedLine(m) : messageState(m, [], new Date()).words,
    m.reply,
    ...lines.map((l) => `${KIND[l.kind]}: ${l.title} · ${l.when}`),
  ].filter(Boolean).join("\n");
  const buttons = lines.filter((l) => l.id).map((l) => [{ text: `Undo ${KIND[l.kind].toLowerCase()}: ${l.title}`, callback_data: undoData(m.id, l.id) }]);
  return { text, buttons };
}

// An Undo tap on a receipt: { message, item, query_id, chat_id, message_id }, or null for any
// other update, chat or button (readTap reads those).
export function readUndo(update, settings) {
  const q = update?.callback_query;
  if (!q?.message || settings?.telegram_chat_id == null || String(q.message.chat?.id) !== String(settings.telegram_chat_id)) return null;
  const [, a, b] = /^mu:([\w-]+):([\w-]+)$/.exec(q.data ?? "") ?? [];
  const message = a && long(a), item = b && long(b);
  return message && item ? { message, item, query_id: q.id, chat_id: q.message.chat.id, message_id: q.message.message_id } : null;
}

// What Undo on item `item` of message m changes, as /plan's Undo does (message-box.mjs's
// undoItem): a to-do's blocks lose their Google events, then undo_message_item deletes the task
// (its blocks go with it); an event loses its Google event when /plan made one, then comes off
// the message and out of busy. Telegram can't reach Google, so each Google event to delete is a
// gcal_pending row ({ gcal_id, ends_at: null }), which /plan applies when it opens, as for a Done
// tap. `blocks` are the task's blocks. Returns { title, changes } in handleTap's shape, or null
// when the item is gone (undone already).
export function undoChanges(m, item, blocks) {
  const task = (m?.tasks ?? []).find((t) => t.id === item);
  const event = !task && (m?.events ?? []).find((e) => e.id === item);
  if (!task && !event) return null;
  const gone = task ? blocks.filter((b) => b.task_id === item && b.gcal_id).map((b) => b.gcal_id) : event.gcal_id ? [event.gcal_id] : [];
  return {
    title: (task ?? event).title,
    changes: [
      ...gone.map((gcal_id) => ({ table: "gcal_pending", insert: { gcal_id, ends_at: null } })),
      { rpc: "undo_message_item", args: { m: m.id, item } },
    ],
  };
}
