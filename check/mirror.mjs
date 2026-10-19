// Mirror gate: every resume.json fact is on the home page word for word, every project's
// bullets are in its write-up's "At a glance" box, and the phone number is nowhere.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { files, squash, textOf } from "./lib.mjs";

export async function mirror({ dist, resume }) {
  const problems = [];
  const { basics, education, experience, projects, skills } = resume;

  const home = textOf(readFileSync(join(dist, "index.html"), "utf8"));
  const facts = [
    basics.name, basics.citizenship, basics.email,
    ...basics.links.map((l) => l.label),
    ...education.flatMap((e) => [e.school, e.degree, e.honorific, e.date, e.gpa, ...e.items]),
    ...experience.flatMap((e) => [e.company, e.title, e.team, e.dates, e.location, ...e.stack, ...e.bullets]),
    ...projects.flatMap((p) => [p.title, p.role, p.dates, ...p.stack, ...p.bullets]),
    ...skills.languages, ...skills.frameworks, ...skills.tools,
  ].filter(Boolean);
  for (const f of facts) if (!home.includes(squash(f))) problems.push(`index.html: missing résumé text "${f}"`);

  // Write-ups exist only once their markdown lands; until then there is nothing to check.
  for (const p of projects) {
    const file = `projects/${p.slug}/index.html`;
    if (!existsSync(join(dist, file))) continue;
    const html = readFileSync(join(dist, file), "utf8");
    const box = /<(h[2-6])\b[^>]*>\s*At a glance\s*<\/\1>([\s\S]*?)(?=<h[1-6]\b|<\/main>|$)/i.exec(html);
    if (!box) { problems.push(`${file}: no "At a glance" heading`); continue; }
    const text = textOf(box[2]);
    for (const b of p.bullets) if (!text.includes(squash(b))) problems.push(`${file}: At a glance is missing "${b}"`);
  }

  const digits = basics.phone.replace(/\D/g, "");
  for (const file of files(dist, /\.(html|css|js|xml|txt|json|webmanifest)$/)) {
    const body = readFileSync(join(dist, file), "utf8");
    if (body.includes(basics.phone) || body.replace(/\D/g, "").includes(digits) || /href="tel:/.test(body))
      problems.push(`${file}: shows the phone number`);
  }
  return problems;
}
