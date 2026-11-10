// Where the stored week lives (snapshot.mjs). Its own module so the planner can clear it on
// signing out without loading snapshot.mjs, which loads only after sign-in.
export const SNAPSHOT_KEY = "sheet.snapshot.v1";

// A copy whose token doesn't say who stored it is taken out of `storage` while /plan finds out
// whose it is (planner.mjs). `putBack` returns it unless a newer copy was stored meanwhile; the
// planner calls it unless the account turns out not to be one that can open the planner.
export function holdCopy(storage) {
  let text = null;
  try { text = storage?.getItem(SNAPSHOT_KEY) ?? null; storage?.removeItem(SNAPSHOT_KEY); } catch {}
  return {
    text,
    putBack() {
      try { if (text != null && storage.getItem(SNAPSHOT_KEY) == null) storage.setItem(SNAPSHOT_KEY, text); } catch {}
    },
  };
}
