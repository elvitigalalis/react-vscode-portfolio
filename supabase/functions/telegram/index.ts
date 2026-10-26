// The telegram Edge Function (docs/sheet-nudges.md): The Sheet's only server code. pg_cron calls
// it every minute (supabase/schema.sql, "sheet-telegram") to send what's due. Which messages are
// due, and their wording, is decided in src/sheet/nudges.mjs, the module /plan's tests cover; this
// file only reads the day, sends through the Telegram Bot API and keeps the log.
//
// Deploy from the repo root with server-side bundling, which follows the import out of
// supabase/functions (tools/sheet-setup.sh does this):
//   npx supabase functions deploy telegram --use-api --no-verify-jwt
// --no-verify-jwt because neither caller has a Supabase sign-in: the cron job proves itself with
// the shared secret below, and Telegram's webhook will with its own secret token header.
//
// Secrets (function secrets, set by Lisul, never in the repo): TELEGRAM_BOT_TOKEN and
// SHEET_CRON_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { whatToSend } from "../../../src/sheet/nudges.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";

const env = (name: string) => Deno.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const CRON_SECRET = env("SHEET_CRON_SECRET");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (CRON_SECRET && same(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return Response.json(await send(new Date()));
  }
  // The bot's webhook (Done and Snooze taps) goes here, behind Telegram's
  // X-Telegram-Bot-Api-Secret-Token header.
  return new Response("forbidden", { status: 403 });
});

// Compares two secrets without stopping at the first difference.
function same(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// --- The database, through PostgREST with the service key (it bypasses row-level security) ---

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// The snapshot whatToSend takes: settings, today's day row, today's tasks and every undone task
// with a due date, the blocks of those tasks and of today, and today's log.
async function snapshot(now: Date) {
  const [settings] = await db("settings?select=*");
  const { day: today } = localNow(now, settings.time_zone);
  const tasks = await db(`tasks?select=*&or=(day.eq.${today},and(due.not.is.null,done.is.false))`);
  // A day's blocks start within a day of its UTC midnight either way; whatToSend narrows them to
  // the owner's day.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString();
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const ids = tasks.map((t: { id: string }) => t.id).join(",");
  const blocks = await db(`blocks?select=*&or=(and(starts_at.gte.${from},starts_at.lt.${to})${ids ? `,task_id.in.(${ids})` : ""})`);
  const [day = null] = await db(`days?select=*&day=eq.${today}`);
  const log = await db(`nudges?select=*&day=eq.${today}`);
  return { settings, day, tasks, blocks, log };
}

// --- Sending ------------------------------------------------------------------------------

type Message = { kind: string; block_id: string | null; day: string; send_at: string; text: string; buttons: { text: string; url?: string; callback_data?: string }[] };

async function send(now: Date) {
  const snap = await snapshot(now);
  const sent = [];
  for (const m of whatToSend(snap, now) as Message[]) {
    // Claim the log row first: if another run got there, the claim returns nothing and this
    // one skips the message, so it goes out once.
    const claim = m.kind === "snooze" ? await claimSnooze(m) : await claimNew(m);
    if (!claim) continue;
    try {
      // The buttons sit in one row: Done and Snooze 10 min under a nudge, Open /plan otherwise.
      await telegram("sendMessage", {
        chat_id: snap.settings.telegram_chat_id,
        text: m.text,
        reply_markup: m.buttons.length ? { inline_keyboard: [m.buttons] } : undefined,
      });
    } catch (e) {
      // Give the claim back so the next minute tries again.
      await (m.kind === "snooze"
        ? db(`nudges?id=eq.${claim.id}`, { method: "PATCH", body: JSON.stringify({ sent_at: null }) })
        : db(`nudges?id=eq.${claim.id}`, { method: "DELETE" }));
      throw e;
    }
    if (m.kind !== "snooze") await db(`nudges?id=eq.${claim.id}`, { method: "PATCH", body: JSON.stringify({ sent_at: new Date().toISOString() }) });
    sent.push(m.kind);
  }
  return { sent };
}

// Most messages are claimed by inserting their log row; the unique key turns a second insert away.
async function claimNew(m: Message) {
  const [claim] = await db("nudges?on_conflict=block_id,kind,day,send_at", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ block_id: m.block_id, kind: m.kind, day: m.day, send_at: m.send_at }),
  });
  return claim;
}

// A snooze's row was logged by its tap, unsent; claiming it fills in sent_at, which only one run
// can do.
async function claimSnooze(m: Message) {
  const key = `block_id=eq.${m.block_id}&kind=eq.snooze&day=eq.${m.day}&send_at=eq.${encodeURIComponent(m.send_at)}&sent_at=is.null`;
  const [claim] = await db(`nudges?${key}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ sent_at: new Date().toISOString() }),
  });
  return claim;
}

async function telegram(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(`telegram ${method}: ${out.error_code} ${out.description}`);
  return out.result;
}
