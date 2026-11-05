// Texting the bot (docs/sheet-messages.md, "From Telegram"): a plain text Lisul sends the bot
// becomes a message to Claude, exactly as if he had typed it into /plan's box, and once Claude
// has answered, the bot sends the receipt with an Undo for each item. This is the pure side: which
// updates count, the words, and what an Undo changes. Kept free of the network so node --test
// covers it; the telegram Edge Function imports it, and messages.mjs keeps the pipeline's rules.
import { messageText } from "./messages.mjs";

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
