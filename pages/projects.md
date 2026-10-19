# Projects

## [Micromouse Maze-Solving Robot](https://github.com/IEEE-StonyBrook/Jurababa_2025-2026/tree/NEW_ROBOT) _(Aug 2024 - Present)_
**IEEE Stony Brook** | Team Captain

- Wrote the 2026 robot's C++ firmware on open-source UKMARS (ToF sensing, A* routing) that ran 2nd at NYIT 2026 (38 s); simulator-tested each algorithm, incl. a state machine shortening A* zigzags into diagonals
- Traced turn overshoot to ~40 ms IMU yaw latency; encoder-yaw PD cut worst-case spin error 2.75° to 1.01°
- Captain 3 seasons, giving each member a component to own with deadlines set at weekly builds: 2nd of 15+ and Best Design at MIT 2025, 2nd at NYIT 2026; in Fall 2026, picked 13 of 101 applicants after 20 interviews

**Tech:** C/C++, Raspberry Pi Pico, CMake

&nbsp;

## [WorkIt](https://github.com/WorkIt-CSE-416/WorkIt-CSE416): Early-Career Job Aggregator _(Aug 2026 - Present)_

- Built a Python scraper filtering 1,800 boards (Greenhouse, Lever, Ashby) to 1,000+ internship and new-grad roles; cut routine runs 9.5 to 3 min via per-provider thread pools, rechecking no-match boards every 3rd run
- Scheduled the scrape-to-PostgreSQL import in GitHub Actions; its dry run on import-changing PRs caught a database schema mismatch before merge; added a CI test-and-lint job (145 of 252 scraper tests mine)

**Tech:** Python, PostgreSQL, GitHub Actions
