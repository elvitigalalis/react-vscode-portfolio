// /plan at a glance (docs/sheet-glance.md, "Contracts → Pure functions"): pure helpers for the
// icons, colours and drawn bars. Each ticket keeps its functions in its own section below.

// --- feedAlert (G4: the top bar's Feed failed chip) ------------------------------------------

// The sources whose last read failed, in row order. ok null means not read yet, not failed.
export const feedAlert = (feedRows) => feedRows.filter((f) => f.ok === false).map((f) => f.source);
