// The over-commit note's and the carried-over menu's styles (sheet-calm.css), added as text when
// this module first loads: callers import() it the first time either shows. Vite's ?inline keeps
// them out of the page's CSS, so Lighthouse's unused-css-rules gate doesn't count them on a first
// load that never draws them (as lookback-view.mjs does).
import css from "../styles/sheet-calm.css?inline";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
