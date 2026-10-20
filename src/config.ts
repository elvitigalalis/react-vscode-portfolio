// Site-wide settings that are not résumé facts.
import { ORIGIN, RESUME_PDF } from "./site.mjs";

export const siteConfig = {
  url: ORIGIN,
  title: "Lisul Elvitigala",
  description:
    "Lisul Elvitigala, software engineer and Stony Brook computer science student: projects, experience, education and skills, with the résumé PDF.",
  resumePdf: RESUME_PDF,
  // The link-preview image: 1200×630 PNG drawn by tools/brand.mjs. Name, role and one line,
  // large and centred so a square crop (iMessage, WhatsApp) keeps them; PNG because LinkedIn
  // does not take WebP; under WhatsApp's ~300 KB ceiling.
  ogImage: {
    src: "/og.png",
    width: 1200,
    height: 630,
    alt: "Lisul Elvitigala, Software Engineer: Computer Science at Stony Brook University",
  },
};
