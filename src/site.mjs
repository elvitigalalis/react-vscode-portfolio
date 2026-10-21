// The site's origin, the résumé PDF's public path and the analytics IDs, shared by the Astro
// config, the site config, the gates in check/ and the tests. The PDF keeps the path past résumés link to.
export const ORIGIN = "https://www.lisul-elvi.com";
export const RESUME_PDF = "/Lisul_Elvitigala_resume.pdf";
// Public measurement IDs (they ship in every page): Google Analytics 4, Microsoft Clarity and the
// Google Search Console HTML-tag token. An empty value leaves that tool out.
export const ANALYTICS = { gaId: "G-GZL50J9S6H", clarityId: "z0obqzvnio", searchConsole: "Q-LBnoOM2fquFH12htvZG_mV-x3av209najAr_aX9Tc" };
// The Sheet (docs/sheet.md): the Supabase project's URL and anon (or publishable) key are public by design; row-level
// security guards the data. An empty supabaseUrl shows /plan and /now as "not set up yet".
// Tasks are public unless marked !p; the planner's day ends at shutdownAt.
export const SHEET = {
  supabaseUrl: "https://bmbsvvprpfdbvalnkowp.supabase.co",
  anonKey: "sb_publishable_rI6d8FYv4qx85t3YDEZhAg_MhxRZAm6",
  timeZone: "America/New_York",
  capacityMin: 330,
  shutdownAt: "17:00",
  // The part of each day counted as free time for tasks, around his calendar events.
  dayStartAt: "09:30",
  dayEndAt: "22:00",
};
