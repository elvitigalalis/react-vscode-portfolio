// The Gym tracker's outbox (docs/sheet-gym.md, "Offline"): every write is kept on the phone first
// (localStorage), one entry per row, then sent to Supabase. Rows carry ids made on the phone
// (crypto.randomUUID), so a resend is an upsert of the same row and never a second copy. An
// entry leaves the outbox only once the server took that exact version.

// Parents before children, so a set never goes up before its session (foreign keys).
export const TABLES = ["gym_exercises", "gym_program_days", "gym_prescriptions", "gym_baselines", "gym_sessions", "gym_sets", "gym_swaps"];
// The column a table upserts on.
export const keyOf = (table) => (table === "gym_baselines" ? "exercise_id" : "id");

// `storage` is localStorage, or anything with getItem and setItem; when it throws the outbox
// still works, in memory. send({ op: "upsert", table, rows } | { op: "delete", table, ids })
// throws when the server didn't take it.
export function outbox(storage, name = "sheet.gym.outbox") {
  let entries;
  try { entries = JSON.parse(storage.getItem(name)) ?? []; } catch { entries = []; }
  let version = Math.max(0, ...entries.map((e) => e.v));
  let running = null;
  const save = () => { try { storage.setItem(name, JSON.stringify(entries)); } catch {} };
  const at = (table, id) => entries.findIndex((e) => e.table === table && e.id === id);
  // Entries in a send under way: the server may have them whatever the send's outcome.
  let sending = new Set();
  function keep(entry) {
    const i = at(entry.table, entry.id);
    entry.v = ++version;
    // A row first made on the phone stays fresh until a send of it starts.
    if (entry.op === "upsert" && i >= 0 && entries[i].fresh && !sending.has(entries[i])) entry.fresh = true;
    if (i < 0) entries.push(entry); else entries[i] = entry;
    save();
  }
  // A delete of a fresh row (the server never had it) just forgets it: nothing to send.
  function forget(table, id) {
    const i = at(table, id);
    if (i < 0 || !entries[i].fresh || sending.has(entries[i])) return false;
    entries.splice(i, 1);
    save();
    return true;
  }

  async function run(send) {
    const batch = entries.slice();
    sending = new Set(batch);
    const done = (sent) => {
      entries = entries.filter((e) => !sent.some((s) => s.table === e.table && s.id === e.id && s.v === e.v));
      save();
    };
    try {
      for (const table of TABLES) {
        const ups = batch.filter((e) => e.op === "upsert" && e.table === table);
        if (ups.length) { await send({ op: "upsert", table, rows: ups.map((e) => e.row) }); done(ups); }
      }
      for (const table of TABLES.toReversed()) {
        const dels = batch.filter((e) => e.op === "delete" && e.table === table);
        if (dels.length) { await send({ op: "delete", table, ids: dels.map((e) => e.id) }); done(dels); }
      }
      return true;
    } catch {
      // A failed send may still have reached the server: what it carried is no longer fresh.
      for (const e of entries) if (sending.has(e)) delete e.fresh;
      save();
      return false;
    } finally {
      sending = new Set();
    }
  }

  return {
    // fresh: the row was just made on the phone (a new set), so the server hasn't got it yet.
    put: (table, row, { fresh = false } = {}) => keep({ op: "upsert", table, id: row[keyOf(table)], row, ...(fresh ? { fresh } : {}) }),
    drop: (table, id) => forget(table, id) || keep({ op: "delete", table, id }),
    pending: () => entries.length,
    // The queued rows of a table, for drawing what the server hasn't got yet.
    rows: (table) => entries.filter((e) => e.op === "upsert" && e.table === table).map((e) => e.row),
    dropped: (table) => entries.filter((e) => e.op === "delete" && e.table === table).map((e) => e.id),
    // One flush at a time: what was saved while one runs goes up before it ends, and a call made
    // meanwhile (the phone came back online) tries again once it's done. True when all went up.
    flush(send) {
      if (running) return running.then(() => this.flush(send));
      running = (async () => {
        let ok;
        do ok = await run(send); while (ok && entries.length);
        return ok;
      })().finally(() => { running = null; });
      return running;
    },
  };
}
