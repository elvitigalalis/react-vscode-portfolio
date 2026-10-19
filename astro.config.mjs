// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.lisul-elvi.com",
  build: { inlineStylesheets: "always" },
  // Every page, write-ups included, lands in sitemap-index.xml without a list to maintain.
  integrations: [sitemap()],
});
