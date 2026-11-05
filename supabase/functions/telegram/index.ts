// The telegram Edge Function (docs/sheet-nudges.md), the one that talks to Telegram. pg_cron calls
// it every minute (supabase/schema.sql, "sheet-telegram") to send what's due, and it is the bot's
// webhook for Done and Snooze taps, the Finished? answers (docs/sheet-v5.md), and for Approve all and Skip on the morning plan
// (docs/sheet-morning.md). Which messages are due, their wording, what counts as a tap
// and what it changes are decided in src/sheet/nudges.mjs, the module /plan's tests cover; this file only reads the
// day, talks to the Telegram Bot API and writes what the module says.
//
// Deploy from the repo root with server-side bundling, which follows the import out of
// supabase/functions (tools/sheet-setup.sh does this):
//   npx supabase functions deploy telegram --use-api --no-verify-jwt
// --no-verify-jwt because neither caller has a Supabase sign-in: the cron job proves itself with
// the shared secret below, and Telegram's webhook with its own secret token header (the
// secret_token tools/sheet-setup.sh passes to setWebhook).
//
// Secrets (function secrets, set by Lisul, never in the repo): TELEGRAM_BOT_TOKEN,
// SHEET_CRON_SECRET and TELEGRAM_WEBHOOK_SECRET, and for replans (v5 R1) SHEET_ROUTINE_ID and
// SHEET_ROUTINE_TOKEN, the same pair routine-fire holds. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase and read in ../_shared/server.ts, with the secret check and db().
import { whatToSend, handleTap, readTap, needsTappedBlock, planTap } from "../../../src/sheet/nudges.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
import { fireOutcome, rateLimited, replanState, shouldReplan } from "../../../src/sheet/replan.mjs";
import { fireRoutine } from "../../../src/sheet/routine-fire.mjs";
import { tapFeedback } from "../../../src/sheet/triage.mjs";
import { db, env, secretMatches } from "../_shared/server.ts";

const BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const CRON_SECRET = env("SHEET_CRON_SECRET");
const WEBHOOK_SECRET = env("TELEGRAM_WEBHOOK_SECRET");
// v5 R1: the morning task's API trigger (docs/sheet-morning.md, "Setup"; routine-fire.mjs).
// Without both, no replan fires.
const ROUTINE_ID = env("SHEET_ROUTINE_ID");
const ROUTINE_TOKEN = env("SHEET_ROUTINE_TOKEN");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (CRON_SECRET && secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    const now = new Date();
    // A replan that fails to start must not stop the messages, and the other way round.
    const replan = await replanTick(now).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ ...(await send(now)), replan });
  }
  if (WEBHOOK_SECRET && secretMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", WEBHOOK_SECRET)) {
    await tap(await req.json(), new Date());
    return new Response("ok");
  }
  return new Response("forbidden", { status: 403 });
});

// The snapshot whatToSend takes: settings, today's day row, today's tasks and every undone task
// with a due date (which covers the check-in's "due tomorrow"), the blocks of those tasks and of
// today, and today's log. Then the morning plan's part: today's proposal, the needs_you rows not
// done, and the campus events the proposal picks.
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
  // v5 R1: the newest revision and the one before it, for the replan message.
  const [proposal = null, previous = null] = await db(`proposals?select=*&day=eq.${today}&order=rev.desc&limit=2`);
  const needsOpen = await db("needs_you?select=*&done=is.false");
  // v5 W1: the cached forecast, for the brief's weather line.
  const [weather = null] = await db("weather_cache?select=periods,alerts");
  // v5 P1: the busy times around today, which More time must not run into.
  const busy = await db(`busy?select=starts_at,ends_at&starts_at=lt.${to}&ends_at=gt.${from}`);
  const replanSent = log.filter((n: { kind: string }) => n.kind === "replan").length;
  // The changes a replan revision consumed (reason and ref only), for the replan message's words.
  const replanChanges = proposal?.run_trigger === "replan"
    ? await db(`changes?select=reason,ref&consumed_day=eq.${today}&consumed_rev=eq.${proposal.rev}&order=at`)
    : [];
  // v5 SRC3: today's academic calendar entries, for the brief's calendar line.
  const [academicDay = null] = await db(`academic_days?select=entries&day=eq.${today}`);
  // v5 M1: the threads he's awaiting a reply on, oldest first, for the brief's Awaiting reply line.
  const awaiting = await db("reply_state?select=who,since&state=eq.awaiting&order=since");
  // Oura: his sleep periods, for quiet until he's up and the brief's time, and today's readiness
  // and sleep, for the brief's cap line. None until the Oura schema has run.
  const sleep = await db("sleep_nights?select=oura_id,day,type,bedtime_start,bedtime_end&order=bedtime_end").catch(() => []);
  const [sleepDay = null] = await db(`sleep_days?select=day,readiness,sleep_s&day=eq.${today}`).catch(() => []);
  // Wind-down: Oura's bedtime windows, and the night's Wind down and Bedtime rows since yesterday
  // (after midnight, tonight's log day is yesterday's).
  const sleepTimes = await db("sleep_times?select=day,start_offset,end_offset&order=day").catch(() => []);
  const nightLog = await db(`nudges?select=kind,day,send_at,sent_at&kind=in.(wind_down,bedtime)&day=gte.${addDays(today, -1)}`).catch(() => []);
  return { settings, day, tasks, blocks, log, proposal, previous, replanSent, replanChanges, needsOpen, campus: await picked(proposal), weather, busy, academic: academicDay?.entries ?? [], awaiting, sleep, sleepDay, sleepTimes, nightLog };
}

// The campus events a proposal picks. A uid is the feed's own text, so each one is quoted for
// PostgREST's in.() list and URL-encoded (docs.postgrest.org/en/stable/references/api/
// url_grammar.html#reserved-characters).
async function picked(proposal: { picks?: { uid: string }[] } | null) {
  const uids = (proposal?.picks ?? []).map((p) => `"${String(p.uid).replace(/["\\]/g, "\\$&")}"`);
  return uids.length ? db(`campus_events?select=*&uid=in.(${encodeURIComponent(uids.join(","))})`) : [];
}

// --- Replans (v5 R1, docs/sheet-v5.md "The replan tick") ------------------------------------
// shouldReplan decides from the changes no replan or revision has taken yet. On fire,
// claim_replan inserts the replans row (result null) and ties the changes to it in one
// transaction, and returns nothing when another tick claimed one already. Only then is the
// routine fired, once: a fire is never retried without a new row (routine-fire.mjs). The run
// reads the replan back through read_planner, and its revision marks the changes consumed. A
// fire that fails, is rate limited or throws records why and unties its changes, so the next tick
// weighs them again (fireOutcome). A run that fails or never submits leaves the plan as it was.
async function replanTick(now: Date) {
  if (!ROUTINE_ID || !ROUTINE_TOKEN) return { hold: "not connected" };
  const [settings] = await db("settings?select=*");
  const { day: today } = localNow(now, settings.time_zone);
  const [[day = null], proposals, replans, changes] = await Promise.all([
    db(`days?select=*&day=eq.${today}`),
    db(`proposals?select=rev,status,run_trigger,created_at,read_at&day=eq.${today}`),
    db(`replans?select=at,result,retry_after&day=eq.${today}`),
    db("changes?select=id,at,kind,reason,weight&replan_id=is.null&consumed_rev=is.null"),
  ]);
  if (rateLimited(replans, now)) return { hold: "rate_limited" };
  const r = shouldReplan(changes, replanState({ settings, day, proposals, replans }), now) as
    { fire: boolean; hold?: string; reasons: string[]; counts: Record<string, number>; ids: string[] };
  if (!r.fire) return { hold: r.hold };
  const id = await db("rpc/claim_replan", {
    method: "POST",
    body: JSON.stringify({ d: today, reasons: r.reasons, counts: r.counts, ids: r.ids }),
  });
  if (!id) return { hold: "claimed" };
  let outcome;
  try {
    outcome = fireOutcome(await fireRoutine(fetch, { routineId: ROUTINE_ID, token: ROUTINE_TOKEN, trigger: "replan", counts: r.counts }, now));
  } catch (e) {
    outcome = fireOutcome(null, e);
  }
  await db(`replans?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(outcome.patch) });
  if (outcome.untie) await db(`changes?replan_id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ replan_id: null }) });
  return { fired: outcome.patch.result };
}

// --- Sending ------------------------------------------------------------------------------

type Message = { kind: string; block_id: string | null; day: string; send_at: string; text: string; buttons: { text: string; url?: string; callback_data?: string }[] };

async function send(now: Date) {
  const snap = await snapshot(now);
  const sent = [];
  for (const m of whatToSend(snap, now) as Message[]) {
    // Claim the log row first: if another run got there, the claim returns nothing and this
    // one skips the message, so it goes out once.
    const c = await claim(m);
    if (!c) continue;
    try {
      // The buttons sit in one row: Done and Snooze 10 min under a nudge, Approve all, Open /plan
      // and Skip under a plan, the four answers under Finished?, Open /plan otherwise.
      await telegram("sendMessage", {
        chat_id: snap.settings.telegram_chat_id,
        text: m.text,
        ...PLAIN,
        reply_markup: m.buttons.length ? { inline_keyboard: [m.buttons] } : undefined,
      });
    } catch (e) {
      // Give the claim back so the next minute tries again.
      await c.giveBack();
      throw e;
    }
    await c.sent();
    sent.push(m.kind);
  }
  return { sent };
}

const setSentAt = (id: string, sent_at: string | null) => db(`nudges?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ sent_at }) });

// A snooze's row was logged by its tap, unsent; claiming it fills in sent_at, which only one run
// can do. Any other message is claimed by inserting its log row, which the unique key turns away
// the second time, and gets sent_at once Telegram has it.
async function claim(m: Message) {
  if (m.kind === "snooze") {
    const key = `block_id=eq.${m.block_id}&kind=eq.snooze&day=eq.${m.day}&send_at=eq.${encodeURIComponent(m.send_at)}&sent_at=is.null`;
    const [row] = await db(`nudges?${key}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ sent_at: new Date().toISOString() }),
    });
    return row && { giveBack: () => setSentAt(row.id, null), sent: async () => {} };
  }
  const [row] = await db("nudges?on_conflict=block_id,kind,day,send_at", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ block_id: m.block_id, kind: m.kind, day: m.day, send_at: m.send_at }),
  });
  return row && { giveBack: () => db(`nudges?id=eq.${row.id}`, { method: "DELETE" }), sent: () => setSentAt(row.id, new Date().toISOString()) };
}

// Every message is plain text: no parse_mode, so nothing in a title or a mail line is read as
// markup, and link previews off, so no URL in one is fetched or shown as a card. sendMessage and
// editMessageText both take link_preview_options, a LinkPreviewOptions with is_disabled: true
// (core.telegram.org/bots/api#linkpreviewoptions, #sendmessage, #editmessagetext; Bot API 10.3).
const PLAIN = { link_preview_options: { is_disabled: true } };

// --- Taps ---------------------------------------------------------------------------------

type Change = { table?: string; id?: string; insert?: unknown; update?: unknown; delete?: boolean; rpc?: string; args?: unknown };

// A second tap on the same button meets the row the first one wrote: a snooze stays as logged,
// and a pending Google edit takes the latest end.
const UPSERT: Record<string, string> = {
  nudges: "on_conflict=block_id,kind,day,send_at",
  gcal_pending: "on_conflict=gcal_id",
};
const RESOLVE: Record<string, string> = { nudges: "ignore-duplicates", gcal_pending: "merge-duplicates" };

// A proposals row is keyed by its day.
const KEY: Record<string, string> = { proposals: "day" };

// Done or Snooze on a nudge, Approve all or Skip on a plan; readTap decides what counts as one.
// The message's buttons go when its text is edited.
async function tap(update: unknown, now: Date) {
  const snap = await snapshot(now);
  const t = readTap(update, snap.settings);
  if (!t) return;
  // A plan tap acts on its own day's proposal and proposed blocks, which may not be today's
  // (readTap lets only a plain date through).
  if (planTap(t) && t.day !== snap.proposal?.day) {
    [snap.proposal = null] = await db(`proposals?select=*&day=eq.${t.day}&order=rev.desc&limit=1`);
    const from = new Date(Date.parse(`${t.day}T00:00:00Z`) - 86_400_000).toISOString();
    const to = new Date(Date.parse(`${t.day}T00:00:00Z`) + 2 * 86_400_000).toISOString();
    snap.blocks.push(...(await db(`blocks?select=*&proposed=is.true&starts_at=gte.${from}&starts_at=lt.${to}`))
      .filter((b: { id: string }) => !snap.blocks.some((x: { id: string }) => x.id === b.id)));
  }
  if (needsTappedBlock(snap, t)) {
    const [b] = await db(`blocks?select=*&id=eq.${t.block_id}`);
    if (b) {
      snap.blocks.push(...(await db(`blocks?select=*&task_id=eq.${b.task_id}`)));
      snap.tasks.push(...(await db(`tasks?select=*&id=eq.${b.task_id}`)));
    }
  }
  let { changes, text } = handleTap(t, snap, now) as { changes: Change[]; text: string };
  // v5 L1: the decision, logged once its changes are made (and not when a newer plan refused it).
  let logged = tapFeedback(t, snap);
  for (const c of changes) {
    // A PostgREST rpc call: POST /rpc/<name> with the named arguments as the body
    // (docs.postgrest.org/en/stable/references/api/functions.html).
    if (c.rpc) {
      try {
        await db(`rpc/${c.rpc}`, { method: "POST", body: JSON.stringify(c.args) });
      } catch (e) {
        // v5: approve_proposal and skip_proposal refuse a revision that moved on since the
        // snapshot was read, and then nothing changed. Any other rpc failing is an error.
        if (c.rpc !== "approve_proposal" && c.rpc !== "skip_proposal") throw e;
        text = "A newer plan is out";
        logged = null;
        break;
      }
    } else if (c.insert && !UPSERT[c.table!]) {
      // A plain insert (v5: actuals, from Finished).
      await db(`${c.table}`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(c.insert) });
    } else if (c.insert) {
      await db(`${c.table}?${UPSERT[c.table!]}`, { method: "POST", headers: { Prefer: `resolution=${RESOLVE[c.table]}` }, body: JSON.stringify(c.insert) });
    } else if (c.update) {
      await db(`${c.table}?${KEY[c.table!] ?? "id"}=eq.${c.id}`, { method: "PATCH", body: JSON.stringify(c.update) });
    } else if (c.delete) {
      await db(`${c.table}?id=eq.${c.id}`, { method: "DELETE" });
    }
  }
  if (logged) await db("feedback", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(logged) });
  await telegram("answerCallbackQuery", { callback_query_id: t.query_id });
  // A repeated tap leaves the text as it was, and Telegram refuses an edit that changes nothing.
  await telegram("editMessageText", { chat_id: t.chat_id, message_id: t.message_id, text, ...PLAIN }).catch(() => {});
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
