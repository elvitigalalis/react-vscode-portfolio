---
# The home page's expand layer: hand-written text around the résumé facts.
# Résumé facts themselves (roles, dates, bullets, skills) come only from src/data/resume.json.
# Standing rules: no offer tag, no "acquired by" or "formerly", no commit counts,
# never merge the MIT 2025 and NYIT 2026 robots, no LA Metro deployment claim.
kicker: Software Engineer · Stony Brook CS
thesis: >-
  I was a software engineer intern at Hitachi Rail in 2026, bringing live bus GPS into dispatch.
  I also wrote the C++ firmware for Stony Brook's micromouse robot.
location: Stony Brook, NY
# The first line of the hero's facts: what Lisul is looking for.
open: Summer 2027 software engineering internships

# At most one context sentence per role, keyed by company.
roles:
  Hitachi Rail: >-
    On the Onboard Systems team, I connected live bus GPS feeds to a dispatch server and led
    an intern project on reading bus fleet IDs with computer vision.
  Cloud Data Pro: >-
    Part-time web engineering for a nonprofit: a faster rebuild of its WordPress site and
    fundraiser totals that update themselves.
  Clever Devices: >-
    On the CleverCAD team, I fixed and fuzz-tested a fleet-management REST API and ended a
    production outage.

# Card summary per project, keyed by resume.json slug. A project with a write-up keeps its card
# photo and demo in the write-up's front matter; one without a write-up may set `photo` and
# `demo` here instead.
projects:
  micromouse:
    summary: >-
      A small robot that maps an unknown maze and races to its centre. I captain Stony Brook's
      IEEE team and wrote the 2026 robot's firmware.
  workit:
    summary: >-
      A job board for internship and new-grad roles. I built the scraper that finds them and
      scheduled its import into the database.

# Where each number above comes from, when resume.json does not print it.
sources:
  - "Lisul, first-hand (October 2026): looking for Summer 2027 software engineering internships."
---
