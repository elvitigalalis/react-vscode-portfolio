// feed_state's last good read (docs/sheet-v5.md, "Feeds"). feed_state keeps one row per feed and
// a failed read overwrites fetched_at, so last_ok_at holds the time of the last read that worked:
// Slack's and Gmail's catch-up start from it, and Settings lists the feeds never set up. Pure, so
// the Edge Functions (_shared/server.ts, slack-sync, mail-sync), /plan and the tests share it.
import { localNow } from "./logic.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// The row a sync upserts: a read that worked (ok true) also sets last_ok_at to its fetched_at. A
// failed or skipped read (ok false or null) leaves last_ok_at as it was, since the upsert only
// changes the columns it sends.
export function feedStateRow(source, row) {
  return row.ok === true ? { source, ...row, last_ok_at: row.fetched_at } : { source, ...row };
}

// The last good read's time, or null. A row written before last_ok_at existed counts its
// fetched_at when that read worked.
function lastOk(state) {
  const at = state?.last_ok_at ?? (state?.ok === true ? state.fetched_at : null);
  return at ? new Date(at) : null;
}

// Where slack-sync's search starts: the last good read, however many reads failed since, or a day
// back with none ("since yesterday", spec 47 story 65).
export const slackSince = (state, now) => lastOk(state) ?? new Date(now.getTime() - DAY_MS);

// Whether mail-sync sweeps this run: on the first good read of the local day (the last good read
// was on an earlier day), after a failed read, and when nothing has read well yet.
export function mailSweepDue(state, now, timeZone) {
  const last = lastOk(state);
  if (!last || state.ok !== true) return true;
  return localNow(last, timeZone).day !== localNow(now, timeZone).day;
}

// Settings' feed rows: one per source in `sources`, in that order, with { source, missing: true }
// for a source that has never written a row (a sync that isn't set up writes nothing), then any
// other row.
export function feedRows(rows, sources) {
  const bySource = new Map(rows.map((r) => [r.source, r]));
  return [
    ...sources.map((source) => bySource.get(source) ?? { source, missing: true }),
    ...rows.filter((r) => !sources.includes(r.source)),
  ];
}
