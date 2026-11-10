// The Doing card's and the Reflow line's styles (sheet-doing.css), added as text the first time
// either module loads; both load after sign-in, so /plan's first load carries none of these rules
// (Lighthouse's unused-css-rules gate), as calm-styles.mjs does.
import css from "../styles/sheet-doing.css?inline";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
