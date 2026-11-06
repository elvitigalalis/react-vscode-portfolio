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
import { whatToSend, handleTap, readTap, needsTappedBlock, planTap, pinStep, horizonResets, silent } from "../../../src/sheet/nudges.mjs";
import { reflowHorizon } from "../../../src/sheet/horizon-io.mjs";
import { health, nextTold } from "../../../src/sheet/health.mjs";
import { queryPath } from "../../../src/sheet/proposal-io.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
import { fireOutcome, rateLimited, replanState, shouldReplan } from "../../../src/sheet/replan.mjs";
import { fireRoutine } from "../../../src/sheet/routine-fire.mjs";
import { tapFeedback } from "../../../src/sheet/triage.mjs";
import { ackReaction, ackText, ANSWERED, mediaReply, readMedia, readText, readUndo, receipt, undoChanges } from "../../../src/sheet/capture.mjs";
import { db, env, secretMatches } from "../_shared/server.ts";
import { saveAndFire } from "../_shared/capture.ts";

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
    // Nor must a receipt for a text to the bot.
    const receipted = await receipts(now).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    const hook = await ensureWebhook().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    // Horizon planning: re-flow before the messages, so they see fresh states. Failing (or the
    // horizon schema not run yet) stops nothing else.
    const horizon = await horizonTick(now).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    return Response.json({ ...(await send(now, { replanHold: replan, hook })), replan, receipts: receipted, hook, horizon });
  }
  if (WEBHOOK_SECRET && secretMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", WEBHOOK_SECRET)) {
    await webhook(await req.json(), new Date());
    return new Response("ok");
  }
  return new Response("forbidden", { status: 403 });
});

// The snapshot whatToSend takes: settings, today's day row, today's tasks and every undone task
// with a due date (which covers the check-in's "due tomorrow"), the blocks of those tasks and of
// today, and today's log. Then the morning plan's part: today's proposal, the needs_you rows not
// done, and the campus events the proposal picks.
// What the tick learned before sending, for the health check: the replan tick's outcome and the
// webhook's info.
type TickFacts = { replanHold?: unknown; hook?: unknown };

async function snapshot(now: Date, facts: TickFacts = {}) {
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
  const [sleepDay = null] = await db(`sleep_days?select=day,readiness,sleep_s,sleep_score&day=eq.${today}`).catch(() => []);
  // Wind-down: Oura's bedtime windows, and the night's Wind down and Bedtime rows since yesterday
  // (after midnight, tonight's log day is yesterday's).
  const sleepTimes = await db("sleep_times?select=day,start_offset,end_offset&order=day").catch(() => []);
  const nightLog = await db(`nudges?select=kind,day,send_at,sent_at&kind=in.(wind_down,bedtime)&day=gte.${addDays(today, -1)}`).catch(() => []);
  // Tips: two weeks of score contributors and the Gym habit's time; and whether the ring's battery
  // was low at the last sync. The words are composed here (nudges.mjs), never by the routine.
  const tipDays = await db(`sleep_days?select=day,contributors&day=gte.${addDays(today, -14)}&contributors=not.is.null`).catch(() => []);
  const gymHabits = await db("habits?select=id,name,ideal").catch(() => []);
  const [ringLow = null] = await db("oura_account?select=ring_low,ring_checked_at").catch(() => []);
  // Horizon planning: each task's state and the last one he was told of. None until its schema has run.
  const horizon = await db("horizon_state?select=task_id,state,short_min,slack_min,finish_day,notified").catch(() => []);
  const lastWeek = await lastWeekRows(today).catch(() => null);
  // The Sheet's health (health.mjs). A failed read leaves it out: the brief then has no Sheet
  // line, and nothing is alerted, rather than the messages stopping.
  const sheetHealth = await healthOf(today, now, settings.time_zone, facts).catch((e) => (console.error("health:", e instanceof Error ? e.message : e), undefined));
  return { health: sheetHealth, lastWeek, settings, day, tasks, blocks, log, proposal, previous, replanSent, replanChanges, needsOpen, campus: await picked(proposal), weather, busy, academic: academicDay?.entries ?? [], awaiting, sleep, sleepDay, sleepTimes, nightLog, tipDays, gymHabits, habits: gymHabits, ringLow, horizon };
}

// The rows health() reads (docs/sheet-nudges.md, "Health"): every feed, the three connected
// accounts' last errors, and today's replans, with the tick's own facts.
async function healthOf(today: string, now: Date, tz: string, facts: TickFacts) {
  const [feeds, mail, [calendar = null], [oura = null], replans] = await Promise.all([
    db("feed_state?select=*"),
    db("mail_accounts?select=email,label,last_error").catch(() => []),
    db("calendar_account?select=last_error").catch(() => []),
    db("oura_account?select=last_error").catch(() => []),
    db(`replans?select=at,result&day=eq.${today}`),
  ]);
  const hook = facts.hook && typeof facts.hook === "object" && "url" in facts.hook ? facts.hook : undefined;
  const replanHold = facts.replanHold && typeof facts.replanHold === "object" && "hold" in facts.replanHold ? facts.replanHold : undefined;
  return health({ tz, feeds, mail, calendar, oura, replans, hook, replanHold }, now);
}

// Monday's Last week line (nudges.mjs, lastWeekLine): last Mon-Sun's approved task blocks (a day
// either side in UTC; the module narrows them to his days), which of their tasks are done, and
// last week's actuals. Null on other days, so the other six days cost no reads.
async function lastWeekRows(today: string) {
  if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 1) return null;
  const from = addDays(today, -8), to = addDays(today, 1);
  const blocks = await db(`blocks?select=task_id,starts_at,ends_at&proposed=is.false&task_id=not.is.null&starts_at=gte.${from}T00:00:00Z&starts_at=lt.${to}T00:00:00Z`);
  const ids = [...new Set(blocks.map((b: { task_id: string }) => b.task_id))];
  const done = ids.length ? (await db(`tasks?select=id&done=is.true&id=in.(${ids.join(",")})`)).map((t: { id: string }) => t.id) : [];
  const actuals = await db(`actuals?select=kind,est_min,minutes&day=gte.${addDays(today, -7)}&day=lt.${today}`);
  return { blocks, done, actuals };
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
  // Oura's rows only set the shutdown line (bedtime.mjs, shutdownFor); none until its schema ran.
  const [[day = null], proposals, replans, changes, sleep, sleepTimes] = await Promise.all([
    db(`days?select=*&day=eq.${today}`),
    db(`proposals?select=rev,status,run_trigger,created_at,read_at&day=eq.${today}`),
    db(`replans?select=at,result,retry_after&day=eq.${today}`),
    db("changes?select=id,at,kind,reason,weight&replan_id=is.null&consumed_rev=is.null"),
    db("sleep_nights?select=oura_id,day,type,bedtime_start,bedtime_end&order=bedtime_end").catch(() => []),
    db("sleep_times?select=day,start_offset,end_offset&order=day").catch(() => []),
  ]);
  if (rateLimited(replans, now)) return { hold: "rate_limited" };
  const r = shouldReplan(changes, replanState({ settings, day, today, proposals, replans, sleep, sleepTimes }), now) as
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

// --- Horizon planning (docs/sheet-horizon.md, "Part 2") ----------------------------------
// The minute tick's re-flow: skipped while the inputs' key holds (reflowHorizon), so it is cheap
// on most minutes. Then the states told of in Telegram that no longer hold are reset
// (horizonResets); each patch names its row, for pg-safeupdate.
async function horizonTick(now: Date) {
  const r = await reflowHorizon({
    read: (q: Parameters<typeof queryPath>[0]) => db(queryPath(q)),
    rpc: (fn: string, args: unknown) => db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }),
  }, now);
  const states = await db("horizon_state?select=task_id,state,notified&notified=not.is.null");
  for (const x of horizonResets(states)) await setNotified([x.task_id], x.notified);
  return { skipped: r.skipped };
}

const setNotified = (ids: string[], notified: string | null) =>
  db(`horizon_state?task_id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify({ notified }) });

// --- Sending ------------------------------------------------------------------------------

type Message = { kind: string; block_id: string | null; day: string; send_at: string; text: string; entities?: unknown[]; health?: string[]; buttons: { text: string; url?: string; callback_data?: string }[]; horizon?: { task_id: string; state: string }[] };

async function send(now: Date, facts: TickFacts = {}) {
  const snap = await snapshot(now, facts);
  const sent = [];
  // The health keys the brief or a health message told him of (nudges.mjs).
  const toldNow: string[] = [];
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
        // The brief's folded tail (nudges.mjs, folded): entities instead of a parse_mode, so the
        // text is never read as markup (sendMessage's entities, "can be specified instead of
        // parse_mode": core.telegram.org/bots/api#sendmessage).
        ...(m.entities ? { entities: m.entities } : {}),
        // Only what asks him to act now makes a sound (nudges.mjs, silent).
        ...(silent(m) ? { disable_notification: true } : {}),
        reply_markup: m.buttons.length ? { inline_keyboard: [m.buttons] } : undefined,
      });
    } catch (e) {
      // Give the claim back so the next minute tries again.
      await c.giveBack();
      throw e;
    }
    await c.sent();
    sent.push(m.kind);
    toldNow.push(...(m.health ?? []));
    // The horizon states this message told him of (the brief's, or the horizon message's).
    for (const st of ["tight", "wont_fit"]) {
      const ids = (m.horizon ?? []).filter((h) => h.state === st).map((h) => h.task_id);
      if (ids.length) await setNotified(ids, st).catch((e) => console.error("horizon notified:", e instanceof Error ? e.message : e));
    }
  }
  // What's told and still open (health.mjs, nextTold), written only when it changes.
  if (snap.health) {
    const before: string[] = snap.settings.health_told ?? [];
    const after = nextTold(before, snap.health.issues, toldNow);
    if (after.join("\n") !== before.join("\n")) await saveNow({ health_told: after }).catch((e) => console.error("health told:", e instanceof Error ? e.message : e));
  }
  // The pinned Now message must not stop the messages, nor they it.
  const pin = await pinTick(snap, now).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  return { sent, pin };
}

// --- The pinned Now message (docs/sheet-nudges.md, "The pinned Now message") ---------------
// pinStep decides; this sends, pins and edits. Its id and words live in settings (now_message_id,
// now_text). Made with sendMessage's disable_notification ("Sends the message silently") and
// pinned with pinChatMessage's disable_notification ("Notifications are always disabled in ...
// private chats", and a bot may pin any non-service message there: core.telegram.org/bots/api#sendmessage,
// #pinchatmessage). Then only editMessageText, which notifies no one (#editmessagetext). Telegram
// refuses an edit that changes nothing ("message is not modified"), which only records the words;
// a message he deleted ("message to edit not found") is forgotten, and made again once he's up.
const saveNow = (patch: Record<string, unknown>) => db("settings?id=eq.true", { method: "PATCH", body: JSON.stringify(patch) });

async function pinTick(snap: Awaited<ReturnType<typeof snapshot>>, now: Date) {
  // A block's task may be on another day or a Someday list, outside the snapshot's tasks.
  const missing = [...new Set(snap.blocks.map((b: { task_id: string | null }) => b.task_id)
    .filter((id: string | null) => id && !snap.tasks.some((t: { id: string }) => t.id === id)))];
  const tasks = missing.length ? [...snap.tasks, ...(await db(`tasks?select=id,title&id=in.(${missing.join(",")})`))] : snap.tasks;
  const step = pinStep({ ...snap, tasks }, now) as { action: "create" | "edit"; text: string; message_id?: number } | null;
  if (!step) return null;
  const chat_id = snap.settings.telegram_chat_id;
  if (step.action === "edit") {
    try {
      await telegram("editMessageText", { chat_id, message_id: step.message_id, text: step.text, ...PLAIN });
    } catch (e) {
      const why = e instanceof Error ? e.message : "";
      if (/message to edit not found|message can't be edited/i.test(why)) {
        await saveNow({ now_message_id: null, now_text: null });
        return "gone";
      }
      if (!/message is not modified/i.test(why)) throw e;
    }
    await saveNow({ now_text: step.text });
    return "edited";
  }
  const msg = await telegram("sendMessage", { chat_id, text: step.text, ...PLAIN, disable_notification: true });
  // Kept before the pin, so a refused pin never makes a second message.
  await saveNow({ now_message_id: msg.message_id, now_text: step.text });
  await telegram("pinChatMessage", { chat_id, message_id: msg.message_id, disable_notification: true });
  return "created";
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

// --- The webhook ------------------------------------------------------------------------------

// A text from Lisul's chat is a message to Claude (capture.mjs); anything else is a tap, read as
// before. Every other update, and any other chat, is ignored without a word.
async function webhook(update: unknown, now: Date) {
  const [settings] = await db("settings?select=*");
  const t = readText(update, settings);
  if (t) return capture(t, now);
  const u = readUndo(update, settings);
  if (u) return undo(u, settings);
  const media = readMedia(update, settings);
  if (media) return mediaAnswer(media, settings, now);
  return tap(update, now);
}

// A voice note or photo (capture.mjs, readMedia): the bot says once an hour that it reads only
// text. Claimed by moving settings.media_reply_at forward, which only one run can do while the
// last reply is under an hour old; Telegram resends a failed update, and the claim keeps that from
// answering twice.
async function mediaAnswer(media: { chat_id: number; message_id: number }, settings: { media_reply_at?: string | null }, now: Date) {
  const text = mediaReply(settings.media_reply_at ?? null, now);
  if (!text) return;
  const before = new Date(now.getTime() - 60 * 60_000).toISOString();
  const [claimed] = await db(`settings?id=eq.true&or=(media_reply_at.is.null,media_reply_at.lte.${before})`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ media_reply_at: now.toISOString() }),
  });
  if (!claimed) return;
  await telegram("sendMessage", {
    chat_id: media.chat_id,
    text,
    ...PLAIN,
    reply_parameters: { message_id: media.message_id, allow_sending_without_reply: true },
  }).catch((e) => console.error("telegram media:", e.message));
}

// --- Texting the bot (docs/sheet-messages.md, "From Telegram") -----------------------------

// The text goes through the same save and fire as /plan's box (../_shared/capture.ts), with his
// Telegram message's id on the row, and the bot answers at once with where it stands, as a reply
// to his text (sendMessage's reply_parameters, a ReplyParameters with message_id;
// allow_sending_without_reply so a deleted text doesn't stop it: core.telegram.org/bots/api#sendmessage,
// #replyparameters). The receipt follows from the minute tick once Claude has answered (receipts).
// Telegram sends an update again when the webhook fails ("we will repeat the request":
// core.telegram.org/bots/api#setwebhook): a text already saved is not saved again, so a failed
// save is retried and a saved one never doubles. A failed answer is only logged.
// The answer is a reaction on his text (capture.mjs, ackReaction: setMessageReaction), and a
// reply with ackText only when the words matter (rate limited) or Telegram refuses the reaction.
async function capture(t: { text: string; chat_id: number; message_id: number }, now: Date) {
  if ((await db(`messages?select=id&tg_message_id=eq.${t.message_id}`)).length) return;
  const saved = await saveAndFire(t.text, now, { tg_message_id: t.message_id });
  const reaction = ackReaction(saved);
  if (reaction) {
    const reacted = await telegram("setMessageReaction", { chat_id: t.chat_id, message_id: t.message_id, reaction })
      .then(() => true, (e) => (console.error("telegram reaction:", e.message), false));
    if (reacted) return;
  }
  await telegram("sendMessage", {
    chat_id: t.chat_id,
    text: ackText(saved),
    ...PLAIN,
    reply_parameters: { message_id: t.message_id, allow_sending_without_reply: true },
  }).catch((e) => console.error("telegram capture:", e.message));
}

// The receipt for each text Claude has answered since yesterday, once: a reply to his text with
// what was added and an Undo for each item (capture.mjs's receipt), whatever the hour, since he
// asked. Claimed first by filling in tg_receipt_at, which only one run can do, and given back
// if Telegram refuses it, so the next minute tries again.
async function receipts(now: Date) {
  const [settings] = await db("settings?select=time_zone,telegram_chat_id");
  if (!settings?.telegram_chat_id) return [];
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const rows = await db(`messages?select=*&tg_message_id=not.is.null&tg_receipt_at=is.null&status=neq.pending&answered_at=gte.${since}&order=at`);
  const sent = [];
  for (const m of rows) {
    const [claimed] = await db(`messages?id=eq.${m.id}&tg_receipt_at=is.null`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ tg_receipt_at: now.toISOString() }),
    });
    if (!claimed) continue;
    const { text, buttons } = receipt(m, settings.time_zone);
    try {
      await telegram("sendMessage", {
        chat_id: settings.telegram_chat_id,
        text,
        ...PLAIN,
        // He asked and is waiting on it, but it needs no action: silent (disable_notification,
        // core.telegram.org/bots/api#sendmessage).
        disable_notification: true,
        reply_parameters: { message_id: m.tg_message_id, allow_sending_without_reply: true },
        reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
      });
    } catch (e) {
      await db(`messages?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ tg_receipt_at: null }) });
      throw e;
    }
    // 👀 or ✍ on his text becomes 👌 (capture.mjs, ANSWERED). Only cosmetic: a refusal (his text
    // deleted) changes nothing.
    await telegram("setMessageReaction", { chat_id: settings.telegram_chat_id, message_id: m.tg_message_id, reaction: ANSWERED })
      .catch((e) => console.error("telegram reaction:", e.message));
    sent.push(m.id);
  }
  return sent;
}

// Undo on a receipt: the item comes off as /plan's Undo takes it (undoChanges), then the receipt
// is edited to say so, with the Undo buttons left (editMessageText takes reply_markup, an
// InlineKeyboardMarkup: core.telegram.org/bots/api#editmessagetext). An item undone already
// changes nothing.
async function undo(u: { message: string; item: string; query_id: string; chat_id: number; message_id: number }, settings: { time_zone: string }) {
  const [m = null] = await db(`messages?select=*&id=eq.${u.message}`);
  const blocks = await db(`blocks?select=id,task_id,gcal_id&task_id=eq.${u.item}`);
  const r = undoChanges(m, u.item, blocks) as { title: string; changes: Change[] } | null;
  for (const c of r?.changes ?? []) {
    if (c.rpc) await db(`rpc/${c.rpc}`, { method: "POST", body: JSON.stringify(c.args) });
    else await db(`${c.table}?${UPSERT[c.table!]}`, { method: "POST", headers: { Prefer: `resolution=${RESOLVE[c.table!]}` }, body: JSON.stringify(c.insert) });
  }
  await telegram("answerCallbackQuery", { callback_query_id: u.query_id });
  if (!m) return;
  const [fresh = m] = r ? await db(`messages?select=*&id=eq.${u.message}`) : [m];
  const { text, buttons } = receipt(fresh, settings.time_zone, r ? `Undone: ${r.title}` : null);
  await telegram("editMessageText", { chat_id: u.chat_id, message_id: u.message_id, text, ...PLAIN, reply_markup: { inline_keyboard: buttons } }).catch(() => {});
}

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
// The message's buttons go when its text is edited, unless the answer gives new ones.
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
  // Didn't start's answer carries buttons of its own (the next free slot, Tomorrow).
  let { changes, text, buttons } = handleTap(t, snap, now) as { changes: Change[]; text: string; buttons?: { text: string; callback_data: string }[] };
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
  await telegram("editMessageText", { chat_id: t.chat_id, message_id: t.message_id, text, ...PLAIN, ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}) }).catch(() => {});
}

// The webhook must ask for texts as well as taps, or Telegram never delivers a text to the bot
// (docs/sheet-messages.md, "From Telegram"). A webhook set before texts were handled asked for
// callback_query only, so the minute tick checks it and widens it in place, keeping its URL and
// secret. getWebhookInfo leaves allowed_updates out when it is the default, which includes
// message. https://core.telegram.org/bots/api#getwebhookinfo, #setwebhook
const UPDATES = ["callback_query", "message"];
let hookChecked = false;
async function ensureWebhook() {
  if (hookChecked || !WEBHOOK_SECRET) return "checked";
  const info = await telegram("getWebhookInfo", {});
  const allowed: string[] | undefined = info.allowed_updates;
  if (!info.url || !allowed || UPDATES.every((u) => allowed.includes(u))) {
    hookChecked = true;
    return info.url ? "ok" : "no webhook";
  }
  await telegram("setWebhook", { url: info.url, secret_token: WEBHOOK_SECRET, allowed_updates: UPDATES });
  hookChecked = true;
  return "widened";
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
