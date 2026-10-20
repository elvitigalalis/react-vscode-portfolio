// The site's origin, the résumé PDF's public path and the analytics IDs, shared by the Astro
// config, the site config, the gates in check/ and the tests. The PDF keeps the path past résumés link to.
export const ORIGIN = "https://www.lisul-elvi.com";
export const RESUME_PDF = "/Lisul_Elvitigala_resume.pdf";
// Public measurement IDs (they ship in every page): Google Analytics 4, Microsoft Clarity and the
// Google Search Console HTML-tag token. An empty value leaves that tool out.
export const ANALYTICS = { gaId: "", clarityId: "", searchConsole: "" };
