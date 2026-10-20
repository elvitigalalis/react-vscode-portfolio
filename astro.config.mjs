// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { ORIGIN } from "./src/site.mjs";

export default defineConfig({
  site: ORIGIN,
  build: { inlineStylesheets: "always" },
  // Every page, write-ups included, lands in sitemap-index.xml without a list to maintain.
  // The Sheet's pages (/plan, /now) are noindex, so they stay out of it.
  integrations: [sitemap({ filter: (page) => !/\/(plan|now)\/$/.test(page) })],
});
