---
# The home page's expand layer: hand-written text around the résumé facts.
# Résumé facts themselves (roles, dates, bullets, skills) come only from src/data/resume.json.
# Standing rules: no offer tag, no "acquired by" or "formerly", no commit counts,
# never merge the MIT 2025 and NYIT 2026 robots, no LA Metro deployment claim.
kicker: Software Engineer · Stony Brook CS
thesis: >-
  In 2026 I was a software engineer intern at Hitachi Rail, bringing live bus GPS into dispatch.
  I also wrote the firmware for Stony Brook's 2026 micromouse robot.
location: Stony Brook, NY

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

# Card text per project, keyed by resume.json slug.
projects:
  micromouse:
    summary: >-
      A small robot that maps an unknown maze and races to its centre. I captain Stony Brook's
      IEEE team and wrote the 2026 robot's firmware.
    photo:
      src: /images/micromouse.webp
      alt: Close-up of a micromouse circuit board under a microscope, its traces and solder pads magnified
  workit:
    summary: >-
      A job board for internship and new-grad roles. I built the scraper that finds them and
      scheduled its import into the database.
    photo:
      src: /images/workit.webp
      alt: WorkIt's landing page, with its headline and sign-up buttons above an illustrated city
    demo:
      url: https://workit-web-gamma.vercel.app
      label: Demo (in development, sign-in required)
---
