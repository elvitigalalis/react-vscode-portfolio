// Settings, Hevy (docs/sheet-hevy.md): the pure parts of the Hevy block. What the status line
// and the error line say from the hevy_account row, and whether a pasted key looks like one.
import { formatClock, localNow } from "./logic.mjs";

// Hevy's API keys are UUIDs (hevy_key_save checks the same). Returns the trimmed key, or null.
export function hevyKey(text) {
  const k = String(text ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k) ? k : null;
}

// "Synced 9:24 am" today, "Synced Nov 6, 9:24 am" before that.
export function hevyStatus(account, now, timeZone) {
  if (!account) return "Not connected";
  if (!account.synced_at) return "Connected. The first sync runs within 15 minutes.";
  const at = localNow(new Date(account.synced_at), timeZone);
  const clock = formatClock(at.minutes);
  if (at.day === localNow(now, timeZone).day) return `Synced ${clock}`;
  const date = new Date(account.synced_at).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
  return `Synced ${date}, ${clock}`;
}

// hevy-sync's last_error words, and what to do about each.
const FIX = { "not pro": "The API needs Hevy Pro." };
export function hevyError(account) {
  const e = account?.last_error;
  return e ? `Last error: ${e}. ${FIX[e] ?? "Paste a new key."}` : "";
}
