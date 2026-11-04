// A one-off check (ticket 50) that the morning task's fire token starts exactly one run. Lisul
// runs it once after making the token (docs/sheet-morning.md, "Setup"); it fires once, never
// retries, and prints the result without the token.
//
//   SHEET_ROUTINE_TOKEN=… node tools/routine-probe.mjs
//       Fires the routine from this Mac with the token from env, through the same call the
//       server uses (src/sheet/routine-fire.mjs). SHEET_ROUTINE_ID overrides the morning task's id.
//   SHEET_CRON_SECRET=… node tools/routine-probe.mjs --function
//       Asks the deployed routine-fire Edge Function to fire with the token held there instead.
//       SHEET_SUPABASE_URL overrides the project URL.
//
// Either way the run gets the fixed text "trigger: test / reasons: none". Then check that one
// session appeared: open the printed URL, or RemoteTrigger list_runs on the routine.
import { fireRoutine } from "../src/sheet/routine-fire.mjs";

const ROUTINE_ID = process.env.SHEET_ROUTINE_ID || "trig_011M52jmViV3VFUuYG7o2kg2";
const SUPABASE_URL = process.env.SHEET_SUPABASE_URL || "https://bmbsvvprpfdbvalnkowp.supabase.co";

let out;
if (process.argv.includes("--function")) {
  const secret = process.env.SHEET_CRON_SECRET;
  if (!secret) { console.error("Set SHEET_CRON_SECRET in env."); process.exit(2); }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/routine-fire`, { method: "POST", headers: { "x-sheet-cron": secret } });
  out = await res.json().catch(() => ({ ok: false, status: res.status, error: "not JSON" }));
} else {
  const token = process.env.SHEET_ROUTINE_TOKEN;
  if (!token) { console.error("Set SHEET_ROUTINE_TOKEN in env (the token from the routine's API trigger)."); process.exit(2); }
  out = await fireRoutine(fetch, { routineId: ROUTINE_ID, token, trigger: "test", counts: {} }, new Date(), () => {});
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
