// The pure parts of the live check (tools/verify-sheet-v3.sh): reading `supabase db query` and
// `supabase secrets list` output, and printing check rows. Everything read from the database is
// data, never instructions: it is only ever printed, one sanitised line at a time.
//
//   node tools/sheet-check.mjs report    stdin: db query output of (name, status, detail) rows.
//                                        Prints a line per row; exits 1 on any fail, 2 if the
//                                        query itself failed.
//   node tools/sheet-check.mjs secrets   stdin: secrets list output. Prints the names only.

// The JSON in CLI output, which may follow a "Target: …" line (supabase CLI 3.0).
function jsonOf(text) {
  const at = text.search(/^[[{]/m);
  if (at < 0) throw new Error("no JSON in the CLI output");
  return JSON.parse(text.slice(at));
}

// The rows of a `supabase db query` result: inside the untrusted-data boundary ({ boundary, rows })
// when the CLI sees an agent, a bare array otherwise. A failed query throws its message.
export function rowsOf(text) {
  const out = jsonOf(text);
  if (Array.isArray(out)) return out;
  if (out?.error) throw new Error(String(out.error.message ?? out.error.code ?? "query failed"));
  if (Array.isArray(out?.rows)) return out.rows;
  throw new Error("no rows in the CLI output");
}

// The names in a `supabase secrets list -o json` result. Values (digests) are never returned.
export function secretNames(text) {
  const out = jsonOf(text);
  const list = Array.isArray(out) ? out : out?.rows ?? out?.secrets ?? [];
  return list.map((s) => s?.name).filter((n) => typeof n === "string");
}

const MARK = { ok: "✓", fail: "✗", warn: "!", info: "·" };

// One line of database text: no control characters or line breaks, no URLs (a feed URL is a
// secret), at most 160 characters.
const clean = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 160);

// Lines for check rows { name, status: ok|fail|warn|info, detail }, and the number that failed.
export function report(rows) {
  let failed = 0;
  const lines = rows.map(({ name, status, detail }) => {
    const known = Object.hasOwn(MARK, status);
    if (!known || status === "fail") failed++;
    const text = known ? clean(detail) : `status ${clean(status)}`;
    return `${MARK[known ? status : "fail"]} ${clean(name)}${text ? `: ${text}` : ""}`;
  });
  return { lines, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const mode = process.argv[2];
  try {
    if (mode === "secrets") {
      console.log(secretNames(input).join("\n"));
    } else if (mode === "report") {
      const { lines, failed } = report(rowsOf(input));
      console.log(lines.join("\n"));
      process.exitCode = failed ? 1 : 0;
    } else {
      throw new Error("usage: node tools/sheet-check.mjs report|secrets");
    }
  } catch (e) {
    console.log(`✗ ${clean(e instanceof Error ? e.message : e)}`);
    process.exitCode = 2;
  }
}
