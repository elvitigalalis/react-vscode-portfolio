// Lighthouse CI budgets (spec #152 "Quality bar"; tool choices from research/site-quality-bar).
// Mobile emulation is Lighthouse's default. LHCI applies every entry whose pattern matches, so
// each URL matches exactly one budget entry, plus the warn-only entry.
const fail = (opts) => ["error", opts];
const all = {
  "categories:performance": fail({ minScore: 0.95, aggregationMethod: "median-run" }),
  "categories:accessibility": fail({ minScore: 1 }),
  "categories:best-practices": fail({ minScore: 1 }),
  "categories:seo": fail({ minScore: 1 }),
  "largest-contentful-paint": fail({ maxNumericValue: 2500 }),
  "cumulative-layout-shift": fail({ maxNumericValue: 0.1 }),
  "total-blocking-time": fail({ maxNumericValue: 200 }),
  "resource-summary:script:size": fail({ maxNumericValue: 5 * 1024 }),
  "resource-summary:font:size": fail({ maxNumericValue: 0 }),
  "resource-summary:third-party:count": fail({ maxNumericValue: 0 }),
  // The local static server does not gzip; GitHub Pages does.
  "uses-text-compression": "off",
  // At Lighthouse's 1.75x mobile DPR the 640w card photo is the right srcset pick, but this
  // insight compares it with the CSS size. Byte budgets above still cap image weight.
  "image-delivery-insight": "warn",
};
const home = { "resource-summary:total:size": fail({ maxNumericValue: 100 * 1024 }), "resource-summary:total:count": fail({ maxNumericValue: 15 }) };
const writeup = { "resource-summary:total:size": fail({ maxNumericValue: 300 * 1024 }) };
// The Sheet's pages (docs/sheet.md) run the planner's script and read one third-party origin,
// Supabase; they are noindex, so they cannot be "crawlable" either.
const sheet = {
  "resource-summary:script:size": fail({ maxNumericValue: 60 * 1024 }),
  "resource-summary:third-party:count": fail({ maxNumericValue: 1 }),
  "resource-summary:total:size": fail({ maxNumericValue: 150 * 1024 }),
  "categories:seo": "off", "is-crawlable": "off",
  // The week is drawn by the page's script from Supabase, so HTML → script → data is the page
  // itself, not a chain to cut; a preconnect to Supabase shortens it.
  "network-dependency-tree-insight": "off",
};
// The 404 page is noindex on purpose, so it cannot be "crawlable".
const notFound = { "categories:seo": "off", "is-crawlable": "off" };

const entry = (matchingUrlPattern, ...parts) => ({ matchingUrlPattern, preset: "lighthouse:recommended", assertions: Object.assign({}, all, ...parts) });

module.exports = {
  ci: {
    collect: { staticDistDir: "./dist", numberOfRuns: 3, settings: { chromeFlags: "--no-sandbox --headless=new" } },
    assert: {
      assertMatrix: [
        entry("/404\\.html$", home, notFound),
        entry("/projects/", writeup),
        entry("/(plan|now)/", sheet),
        entry("^(?!.*/projects/)(?!.*/(plan|now)/)(?!.*/404\\.html$).*$", home),
        // Drift shows up as a warning well before it fails.
        { matchingUrlPattern: ".*", assertions: {
          "largest-contentful-paint": ["warn", { maxNumericValue: 1500 }],
          "cumulative-layout-shift": ["warn", { maxNumericValue: 0.02 }],
          "total-blocking-time": ["warn", { maxNumericValue: 50 }],
        } },
      ],
    },
  },
};
