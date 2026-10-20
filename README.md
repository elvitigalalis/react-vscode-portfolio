# lisul-elvi.com

Source for [www.lisul-elvi.com](https://www.lisul-elvi.com), Lisul Elvitigala's portfolio.

A static [Astro](https://astro.build) site, started from
[devportfolio](https://github.com/RyanFitzgerald/devportfolio) by Ryan Fitzgerald
(MIT, see `LICENSE-devportfolio.md`).

```sh
npm install
npm run dev      # local server
npm run build    # static site in dist/
npm run preview  # serve dist/
npm run check    # build, then every gate below (needs lychee and Chrome)
npm test         # each gate against the real build and a fixture broken on purpose
```

`npm run check` gates the built site; CI (`.github/workflows/check.yml`) runs it on every
push and PR. `node check/run.mjs <gate>` runs one gate over an existing `dist/`.

| Gate | Checks |
|---|---|
| schema | `src/data/resume.json` matches its schema |
| mirror | every résumé fact is verbatim on `/`, each write-up's "At a glance" has its bullets, no phone number |
| lint | numbers in `src/content/**/*.md` trace to `resume.json` or the file's `sources:`; no banned wording; no `TODO(Lisul)` marker |
| length | each write-up runs 700–1,200 words (aim: 1,000) with 2–4 figures; see below |
| tags | title, description, canonical; once any preview tag exists, full Open Graph, twitter:card, OG image, JSON-LD and sitemap |
| routing | `/404.html`, the old PDF path, the old `#/section` hash rewrite |
| html | html-validate (recommended) |
| links | lychee on internal links and anchors; `CHECK_EXTERNAL_LINKS=1` (set on every CI run: push, PR and weekly) adds external ones with retries, 429 accepted, LinkedIn excluded |
| a11y | pa11y-ci with axe, WCAG 2.2 AA, on every page |
| lighthouse | Lighthouse CI, mobile, budgets in `lighthouserc.cjs` |

### How a write-up's length is counted

One rule, in `check/writeup.mjs`, serves the `length` gate and the tests. It counts every word
of rendered text in the write-up's `<article>` except the header (title, role, dates, tags,
links), the "At a glance" box and every figure with its caption. So the summary, the body and
the closing links count; the clip or screenshot under the summary does not. A word is any run
of characters between spaces that holds a letter or digit ("2.75°" counts, "→" does not). The
2–4 figures include the lead clip (Micromouse) or screenshot (WorkIt).
