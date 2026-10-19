// Site-wide settings that are not résumé facts.
export const siteConfig = {
  url: "https://www.lisul-elvi.com",
  title: "Lisul Elvitigala",
  description:
    "Lisul Elvitigala, software engineer and Stony Brook computer science student: projects, experience, education and skills, with the résumé PDF.",
  // The PDF keeps the path past résumés link to.
  resumePdf: "/Lisul_Elvitigala_resume.pdf",
  // The link-preview image: 1200×630, no text in it (Apple and LinkedIn crop or reject otherwise).
  ogImage: {
    src: "/og.jpg",
    width: 1200,
    height: 630,
    alt: "Close-up of the micromouse robot's circuit board under a microscope: gold solder pads and green traces",
  },
};
