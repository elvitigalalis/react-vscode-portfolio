# Projects

## [Autonomous Micromouse Robot](https://github.com/IEEE-StonyBrook/Jurababa_2025-2026)
**Role:** Team Captain

Captained a 13-member team for 2 seasons: 2nd of 15+ at MIT, 1st in Best Design, and 2nd at NYIT (38s run). Built a double-buffered sensor hub across the Pico's 2 cores (lock-free reads, mutex on publish) for 100 Hz PID, and flood fill and A* with 45-degree diagonals and trapezoidal motion profiles; wrote 110 of 121 commits. Compiled the robot's C++ navigation code into a host simulator to rehearse all 3 competition run phases.

**Tech:** C++, Raspberry Pi Pico (RP2040), PID, CMake

&nbsp;

## [WorkIt](https://github.com/WorkIt-CSE-416/WorkIt-CSE416)
**Role:** 5-Person Team

Built a robots.txt-compliant Python scraper reading 1,800 company boards (Greenhouse, Lever, Ashby) into 1,000+ roles, cutting runtime from 9.5 to 3 min with one lane per provider and quiet boards read every 3rd run. Made the 6-hourly import one Postgres transaction that refuses an empty feed or closing over half the jobs. Shipped Scout, a FastAPI + Gemini assistant grounded only in a user's parsed resume and the job posting.

**Tech:** Python, FastAPI, Next.js, Supabase Postgres, GitHub Actions, Gemini
