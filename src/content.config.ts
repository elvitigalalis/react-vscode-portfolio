// Write-ups: hand-written depth, one markdown file per project, keyed by its resume.json slug.
// Adding src/content/writeups/<slug>.md builds /projects/<slug>/ and shows the card's Write-up button.
// Every number in a write-up traces to resume.json or to one of its `sources:` lines.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const writeups = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/writeups" }),
  schema: z.object({
    // Meta description for search results and link previews.
    description: z.string(),
    // The 2-3 sentence result, shown under the header.
    summary: z.string(),
    // The project card's photo on the home page: 640 px wide, with a -360 copy beside it.
    photo: z.object({ src: z.string(), alt: z.string() }).optional(),
    // The card's and the header's Demo or Video button, label and all.
    demo: z.object({ url: z.string(), label: z.string() }).optional(),
    // Click-to-play clip under the summary: muted, captioned, never preloaded.
    video: z
      .object({
        src: z.string(),
        poster: z.string(),
        captions: z.string(),
        width: z.number(),
        height: z.number(),
        caption: z.string(),
      })
      .optional(),
    // A screenshot under the summary, for a project with no clip (WorkIt).
    screenshot: z
      .object({
        src: z.string(),
        alt: z.string(),
        width: z.number(),
        height: z.number(),
        caption: z.string(),
      })
      .optional(),
    // Where each fact and number comes from, described in words (never copied from the private bank).
    sources: z.array(z.string()).min(1),
  }),
});

export const collections = { writeups };
