// /plan at a glance (docs/sheet-glance.md, "Contracts → Pure functions"): what the page draws
// instead of writing out in words. Pure, so node --test covers it.

// --- Sources and due levels (G2) ---------------------------------------------------------

// A task's source, for its edge colour and icon: Brightspace first, then the #campus tag.
export const sourceOf = (task) =>
  task.source === "brightspace" ? "course" : task.tag === "campus" ? "campus" : null;
