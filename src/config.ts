// Site-wide settings that are not résumé facts.
import { ORIGIN, RESUME_PDF } from "./site.mjs";

export const siteConfig = {
  url: ORIGIN,
  title: "Lisul Elvitigala",
  description:
    "Lisul Elvitigala, software engineer and Stony Brook computer science student: projects, experience, education and skills, with the résumé PDF.",
  resumePdf: RESUME_PDF,
  // The link-preview image: 1200×630, no text in it (Apple and LinkedIn crop or reject otherwise).
  ogImage: {
    src: "/og.jpg",
    width: 1200,
    height: 630,
    alt: "Close-up of the micromouse robot's circuit board under a microscope: gold solder pads and green traces",
  },
};
