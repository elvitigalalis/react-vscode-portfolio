---
# Standing rules: no commit counts; credit only Lisul's work (the import script, its transaction
# and its guards are Xiang Liu's; Brian Cao created the Supabase project); name teammates for
# theirs; WorkIt issues and PRs in plain text only ("WorkIt PR 116"), never a link or #-reference.
# Every number below the front matter traces to resume.json or to a line in `sources:`.
description: >-
  How I built WorkIt's job scraper and its scheduled database import: a lane per job-board
  provider that cut routine runs from 9.5 to about 3 minutes, a dry run on pull requests that
  caught a schema mismatch, and work-style inference right 87% of the time against a 70% baseline.
summary: >-
  I built the Python scraper behind WorkIt, a five-person team's job board for internship and
  new-grad roles, and the GitHub Actions workflow that imports its results into PostgreSQL.
  Routine runs fell from 9.5 to about 3 minutes with every site paced as before, and the
  workflow's dry run on pull requests caught a database schema mismatch before it merged.
sources:
  - "Résumé one-pager (resume.json): the scraper over 1,800 boards (Greenhouse, Lever, Ashby) keeping 1,000+ internship and new-grad roles; routine runs 9.5 to 3 min; the scheduled scrape-to-PostgreSQL import, its dry run on pull requests that caught a schema mismatch, the CI test-and-lint job, 145 of the 252 scraper tests."
  - "Public WorkIt repository, the scraper's first pull request (WorkIt PR 48, merged 5 October 2026): about 1,800 companies on Greenhouse, Lever and Ashby, about 1,000 roles, robots.txt obeyed and stayed away from when unreadable, every site paced, the scraper's test-and-lint job in CI."
  - "Lisul's speed change (commit 66ce154, WorkIt PR 80, merged 8 October 2026): a run took 9.5 minutes, 5.5 of them Lever's one-second crawl delay over 333 boards; every board had shared 8 workers; one lane per provider with the same pacing; quiet boards (282 of the 333 on Lever) read on 1 run in 3, staggered, and at least every 3 days, so a first posting there can appear 2 days late; 9.5 to about 3 minutes; speed never from less pacing."
  - "Same commit and pull request, work style: the order (stated, then the company's other postings, then On site for a posting that names a place); measured on 250 postings whose board states a style but whose text does not, 87% right against 70% for always On site, the misses hybrid jobs; a bare 'hybrid' wrong 38 times in 89; a filled card judged worth the misses; on that day's 1,096 jobs, 997 with a work style. WorkIt PR 80's rollout was rehearsed on a throwaway local Postgres."
  - "Lisul's scheduled workflow (commit fc73181, WorkIt PR 81, merged 8 October 2026): scrape then import every 6 hours at :17 UTC, runs never overlapping, and any pull request touching the scraper, the import, its schema or the workflow running the whole path with the import as a dry run, so it is proven before it merges. Andrew Shi later moved the schedule to every 3 hours."
  - "GitHub Actions history of the WorkIt repository: on 14 October 2026 the dry run on Lisul's resume-builder pull request (WorkIt PR 116) failed after 4 min 39 s with 'column job_postings.keywords does not exist'; the next run passed, and the pull request merged on 16 October 2026. WorkIt's main branch has no required status checks."
  - "Contribution audit of the WorkIt repository (October 2026): Xiang Liu wrote the import script with its single transaction, its guards and its dry-run mode, plus the schema, migrations, Supabase sign-in and row-level security; Brian Cao created the Supabase project; Vedant Vyas added Google and LinkedIn sign-in; Andrew Shi wrote most of the web app and added role categories and more job-board providers to the scraper. Lisul's: the scraper, the scheduled workflow and its dry run, the Vercel deployment, the profile schema design, and Scout with its 19 tests and grounding rules."
  - "Lisul, first-hand (October 2026): WorkIt is Lisul and 4 teammates, a team of 5 in CSE 416; Scout's only users so far are the 4 teammates; more of his work is on branches not yet merged."
  - "Charts: drawn to scale from the numbers above, run time on an axis from 0 to 10 minutes marked every 2 (0, 2, 4, 6, 8, 10), accuracy on an axis from 0 to 100% marked at 50."
---

## The problem

Internship and new-grad postings live on each company's own careers page, most of them on a few hiring systems: Greenhouse, Lever and Ashby. WorkIt, built by a team of 5 in CSE 416, is a job board for early-career roles. Its jobs come from a scraper that reads those boards directly, keeps the early-career software roles, and fills in the facts a job card shows.

Two constraints shaped the work. The scraper must be polite: it obeys each site's robots.txt, stays away when it can't read one, and paces every site. And the database is shared with the whole app, so an import that writes bad rows breaks the site for everyone.

## How it works

The scraper reads about 1,800 company boards and keeps 1,000+ roles. A scheduled GitHub Actions workflow runs it, then imports the result into PostgreSQL on Supabase:

<figure>
<svg class="fig-svg" role="img" aria-labelledby="fig-pipe-t" viewBox="0 0 400 470" width="400" height="470">
<title id="fig-pipe-t">Pipeline: job boards feed the scraper, which fills in card facts; a scheduled workflow imports them into PostgreSQL on Supabase for the web app, and a pull request runs the same path as a dry run.</title>
<defs><marker id="arr-w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fill-fg"/></marker></defs>
<rect x="10" y="10" width="250" height="56" rx="6" class="box"/>
<text x="135" y="34" text-anchor="middle" class="strong">Job boards</text>
<text x="135" y="54" text-anchor="middle">Greenhouse, Lever, Ashby</text>
<line x1="135" y1="66" x2="135" y2="96" class="wire" marker-end="url(#arr-w)"/>
<rect x="10" y="100" width="250" height="56" rx="6" class="box accent"/>
<text x="135" y="124" text-anchor="middle" class="strong">Scraper (mine)</text>
<text x="135" y="144" text-anchor="middle">a lane per provider, polite pacing</text>
<line x1="135" y1="156" x2="135" y2="186" class="wire" marker-end="url(#arr-w)"/>
<rect x="10" y="190" width="250" height="56" rx="6" class="box accent"/>
<text x="135" y="214" text-anchor="middle" class="strong">Card facts (mine)</text>
<text x="135" y="234" text-anchor="middle">pay, job type, work style</text>
<line x1="135" y1="246" x2="135" y2="276" class="wire" marker-end="url(#arr-w)"/>
<rect x="10" y="280" width="250" height="56" rx="6" class="box"/>
<text x="135" y="304" text-anchor="middle" class="strong">Import (Xiang Liu's script)</text>
<text x="135" y="324" text-anchor="middle">run on a schedule in Actions (mine)</text>
<line x1="135" y1="336" x2="135" y2="366" class="wire" marker-end="url(#arr-w)"/>
<rect x="10" y="370" width="250" height="40" rx="6" class="box"/>
<text x="135" y="395" text-anchor="middle" class="strong">PostgreSQL on Supabase</text>
<line x1="135" y1="410" x2="135" y2="426" class="wire" marker-end="url(#arr-w)"/>
<rect x="10" y="430" width="250" height="34" rx="6" class="box"/>
<text x="135" y="452" text-anchor="middle">Web app (the team)</text>
<line x1="260" y1="308" x2="276" y2="308" class="wire" stroke-dasharray="4 3"/>
<rect x="278" y="268" width="114" height="80" rx="6" class="box accent"/>
<text x="335" y="290" text-anchor="middle" class="strong">On a PR (mine)</text>
<text x="335" y="310" text-anchor="middle">the same path,</text>
<text x="335" y="328" text-anchor="middle">import as dry run</text>
</svg>
<figcaption>What I built is outlined in the accent colour: the scraper, its card facts, the schedule and the pull-request dry run. The import script and the schema are Xiang Liu's.</figcaption>
</figure>

## Giving each job-board provider its own lane

A run took 9.5 minutes. Lever's one-second crawl delay over its 333 boards came to 5.5 of them. Every board shared 8 workers, so a worker waiting out Lever was a worker not reading Greenhouse.

Speed must never come from less pacing, so I made two other changes. Each provider now runs in its own lane, a thread pool with its own workers and the same per-site pacing, so no server sees more traffic than before. And quiet boards rest: a board that has never had a posting we keep, which was 282 of the 333 on Lever, is read on 1 run in 3, staggered across runs, and at least once every 3 days. A `--full` run still reads every board.

<figure>
<svg class="fig-svg" role="img" aria-labelledby="fig-run-t" viewBox="0 0 400 180" width="400" height="180">
<title id="fig-run-t">Routine run time: 9.5 minutes before, 5.5 of them Lever's crawl delay; about 3 minutes after.</title>
<text x="40" y="28" class="strong">Before: 9.5 min</text>
<rect x="40" y="38" width="304" height="22" rx="3" class="bar"/>
<line x1="216" y1="34" x2="216" y2="64" class="grid"/>
<text x="40" y="80">5.5 min of Lever's delay</text>
<text x="40" y="110" class="strong">After: about 3 min</text>
<rect x="40" y="120" width="96" height="22" rx="3" class="bar accent"/>
<line x1="40" y1="152" x2="360" y2="152" class="wire"/>
<text x="40" y="172" text-anchor="middle">0</text>
<text x="104" y="172" text-anchor="middle">2</text>
<text x="168" y="172" text-anchor="middle">4</text>
<text x="232" y="172" text-anchor="middle">6</text>
<text x="296" y="172" text-anchor="middle">8</text>
<text x="360" y="172" text-anchor="middle">10 min</text>
</svg>
<figcaption>A routine run before and after, drawn to scale; the mark on the old run ends Lever's share of it.</figcaption>
</figure>

Routine runs went from 9.5 to about 3 minutes. The cost is freshness: a company's first posting on a quiet board can appear up to 2 days late. <mark class="todo">TODO(Lisul): how the 9.5 and 3 minutes were timed (one run or several, on your machine or in Actions), and whether you weighed adding workers before splitting lanes.</mark>

## A dry run of the import on every pull request that touches it

The workflow I wrote scrapes and then imports on a schedule, every 6 hours at first; Andrew Shi later moved it to every 3. The import script is Xiang Liu's: it runs in one transaction, refuses an empty feed or closing more than half the jobs at once, and has a dry-run mode that writes nothing. Those guards stop a bad scrape at run time, after the change behind it has merged.

I wanted the failure before the merge. Any pull request that changes the scraper, the import, its schema or the workflow now runs the whole path in Actions, real scrape included, with the import forced to a dry run against the live database. <mark class="todo">TODO(Lisul): what else you weighed, such as the throwaway local Postgres that WorkIt PR 80's rollout was rehearsed on, and why the live database won.</mark>

It earned its place on 14 October 2026. My own resume-builder change, WorkIt PR 116, failed its dry run with "column job_postings.keywords does not exist": the code expected a column the database lacked. The next run passed, and the change merged 2 days later. <mark class="todo">TODO(Lisul): what the fix between the two runs was.</mark>

The cost: every such pull request waits for a full scrape (the failing run took 4 min 39 s), and nothing forces anyone to wait, because WorkIt's main branch has no required checks.

## Inferring work style when a posting doesn't say

A job card shows a work style: on site, hybrid or remote. Many postings never state one ("San Jose, CA", no more), so the card could say "not listed" or guess.

I chose to infer, in order: what the posting states, from its board's field or a sentence in the text; then what the company's other postings state most often; then "On site" for a posting that names a place and never mentions remote, hybrid or working from home. Only specific hybrid wording counts as stated, because a bare "hybrid" was wrong 38 times in 89 ("hybrid cloud").

To measure it, I used 250 postings whose board states a work style but whose text does not, so the board's label could be checked against the inference:

<figure>
<svg class="fig-svg" role="img" aria-labelledby="fig-style-t" viewBox="0 0 400 170" width="400" height="170">
<title id="fig-style-t">Work style right on 250 labelled postings: the inference order 87%, always guessing On site 70%.</title>
<text x="40" y="28" class="strong">Inference order: 87%</text>
<rect x="40" y="38" width="278.4" height="22" rx="3" class="bar accent"/>
<text x="40" y="90" class="strong">Always "On site": 70%</text>
<rect x="40" y="100" width="224" height="22" rx="3" class="bar"/>
<line x1="40" y1="140" x2="360" y2="140" class="wire"/>
<text x="40" y="160" text-anchor="middle">0</text>
<text x="200" y="160" text-anchor="middle">50</text>
<text x="360" y="160" text-anchor="middle">100%</text>
</svg>
<figcaption>Share of 250 labelled postings whose work style each method got right, drawn to scale.</figcaption>
</figure>

The order was right 87% of the time, against 70% for always guessing "On site". On that day's 1,096 jobs, 997 cards got a work style. The cost is the misses, which are hybrid jobs shown as on site; a filled card was judged worth them. <mark class="todo">TODO(Lisul): how the 250 postings were picked, and why a filled card beat "not listed" for applicants.</mark>

## Result

- **Speed:** routine runs 9.5 → about 3 minutes, with every site paced as before.
- **Safety:** the pull-request dry run caught a schema mismatch before it merged.
- **Coverage:** a work style on 997 of 1,096 cards, 87% right against 70%.
- **Tests:** I wrote 145 of the scraper's 252 tests and added its test-and-lint job to CI on every pull request.

## What's still unproven

- **CI informs; it doesn't gate.** Branch protection is off, so the test-and-lint job and the dry run can fail without blocking a merge.
- **The 87% was measured where the answer is known.** Postings whose board states nothing may behave differently, and nothing measures them.
- **The speed figure predates newer providers.** Andrew has since added more job-board providers to the scraper; the 9.5 to 3 minutes covers Greenhouse, Lever and Ashby.
- **Scout is untested on facts.** Scout, my assistant that answers from one posting and the user's resume, has grounding rules and 19 tests but no measure of how often it makes things up; its only users so far are the 4 teammates.
- **Some of my work hasn't merged** and sits on branches.

## Who did what

I wrote the scraper with its tests and CI job, the card facts, the scheduled workflow and its dry run, the Vercel deployment, the profile schema design, and Scout. Xiang Liu wrote the import script with its transaction and guards, the database schema and migrations, Supabase sign-in and row-level security. Brian Cao created the Supabase project. Vedant Vyas added Google and LinkedIn sign-in. Andrew Shi built most of the web app, added role categories and providers to the scraper, and moved the schedule to every 3 hours.
