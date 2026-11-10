// Where the stored week lives (snapshot.mjs). Its own module so the planner can clear it on
// signing out without loading snapshot.mjs, which loads only after sign-in.
export const SNAPSHOT_KEY = "sheet.snapshot.v1";
