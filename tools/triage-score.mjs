// Scores a run's Needs you items against Lisul's labelled decisions (docs/sheet-v5.md,
// "triage.mjs", v5 L1), so a prompt change can be checked before it goes live:
//
//   node tools/triage-score.mjs <run.json> [days]
//
// run.json is the run's Needs you items: a list of { account, message_id }, or a submit_proposal
// input with them in `needs_you`. The labels come from the live `feedback` table, read-only
// through `supabase db query --read-only` (as tools/verify-sheet-v4.sh), over the last `days`
// days (default 14). Sign in with `npx supabase login` first; SHEET_DB_TARGET overrides the
// database, as there. It prints counts and "<account> <message_id>" keys only, never mail text.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rowsOf } from "./sheet-check.mjs";
import { scoreTriage, triageLabels } from "../src/sheet/triage.mjs";

const ID = /^[0-9a-f]{6,32}$/;

// The items of a run file: [{ account, message_id }], with ids that aren't hex left out.
export function runItems(json) {
  const list = Array.isArray(json) ? json : json?.needs_you;
  if (!Array.isArray(list)) throw new Error("run.json: expected a list of { account, message_id } or { needs_you }");
  return list.filter((x) => typeof x?.account === "string" && ID.test(x?.message_id ?? ""))
    .map((x) => ({ account: x.account, message_id: x.message_id }));
}

// The score as lines: one count line per list, then its keys.
export function scoreLines({ caught, missed, wrongly_shown }) {
  const part = (name, keys) => [`${name}: ${keys.length}`, ...keys.map((k) => `  ${k}`)];
  return [...part("caught", caught), ...part("missed", missed), ...part("wrongly shown", wrongly_shown)];
}

// The SQL: needs_you feedback of the last `days` days, ids and actions only.
export const feedbackSql = (days) =>
  `select at, item, action, ref from feedback where item = 'needs_you' and at > now() - interval '${days} days' order by at`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, daysArg = "14"] = process.argv.slice(2);
  const days = Number(daysArg);
  if (!file || !Number.isInteger(days) || days < 1 || days > 120) {
    console.error("usage: node tools/triage-score.mjs <run.json> [days, 1-120]");
    process.exit(2);
  }
  try {
    const items = runItems(JSON.parse(readFileSync(file, "utf8")));
    const site = readFileSync(new URL("../src/site.mjs", import.meta.url), "utf8");
    const ref = /supabaseUrl: "https:\/\/([^.]+)\./.exec(site)?.[1];
    const target = process.env.SHEET_DB_TARGET || ref;
    const out = execFileSync("npx", ["-y", "supabase@latest", "db", "query", "--read-only", "-o", "json", `--remote=${target}`, feedbackSql(days)], { encoding: "utf8" });
    console.log(scoreLines(scoreTriage(items, triageLabels(rowsOf(out)))).join("\n"));
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    process.exit(2);
  }
}
