// Changes shown before they are saved (docs/sheet.md, "Saving in the background"). A change shows
// at once and its save runs in the background, after any earlier save of the same row, so the
// server gets a row's changes in the order they were made. What shows for a row is always the
// last copy the server confirmed with the changes still out laid on top: a save that works makes
// its answer the confirmed copy, and one that fails drops only its own change, so the row falls
// back to what the server holds. A load whose read may have missed a save (it read while the save
// was out) keeps what the saves wrote (keep). A row deleted here is forgotten (forget): a save of it
// still out lands without putting it back, and a load that read before the delete leaves it out.
// Pure: the rows live wherever get, set and drop put them.

export function ledger({ get, set, drop = () => {} }) {
  const open = new Map();  // key -> { base, ops, tail }: the confirmed copy, changes out, save queue
  const wrote = new Map(); // key -> { at, row }: copies a save confirmed, by the clock then
  const gone = new Map();  // key -> at: rows deleted here, by the clock then
  const held = new Map();  // key -> entry: a deleted row's saves, kept until the delete is known
  let clock = 0;
  const shown = (e) => e.ops.reduce((row, op) => ({ ...row, ...op.change }), e.base);

  function settle(key, e, op, saved, ok) {
    e.ops.splice(e.ops.indexOf(op), 1);
    // Deleted meanwhile: nothing shows, but the confirmed copy follows the save, in case the
    // delete fails and the row comes back (restore).
    if (e.gone) {
      if (ok) { e.base = saved ?? { ...e.base, ...op.change }; e.landed = true; }
      return;
    }
    if (ok) {
      e.base = saved ?? { ...e.base, ...op.change };
      wrote.set(key, { at: ++clock, row: e.base });
    }
    set(key, shown(e));
    if (!e.ops.length && open.get(key) === e) open.delete(key);
  }

  return {
    // Shows `change` on the row now and runs `save` after the row's earlier saves. `save` resolves
    // to the saved row (or nothing: the change as made is what was saved). The promise settles
    // with the save; on a failure the change is gone from the row before it rejects.
    write(key, change, save) {
      const row = get(key);
      if (!row) return Promise.resolve().then(save);
      let e = open.get(key);
      if (!e) open.set(key, (e = { base: row, ops: [], tail: Promise.resolve() }));
      const op = { change };
      e.ops.push(op);
      set(key, shown(e));
      const run = e.tail.then(() => save());
      e.tail = run.then(() => {}, () => {});
      return run.then(
        (saved) => { settle(key, e, op, saved, true); return saved; },
        (err) => { settle(key, e, op, null, false); throw err; },
      );
    },
    // A row saved outside write (a new task): a load already reading keeps it too.
    note(key, row) { wrote.set(key, { at: ++clock, row }); },
    // The clock to pass to keep(): take it before a load's read starts.
    now: () => clock,
    // After a load put its rows in: rows a save confirmed after `since` (the load's read may
    // predate it) show what the save wrote, and rows with changes out show them again, on top of
    // the row just read unless a save confirmed a newer copy; rows deleted after `since` go.
    // True when it changed a row the load read (so the read isn't the page's state).
    keep(since) {
      let changed = false;
      for (const [key, e] of open) {
        const fresh = get(key);
        if (fresh && !(wrote.get(key)?.at > since)) e.base = fresh;
        set(key, shown(e));
        changed = true;
      }
      for (const [key, w] of wrote) {
        if (w.at <= since) wrote.delete(key);
        else if (!open.has(key)) { set(key, w.row); changed = true; }
      }
      for (const [key, at] of gone) {
        if (at <= since) gone.delete(key);
        else if (get(key)) { drop(key); changed = true; }
      }
      return changed;
    },
    // The row was deleted: saves of it still out change nothing when they land.
    forget(key) {
      const e = open.get(key);
      if (e) { e.gone = true; held.set(key, e); }
      open.delete(key);
      wrote.delete(key);
      gone.set(key, ++clock);
    },
    // A delete that failed: loads keep the row again, and its saves pick up where they were.
    // Returns the row to show (the confirmed copy with the changes still out), or null when
    // none were out.
    restore(key) {
      gone.delete(key);
      const e = held.get(key);
      held.delete(key);
      if (!e) return null;
      e.gone = false;
      if (e.ops.length) open.set(key, e);
      // A save that landed while it was deleted: a load already reading keeps what it wrote.
      if (e.landed) wrote.set(key, { at: ++clock, row: e.base });
      return shown(e);
    },
    // The delete went through: its saves are of no more use.
    release(key) { held.delete(key); },
    pending: (key) => open.has(key),
    // The row as the server last confirmed it, without the changes still out (what an Undo
    // goes back to).
    confirmed: (key) => open.get(key)?.base ?? get(key),
  };
}
