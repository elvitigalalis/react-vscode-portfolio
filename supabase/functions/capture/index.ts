// The capture Edge Function (docs/sheet-voice.md): an iPhone Shortcut POSTs { text } of what Lisul
// dictated, with Authorization: Bearer SHEET_CAPTURE_TOKEN. The words go in the Inbox first, then
// Haiku tidies them into tasks. The reply is one plain line for the Shortcut to show.
//
// Deploy from the repo root:
//   npx supabase functions deploy capture --use-api --no-verify-jwt
// Secrets: SHEET_CAPTURE_TOKEN, ANTHROPIC_API_KEY (ADR 0007). Neither is logged or returned.
import { messageText } from "../../../src/sheet/messages.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";
import { ADD_TASKS_TOOL, MAX_VOCABULARY, MODEL, captureRows, rawRow, replyLine, systemPrompt, toolInput, vocabulary } from "../../../src/sheet/voice.mjs";
import { db, env, secretMatches } from "../_shared/server.ts";

const TOKEN = env("SHEET_CAPTURE_TOKEN");
const KEY = env("ANTHROPIC_API_KEY");
const line = (text: string, status = 200) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// Titles of recent open tasks, for spelling names and course codes (ADR 0007). Titles only, and not
// mail-suggested ones, whose words came from a stranger's message. Without them, parsing still works.
const recentTerms = (rawId: string) =>
  db(`tasks?select=title&done=is.false&id=neq.${rawId}&or=(source.is.null,source.neq.mail)&order=created_at.desc&limit=${MAX_VOCABULARY}`)
    .then(vocabulary)
    .catch(() => []);

async function parsed(text: string, today: string, terms: string[]) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt(today, terms),
      tools: [ADD_TASKS_TOOL],
      tool_choice: { type: "tool", name: ADD_TASKS_TOOL.name },
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic: ${res.status}`);
  return captureRows(toolInput(await res.json()), today);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
  const bearer = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!TOKEN || !secretMatches(bearer, TOKEN)) return line("Not allowed", 403);
  try {
    const text = messageText((await req.json().catch(() => null))?.text);
    if (!text) return line("Didn't catch that", 400);

    const position = Date.now() / 1000;
    const [raw] = await db("tasks?select=id", {
      method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rawRow(text, position)),
    });
    let rows = null;
    try {
      const [[{ time_zone }], terms] = await Promise.all([db("settings?select=time_zone"), recentTerms(raw.id)]);
      rows = await parsed(text, localNow(new Date(), time_zone).day, terms);
      if (rows) {
        const [first, ...rest] = rows;
        // Extras first: if either write fails the raw words are still there.
        if (rest.length) await db("tasks", { method: "POST", body: JSON.stringify(rest.map((r, i) => ({ ...r, public: false, position: position + i + 1 }))) });
        await db(`tasks?id=eq.${raw.id}`, { method: "PATCH", body: JSON.stringify(first) });
      }
    } catch (e) {
      rows = null;
      console.error("capture parse:", e instanceof Error ? e.message : "failed");
    }
    return line(replyLine(rows));
  } catch (e) {
    console.error("capture:", e instanceof Error ? e.message : "failed");
    return line("Couldn't save. Try again", 500);
  }
});
