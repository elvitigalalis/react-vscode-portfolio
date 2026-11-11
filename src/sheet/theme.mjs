// The planner's light/dark/system switch (docs/sheet.md, "Look"): every [data-theme-switch]
// button steps System → Light → Dark. It keeps the site's `theme` key in localStorage, which
// Base.astro's theme-init script reads before first paint; System removes the key so the OS
// decides. A forced theme also gives the browser bar the page's colour.

const ORDER = ["system", "light", "dark"];
const NAME = { system: "System", light: "Light", dark: "Dark" };
const ICON = { system: "#i-monitor", light: "#i-sun", dark: "#i-moon" };

export function setupTheme(doc = document) {
  const root = doc.documentElement;
  const metas = [...doc.querySelectorAll('meta[name="theme-color"]')];
  const defaults = metas.map((m) => m.content);
  const current = () => root.dataset.theme ?? "system";
  const sync = () => {
    const now = current();
    const next = ORDER[(ORDER.indexOf(now) + 1) % ORDER.length];
    for (const b of doc.querySelectorAll("[data-theme-switch]")) {
      b.hidden = false;
      const use = b.querySelector("use");
      // The icon button names its state in its label; the menu item says it in words.
      if (use) {
        use.setAttribute("href", ICON[now]);
        b.ariaLabel = `Theme: ${NAME[now]}. Switch to ${NAME[next]}`;
        b.title = `Theme: ${NAME[now]}`;
      } else b.textContent = `Theme: ${NAME[now]}`;
    }
    const bg = getComputedStyle(doc.body).backgroundColor;
    metas.forEach((m, i) => { m.content = now === "system" ? defaults[i] : bg; });
  };
  doc.addEventListener("click", (e) => {
    if (!e.target.closest?.("[data-theme-switch]")) return;
    const next = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {}
    sync();
  });
  // Back/Forward can restore the page with the theme it had then (Base.astro re-reads it first).
  addEventListener("pageshow", sync);
  sync();
}
