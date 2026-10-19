---
# Standing rules: no commit counts; A* is the planner (no credit to flood fill); no result or
# placing at Montclair (the mouse broke that morning); never merge the MIT 2025 and NYIT 2026
# robots; "I" only for Lisul's own work, teammates named for theirs.
# Every number below the front matter traces to resume.json or to a line in `sources:`.
description: >-
  How I wrote the firmware for Stony Brook's 2026 micromouse robot: a 500 Hz controller on the
  open-source UKMARS architecture, encoder-fed turns that cut spin error from 2.75° to 1.01°,
  and controller gains computed from measured motor data.
summary: >-
  I wrote the C++ firmware for Stony Brook's 2026 micromouse robot, adapting the open-source
  UKMARS architecture to our Pi Pico robot, and it ran 2nd at NYIT 2026 with a 38 s run. The
  largest accuracy fix was feeding encoder yaw, not IMU yaw, to the turn controller: worst-case
  spin error fell from 2.75° to 1.01°.
sources:
  - "Résumé one-pager (resume.json): the 2026 firmware on UKMARS with A* routing, 2nd at NYIT 2026 (38 s), the ∼40 ms IMU yaw latency, worst-case spin error 2.75° to 1.01°, captain for 3 seasons."
  - "Public firmware repository, NEW_ROBOT branch: the 500 Hz hardware-timer control loop, the 29.86:1 gear ratio, the BNO085 IMU, A* called on every search and fast run, the diagonalizer, the UKMARS parity checklist, DriverLab."
  - "Lisul's 2026 tuning log (firmware history, measurements in the change notes): IMU yaw about 40 ms late and turns overshooting by about 5°; spin error −2.75…+0.44° before and −1.01…+0.27° after encoder yaw; per-90° spread ±2.5° to ±1.1°; smooth-turn arc error −1.8° to −0.8°; a Td sweep settling on 1.5 Tm because 1.0 Tm caused stick-slip."
  - "DriverLab records: Td = Tm instead of motorlab's Tm/2, because the 29.86:1 gearing makes the plant about 4× snappier than UKMARSBOT; rotation plant on the maze floor Km 385°/s/V over 8 fits (361 to 407), Tm 0.097 s."
  - "Bench-maze smooth-turn run: all 21 segments (10 arcs, 4 one-cell S-bends) at up to about 1,200 mm/s, final yaw error 1.35°, goal moved to a 4×4 centre block; not a competition run."
  - "Diagonalizer: a state machine over 11 movement-block states that turns A*'s path into 45° turns and half-cell moves; simulator only."
  - "Reliability tooling: battery warning below 6.4 V on 2S, thresholds still estimates."
  - "Lisul, first-hand (October 2026): the team's make-up and his role as captain, the earlier code's stop-and-spin turns, the 2023-2024 code's P-only IMU turns and its own A*, diagonals waiting for a slimmer chassis, and the Montclair 2026 morning failure; the clip was filmed by Manasa."
  - "Spin-error chart: drawn to scale from the tuning log above, on an axis from −3° to +1° with 0° marked."
---

## The problem

A micromouse is a small autonomous robot that explores an unknown maze, then races from the start to the centre. Speed comes from turning well: a robot that stops, spins and straightens at every corner loses time, and one that turns a degree or two wrong drifts into walls a few cells later.

The code the team had before my rewrite turned that way. It stopped, spun in place under a proportional-only controller on IMU yaw, and its turns were inaccurate. The 2026 robot is a Raspberry Pi Pico with 29.86:1 gearing, time-of-flight wall sensors, wheel encoders and a BNO085 IMU. My job was the firmware: everything between those sensors and the motors.

## How it works

The firmware runs on one core, driven by a 500 Hz hardware timer. Each tick reads the sensors, updates the robot's position, and runs the speed and turn controllers:

<figure>
<svg class="fig-svg" role="img" aria-labelledby="fig-loop-t" viewBox="0 0 400 400" width="400" height="400">
<title id="fig-loop-t">Block diagram: A* plans a path of cells, motion profiles turn it into straights and turns, and a 500 Hz controller drives the motors from sensor feedback.</title>
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fill-fg"/></marker></defs>
<rect x="10" y="10" width="250" height="56" rx="6" class="box"/>
<text x="135" y="34" text-anchor="middle" class="strong">Planner: A* on the maze map</text>
<text x="135" y="54" text-anchor="middle">picks the next cells to drive</text>
<line x1="135" y1="66" x2="135" y2="106" class="wire" marker-end="url(#arr)"/>
<rect x="10" y="110" width="250" height="56" rx="6" class="box"/>
<text x="135" y="134" text-anchor="middle" class="strong">Moves</text>
<text x="135" y="154" text-anchor="middle">straights, smooth turns, spins</text>
<line x1="135" y1="166" x2="135" y2="206" class="wire" marker-end="url(#arr)"/>
<rect x="10" y="210" width="250" height="76" rx="6" class="box accent"/>
<text x="135" y="234" text-anchor="middle" class="strong">Controller, 500 Hz timer</text>
<text x="135" y="254" text-anchor="middle">speed and turn PD</text>
<text x="135" y="274" text-anchor="middle">with feedforward</text>
<line x1="135" y1="286" x2="135" y2="326" class="wire" marker-end="url(#arr)"/>
<rect x="10" y="330" width="250" height="56" rx="6" class="box"/>
<text x="135" y="354" text-anchor="middle" class="strong">Motors</text>
<text x="135" y="374" text-anchor="middle">29.86:1 gearing</text>
<rect x="290" y="110" width="100" height="276" rx="6" class="box"/>
<text x="340" y="134" text-anchor="middle" class="strong">Sensors</text>
<text x="340" y="164" text-anchor="middle">wheel</text>
<text x="340" y="182" text-anchor="middle">encoders</text>
<text x="340" y="212" text-anchor="middle">ToF wall</text>
<text x="340" y="230" text-anchor="middle">sensors</text>
<text x="340" y="260" text-anchor="middle">IMU</text>
<line x1="290" y1="248" x2="264" y2="248" class="wire" marker-end="url(#arr)"/>
<path d="M340,110 L340,38 L264,38" class="wire" marker-end="url(#arr)"/>
</svg>
<figcaption>Sensor feedback closes the loop at 500 Hz; the wall readings also update the map that A* plans on.</figcaption>
</figure>

The structure, the motion profiles and the controller formulas come from UKMARS mazerunner-core, an open-source micromouse codebase. On top of that I wrote the parts that make it this robot: the A* planner, the wall-sensor calibration, the turn feedback, a motor-measurement mode called DriverLab, and a Bluetooth console for tuning without reflashing. Every algorithm runs in a maze simulator before it runs on the robot. The team's older code also planned with A*; I kept the algorithm and wrote a new implementation.

## Feeding encoder yaw, not IMU yaw, to the turn controller

The constraint: the BNO085 reports yaw about 40 ms late. During an arc the rotation controller chased that stale angle, reversed the inside wheel and overshot by about 5°.

The wheel encoders have no such delay: the controller reads them every tick. <mark class="todo">TODO(Lisul): which other fixes you weighed before choosing encoder yaw, and why they lost.</mark>

I fed encoder yaw to the rotation controller and measured the plant again. Worst-case spin error went from −2.75…+0.44° to −1.01…+0.27°, the spread per 90° turn from ±2.5° to ±1.1°, and smooth-turn arc error from −1.8° to −0.8°. <mark class="todo">TODO(Lisul): how many spins these ranges cover, and how the final angle was measured.</mark>

<figure>
<svg class="fig-svg" role="img" aria-labelledby="fig-spin-t" viewBox="0 0 400 190" width="400" height="190">
<title id="fig-spin-t">Spin error range: IMU yaw from −2.75° to +0.44°; encoder yaw from −1.01° to +0.27°.</title>
<line x1="280" y1="20" x2="280" y2="150" class="grid"/>
<text x="40" y="30" class="strong">IMU yaw (before)</text>
<rect x="60" y="40" width="255.2" height="22" rx="3" class="bar"/>
<text x="56" y="56" text-anchor="end">−2.75°</text>
<text x="319" y="56">+0.44°</text>
<text x="40" y="94" class="strong">Encoder yaw (after)</text>
<rect x="199.2" y="104" width="102.4" height="22" rx="3" class="bar accent"/>
<text x="195" y="120" text-anchor="end">−1.01°</text>
<text x="305" y="120">+0.27°</text>
<line x1="40" y1="150" x2="360" y2="150" class="wire"/>
<text x="40" y="172" text-anchor="middle">−3°</text>
<text x="120" y="172" text-anchor="middle">−2°</text>
<text x="200" y="172" text-anchor="middle">−1°</text>
<text x="280" y="172" text-anchor="middle">0°</text>
<text x="360" y="172" text-anchor="middle">+1°</text>
</svg>
<figcaption>Worst-case spin error, drawn to scale: the encoder-yaw range is less than half as wide as the IMU-yaw range.</figcaption>
</figure>

The cost: with a derivative time of 1.0 Tm, the value DriverLab had set (below), the slow inside wheel went into stick-slip, so I swept it and settled on 1.5 Tm. <mark class="todo">TODO(Lisul): what encoder yaw gives up compared with the IMU, and whether the IMU still has a job.</mark>

## Measuring the motor instead of hand-tuning gains

Controller gains can be guessed and adjusted run by run, or computed from a model of the motor. I built DriverLab, a mode that runs trials on the robot: an open-loop voltage sweep fits the motor gain Km, and a step response fits the time constant Tm. It computes the PD gains by pole placement, using the formula from UKMARS's motorlab, and exports them as constants for the run firmware.

One choice was mine: I set the derivative time Td equal to Tm, not motorlab's Tm/2, because our 29.86:1 gearing makes the plant about 4× snappier than the UKMARSBOT the defaults were written for. On the maze floor the rotation plant measured Km = 385°/s/V over 8 fits (361 to 407) and Tm = 0.097 s.

<mark class="todo">TODO(Lisul): why you measured the motor rather than hand-tuning, and what the measuring costs you.</mark>

## Building on UKMARS instead of the old code or a blank slate

The old code's turns were inaccurate, and I replaced it rather than patch it. I adapted UKMARS's motion profiles, wall-following steering and odometry to our robot, which has a different processor, gearing and sensors, and kept a parity checklist in the repository of what follows UKMARS and what stays ours. <mark class="todo">TODO(Lisul): why UKMARS rather than a blank slate or another open micromouse codebase.</mark>

The cost is honesty about credit: the architecture is UKMARS's, not mine. What I can claim is the adaptation, the A* planner and the measurement and tuning work above.

## Result

- **Competition:** the 2026 firmware ran 2nd at NYIT 2026, with a 38 s run.
- **Turns:** worst-case spin error 2.75° → 1.01°, measured on the robot (above).
- **Speed, bench only:** with non-stop smooth turns, a fast run drove all 21 segments of a bench maze (10 arcs, 4 one-cell S-bends) at up to about 1,200 mm/s, ending 1.35° off heading. The goal was moved to a 4×4 centre block for that test, so it is not a competition time.
- **Not measured:** how much faster smooth turns make a competition run. There is no before-and-after time on a full maze yet.

## What's still unproven

- **Diagonals run only in the simulator.** I wrote a state machine over 11 movement patterns that turns A*'s zigzags into 45° turns and half-cell moves. The current robot is too wide to drive them; they wait for a slimmer chassis.
- **The speedup is unmeasured** (above).
- **Battery thresholds are estimates.** The low-battery warning fires below 6.4 V on a 2S pack, and that threshold is still a guess.
- **The mouse broke on competition morning at Montclair 2026.** An electrical fault stopped it, and the team went to the competition without a working robot. The clip above is from before that. <mark class="todo">TODO(Lisul): what the fault was, and what you would change in the firmware or the build so it can't end a competition again.</mark>

The team traced the fault on the repair bench under the inspection microscope:

<figure>
<img src="/images/micromouse/repair-bench.webp" width="960" height="720" loading="lazy" decoding="async" alt="A team member, seen from behind, bends over an inspection microscope at a repair bench; the board appears magnified on a monitor beside a multimeter, solder and tweezers.">
<figcaption>October 2026: diagnosing the electrical fault that broke the mouse on competition morning.</figcaption>
</figure>

On the monitor, the board's traces and parts:

<figure>
<img src="/images/micromouse/board-magnified.webp" width="960" height="680" loading="lazy" decoding="async" alt="A monitor showing the robot's circuit board magnified: copper traces, a small chip labelled U1, capacitors and connector pads, with flux residue around the chip.">
<figcaption>The board under the microscope during the diagnosis.</figcaption>
</figure>

## Who did what

I wrote and tested the 2026 firmware. Dennis Huang added the IMU setup code and speed plotting to DriverLab, and Felix Nie tuned the line follower. The team's electrical and mechanical members built the hardware; I helped with soldering and PCB design but did not do most of it. As captain I gave each member a component to own, with deadlines set at weekly builds. Placements belong to the team. Manasa filmed the run.
