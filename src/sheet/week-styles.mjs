// The week's styles (plan-week.css): its columns, rows, calendar blocks and empty states, added as
// text once signed in. The first draw (the snapshot's too) waits for this module (planner.mjs,
// drawWaits), so nothing shows unstyled. Vite's ?inline keeps them out of the page's CSS, and the
// import keeps them out of its first-load script: signed out, /plan draws no week, and
// Lighthouse's unused-css-rules gate would count them (as calm-styles.mjs does).
import css from "../styles/plan-week.css?inline";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
