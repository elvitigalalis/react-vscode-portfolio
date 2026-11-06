// Saving a message to Claude and firing the morning task for it (docs/sheet-messages.md), shared
// by the message function (/plan's box) and the telegram function (a text to the bot), so both
// go through the same pipeline. The caller has checked who sent it and cleaned the text
// (messageText). `extra` is any column the caller adds to the row (the telegram function's
// tg_message_id). No fire when another pending message was fired under 3 minutes ago
// (shouldFire): that run reads this one too, and the message gets that run's link
// (batchedPatch). A message that isn't fired stays pending, and the next send, replan or morning
// run picks it up. The message text never goes in the fire.
//
// Secrets: SHEET_ROUTINE_ID and SHEET_ROUTINE_TOKEN. The token is never logged or returned.
import { failedFirePatch, fireRoutine } from "../../../src/sheet/routine-fire.mjs";
import { batchedPatch, shouldFire, startedPatch } from "../../../src/sheet/messages.mjs";
import { db, env } from "./server.ts";

const ROUTINE_ID = env("SHEET_ROUTINE_ID");
const ROUTINE_TOKEN = env("SHEET_ROUTINE_TOKEN");

export type Saved = { id: string; at: string; status: "pending"; fired: boolean; why?: string; retry_at?: string };

export async function saveAndFire(text: string, now: Date, extra: Record<string, unknown> = {}): Promise<Saved> {
  const pending = await db("messages?select=id,fired_at,session_url&status=eq.pending");
  const [row] = await db("messages?select=id,at", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ text, ...extra }) });
  const saved = { id: row.id, at: row.at, status: "pending" as const };
  if (!shouldFire(pending, now)) {
    // It rides on that run, so it shows that run's link.
    const link = batchedPatch(pending, now);
    if (link) await db(`messages?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(link) });
    return { ...saved, fired: false, why: "batched" };
  }
  if (!ROUTINE_ID || !ROUTINE_TOKEN) return { ...saved, fired: false, why: "not connected" };

  const out = await fireRoutine(fetch, { routineId: ROUTINE_ID, token: ROUTINE_TOKEN, trigger: "message", counts: {} }, now);
  if (!out.ok) {
    // The row says why and when to try again, so the telegram tick can re-fire it rather than
    // it waiting for some other fire. The columns come with the messages retry change; until
    // they exist the mark is skipped and the message stays pending as before.
    await db(`messages?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(failedFirePatch(out, now)) })
      .catch(() => {});
    return { ...saved, fired: false, why: out.status === 429 ? "rate_limited" : "failed", ...(out.retry_at ? { retry_at: out.retry_at } : {}) };
  }
  await db(`messages?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(startedPatch(out, now)) });
  return { ...saved, fired: true };
}
