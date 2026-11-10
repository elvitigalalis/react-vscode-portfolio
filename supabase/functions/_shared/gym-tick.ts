// Ending the day's Gym habit block from a workout (ring.mjs gymMatches), shared by oura-sync (ring
// workouts) and hevy-sync (Hevy workouts as ring workouts, hevy.mjs asRingWorkouts).
import { gymDone, gymMatches } from "../../../src/sheet/ring.mjs";
import { addDays } from "../../../src/sheet/logic.mjs";
import { habitDay } from "../../../src/sheet/habit-rate.mjs";
import { db } from "./server.ts";

// The Gym habit blocks of yesterday and today that a ring workout finished, ended or dropped as
// a Done tap does (nudges.mjs): the block by its id, and its Google event through gcal_pending,
// which /plan applies when it opens. Each workout that finished a Gym block also ticks the habit
// in habit_done (docs/sheet-habits.md).
export async function tickGym(workouts: unknown[], tz: string, today: string) {
  const from = new Date(Date.parse(`${addDays(today, -1)}T00:00:00Z`) - 86_400_000).toISOString();
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const [habits, blocks] = await Promise.all([
    db("habits?select=id,name"),
    db(`blocks?select=id,habit_id,starts_at,ends_at,proposed,gcal_id&habit_id=not.is.null&starts_at=gte.${from}&starts_at=lt.${to}`),
  ]);
  const matches = gymMatches(workouts, blocks, habits, tz);
  for (const m of matches) {
    if (m.action === "shrink") await db(`blocks?id=eq.${m.block_id}`, { method: "PATCH", body: JSON.stringify({ ends_at: m.ends_at }) });
    else await db(`blocks?id=eq.${m.block_id}`, { method: "DELETE" });
    if (m.gcal_id) {
      await db("gcal_pending?on_conflict=gcal_id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ gcal_id: m.gcal_id, ends_at: m.action === "shrink" ? m.ends_at : null }),
      });
    }
  }
  // The habit's tick for the day the workout ended (4 am to 4 am), as /plan's ✓ writes it.
  const done = gymDone(workouts, blocks, habits, tz).map((d) => ({ habit_id: d.habit_id, day: habitDay(new Date(d.ends_at), tz) }));
  const rows = [...new Map(done.map((d) => [`${d.habit_id}|${d.day}`, d])).values()];
  if (rows.length) {
    await db("habit_done?on_conflict=habit_id,day", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows),
    });
  }
  return matches.length;
}
