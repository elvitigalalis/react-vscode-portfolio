# Experience

## **Software Engineer Intern, Onboard Systems** @ [Hitachi Rail](https://www.hitachirail.com/) _(June 2026 - Aug 2026)_
Built onboard and dispatch integrations for transit bus telemetry.
- Built GTFS-Realtime (Protobuf/HTTP) and TAIP (UDP) adapters in C#/.NET 10, feeding multi-agency bus telemetry into Hitachi's CAD dispatch; validated on MBTA's live feed ahead of a planned LA Metro rollout
- Extended the C++ gateway's TCP protocol to v3 to relay agency names to dispatch; fixed byte-alignment bugs
- Architected and led a 13-intern depot bus tracker (YOLOv8-OBB, 2-stage OCR, homography) at 30 FPS on CPU with sub-second detection; verified all 15 fleet IDs and sent 4,009 updates in 4 min to SmartYard
- Fixed a production LockRecursionException in SmartYard's C# by narrowing ReaderWriterLockSlim scope
- Merged 10 PRs (65 commits, 40+ story points) through senior review; rated at Associate Engineer level

**Technologies:** C#, .NET 10, C++, GTFS-Realtime, Protobuf, TAIP, UDP/TCP, YOLOv8-OBB, OCR

&nbsp;

## **Software Engineer Intern** @ [Clever Devices](https://www.cleverdevices.com/) (acquired by Hitachi Rail) _(June 2025 - Aug 2025)_
Built testing and tracking tools for transit vehicle systems.
- Built a multithreaded Python fuzzer firing synthetic POST payloads at a fault-tolerant vehicle REST API, uncovering unhandled exceptions; containerized the tool with Docker and charted each fuzzing run in Splunk
- Built a real-time C# tracker service on the transit server that detects buses entering and leaving their depots

**Technologies:** Python, C#, Docker, Splunk, REST APIs

&nbsp;

## **Software Engineer Intern** @ [Cloud Data Pro](https://www.clouddatapro.com/) _(June 2024 - Aug 2024)_
Production database fixes and DevOps.
- Ended a production outage by writing and deploying a SQL hotfix for the broken stored procedure behind it
- Built a CI/CD pipeline on Azure deploying Docker images from Artifactory to Kubernetes with JWT auth

**Technologies:** SQL, Azure, Docker, Artifactory, Kubernetes, JWT
