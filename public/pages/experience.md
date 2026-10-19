# Experience

## **Software Engineer Intern, Onboard Systems** @ [Hitachi Rail](https://www.hitachirail.com/) _(June 2026 - Aug 2026)_
Woodbury, NY
- Built and unit-tested GTFS-Realtime (Protobuf) and TAIP (UDP) adapters in C#/.NET to bring bus GPS into dispatch; validated on MBTA's live feed, 500+ buses at once, ahead of a planned LA Metro rollout
- Extended a C++ dispatch server's TCP protocol to v3, adding agency names to its messages so one server can route multiple agencies; built security-reviewed ASP.NET/JavaScript web forms for operators to add feeds
- Pitched computer-vision tracking to the CTO so depots can locate buses cheaply in real time; led its 13-intern team, fine-tuned PyTorch YOLOv8, built 2-stage OCR and homography; demo verified all 15 fleet-ID reads

**Technologies:** C++, C#, .NET, PyTorch, OpenCV

&nbsp;

## **Software Engineer (Part-Time)** @ [Cloud Data Pro](https://www.clouddatapro.com/) _(Jan 2026 - Present)_
Remote
- Rebuilt a nonprofit's 2017 WordPress site as a custom block theme so it loads fast: home page 2.9 MB to 616 KB (pre-launch). Wrote a PHP importer migrating 386 items and CI that checks all 550 old links still resolve
- Built a PHP endpoint so HMAC-verified Zeffy webhooks keep fundraiser totals from going stale, no hand edits

**Technologies:** PHP, WordPress, TypeScript, Playwright

&nbsp;

## **Software Engineer Intern, CleverCAD** @ [Clever Devices](https://www.cleverdevices.com/) _(June 2025 - Aug 2025)_
Woodbury, NY
- Debugged and fixed a REST API bug where clearing a vehicle attribute reported success but saved nothing; the data layer now clears empty values and skips omitted fields, so clears persist; shipped on 4 release lines
- Wrote a multithreaded Python fuzzer, run in Docker, sending Gemini-generated payloads to the Fleet Manager REST API; found 3 unhandled exceptions, including an API crash on a long malformed request
- Ended a production outage: traced a logged SQL error to a byte order mark and removed it in a tested hotfix

**Technologies:** Python, REST APIs, Docker, SQL
