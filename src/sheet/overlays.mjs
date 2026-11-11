// The menus', dialogs' and toast's styles (plan-overlays.css, docs/sheet.md "Look"), added as text
// once he is signed in (a plugin in plan/index.astro), so the signed-out page that Lighthouse
// audits carries none of them. Nothing opens before the week is drawn, and this lands first.
import css from "../styles/plan-overlays.css?inline";

document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
