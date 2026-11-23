# The recorded clips: what was kept and what was found

Written by `node tools/anim/build.mjs`; do not edit by hand. Source: the CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu, free for all uses), boxing trials of subjects 13, 14, 15 and 17: one person shadow boxing, 120 frames a second. Nobody is hit and nobody falls.

**Every time here is measured by rule** from wrist speed, reach and the turn of hips and shoulders, not judged by eye. While the tools were written a few clips were looked at as stick figures (a jab, a cross, hooks, uppercuts, a body punch, a guard, a combination, a step) and looked like what they are called; no clip has been stepped through frame by frame, and nobody who boxes has seen them. `ClipViewer` (apps/web/src/box/motion) is the page for doing that. Frames are the recording's own (120 a second); the pack holds every second one.

How the times are measured:
- **contact**: greatest reach. For a straight punch that is the glove furthest toward the player. A hook or an uppercut lands with the arm bent and is furthest forward only after it has swung past, so for those it is the glove nearest to where that boxer's own straight punches land (his imagined opponent's head; 0.32 m lower for the body). This differs from the study, which measured reach as wrist-to-shoulder distance over arm length.
- **launch**: going back from the fist's fastest moment, the last frame it was under 1 m/s relative to the chest, or still drawing back.
- **first movement**: going back from the launch, where the hips (30°/s) or shoulders (40°/s) began to turn the punch's own way, or the hand to move (0.5 m/s). A boxer in his guard never stands still, so turning the other way does not count.
- **stands out**: the same, at three times the size of that boxer's usual movement in his guard: how long before the fist leaves a watcher could tell this from his bounce.
- **home**: the wrist within 8 cm of where that hand rests and slower than 0.5 m/s; or, if it never comes that close, stopped with the arm folded.

## The trials

| Trial | Seconds | Punches found | Bone length change (reader check) |
|---|---|---|---|
| 13_17 | 40.3 | 29 | 4.0e-7 |
| 13_18 | 25.0 | 23 | 4.0e-7 |
| 14_01 | 46.6 | 45 | 5.7e-7 |
| 14_02 | 45.2 | 39 | 5.7e-7 |
| 14_03 | 46.1 | 37 | 5.7e-7 |
| 15_13 | 77.8 | 38 | 6.0e-7 |
| 17_10 | 23.2 | 14 | 5.3e-7 |
| all | 304.2 | 225 | |

## Punches found, by kind

Lead and rear are by the boxer's stance at that moment (these boxers change stance within a trial). Middle value of each time over every punch found, in milliseconds.

| Kind | Found | First movement to launch | Stands out to launch | Launch to contact | Contact to home | Fist speed, m/s |
|---|---|---|---|---|---|---|
| Jab (lead straight, head) | 88 | 217 | 42 | 192 | 425 | 5.2 |
| Cross (rear straight, head) | 64 | 200 | 42 | 208 | 483 | 5.8 |
| Lead hook, head | 9 | 333 | 92 | 242 | 567 | 5.6 |
| Rear hook, head | 6 | 308 | 17 | 217 | 617 | 6.9 |
| Lead uppercut | 10 | 458 | 408 | 317 | 608 | 7.5 |
| Rear uppercut | 20 | 392 | 142 | 242 | 633 | 7.5 |
| Lead straight to the body | 8 | 408 | 33 | 200 | 542 | 5.0 |
| Rear straight to the body | 7 | 267 | 92 | 192 | 433 | 6.2 |
| Lead hook or rising punch to the body | 8 | 442 | 142 | 200 | 775 | 4.8 |
| Rear hook or rising punch to the body | 5 | 183 | 58 | 150 | 408 | 5.4 |

## Single punches kept

| Clip | Trial | Frames (120/s) | At, s | Mirrored | How cut | First movement to launch | Stands out to launch | Launch to contact | Contact to home | First movement to contact | Fist speed, m/s | Arm at contact |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jab_a | 14_02 | 4897–5026 | 40.81–41.88 | yes | alone | 217 | 25 | 208 | 483 | 425 | 6.7 | 95% |
| jab_b | 15_13 | 285–406 | 2.38–3.38 | yes | alone | 242 | 117 | 175 | 425 | 417 | 4.6 | 87% |
| cross_a | 14_01 | 4624–4740 | 38.53–39.50 | no | alone | 175 | 0 | 183 | 442 | 358 | 4.9 | 90% |
| cross_b | 14_03 | 5154–5259 | 42.95–43.83 | no | alone | 92 | 0 | 217 | 400 | 309 | 5.8 | 96% |
| hook_lead_a | 15_13 | 3245–3416 | 27.04–28.47 | yes | alone | 333 | 267 | 358 | 567 | 691 | 4.2 | 95% |
| hook_lead_b | 15_13 | 3070–3211 | 25.58–26.76 | yes | alone | 292 | 67 | 192 | 525 | 484 | 5.4 | 95% |
| hook_rear_a | 14_03 | 4008–4156 | 33.40–34.63 | no | alone | 250 | 0 | 233 | 583 | 483 | 8.8 | 89% |
| hook_rear_b | 13_17 | 4581–4724 | 38.17–39.37 | no | inside a combination | 308 | 208 | 192 | 525 | 500 | 6.9 | 77% |
| upper_lead_a | 15_13 | 5328–5515 | 44.40–45.96 | yes | alone | 442 | 417 | 333 | 617 | 775 | 7.1 | 96% |
| upper_lead_b | 15_13 | 680–853 | 5.67–7.11 | yes | alone | 433 | 408 | 342 | 500 | 775 | 7.5 | 79% |
| upper_rear_a | 14_01 | 4158–4357 | 34.65–36.31 | no | alone | 358 | 25 | 258 | 875 | 616 | 8.5 | 94% |
| upper_rear_b | 14_01 | 718–923 | 5.98–7.69 | no | alone | 408 | 0 | 267 | 867 | 675 | 6.9 | 80% |
| body_lead_straight_a | 14_01 | 3729–3852 | 31.07–32.10 | yes | alone | 208 | 33 | 183 | 467 | 391 | 5.7 | 96% |
| body_rear_straight_a | 13_17 | 2353–2448 | 19.61–20.40 | no | first of a combination | 167 | 100 | 175 | 475 | 342 | 6.6 | 70% |
| body_lead_hook_a | 13_18 | 212–276 | 1.77–2.30 | no | first of a combination | 58 | 0 | 242 | 333 | 300 | 3.8 | 68% |
| body_rear_hook_a | 13_18 | 1688–1766 | 14.07–14.72 | no | first of a combination | 167 | 50 | 133 | 183 | 300 | 5 | 69% |

"Arm at contact" is wrist-to-shoulder distance as a share of the whole arm: about 95% is a straight arm, about 70% an elbow at a right angle. **The hooks and uppercuts in these recordings are mostly long swings**: the hand drops or goes wide first (that is the long first-movement time) and the arm is nearly straight when it lands. There is no short hook or uppercut thrown from the guard with the elbow at a right angle; the takes with the most bend were preferred.

A take cut from a combination ends as the next punch's fist leaves; its contact-to-home time is still the one measured in the recording, where the hand did come home while the next punch was thrown. In the game its other arm is taken from the guard loop.

## Combinations kept as single takes

| Clip | Trial | Frames (120/s) | At, s | Mirrored | Thrown this often | Contact to contact, ms | Each punch: first movement to launch / launch to contact / contact to home |
|---|---|---|---|---|---|---|---|
| combo_jab_cross | 14_03 | 2003–2131 | 16.69–17.76 | no | 15 | 208 | jab 67/175/383; cross 50/242/450 |
| combo_jab_cross_jab | 14_01 | 3011–3159 | 25.09–26.32 | yes | 9 | 192, 250 | jab 75/117/217; cross 125/158/550; jab 200/217/442 |
| combo_cross_jab | 14_03 | 788–916 | 6.57–7.63 | yes | 7 | 258 | cross 158/158/383; jab 275/175/325 |
| combo_cross_jab_cross | 14_01 | 918–1088 | 7.65–9.07 | no | 6 | 283, 333 | cross 142/175/333; jab 342/233/542; cross 367/233/317 |
| combo_upper_rear_upper_lead | 14_01 | 1503–1786 | 12.53–14.88 | no | 3 | 483 | upper_rear 600/300/1000; upper_lead 600/392/808 |
| combo_body_lead_hook_upper_rear | 13_17 | 3861–4045 | 32.17–33.71 | no | 2 | 283 | body_lead_hook 283/142/942; upper_rear 600/225/633 |
| combo_jab_jab | 13_18 | 1186–1344 | 9.88–11.20 | yes | 2 | 300 | jab 142/200/150; jab 142/142/508 |

Every combination found, by how often:

- 15 × jab > cross: contact to contact 225, 225, 217, 225, 342, 300, 225, 267, 208, 358, 242, 225, 250, 208, 242 ms
- 9 × jab > cross > jab: contact to contact 192/250, 258/333, 225/200, 200/283, 200/200, 208/283, 308/325, 283/300, 192/208 ms
- 7 × cross > jab: contact to contact 392, 358, 358, 258, 250, 258, 208 ms
- 6 × cross > jab > cross: contact to contact 283/333, 258/217, 183/217, 208/183, 267/158, 300/283 ms
- 3 × upper_rear > upper_lead: contact to contact 483, 575, 300 ms
- 2 × body_lead_straight > upper_rear: contact to contact 333, 250 ms
- 2 × body_lead_hook > upper_rear: contact to contact 283, 375 ms
- 2 × jab > jab: contact to contact 300, 433 ms
- 1 × body_lead_hook > body_rear_straight: contact to contact 133 ms
- 1 × body_rear_straight > body_lead_hook > body_rear_hook: contact to contact 492/208 ms
- 1 × jab > upper_rear > body_lead_hook > body_rear_straight: contact to contact 192/308/392 ms
- 1 × body_lead_hook > hook_rear: contact to contact 192 ms
- 1 × body_rear_hook > jab: contact to contact 367 ms
- 1 × jab > body_rear_hook: contact to contact 233 ms
- 1 × body_rear_hook > body_rear_hook: contact to contact 317 ms
- 1 × jab > hook_rear: contact to contact 167 ms
- 1 × upper_lead > hook_lead > body_lead_straight: contact to contact 517/433 ms
- 1 × jab > jab > cross: contact to contact 400/408 ms
- 1 × jab > jab > cross > jab: contact to contact 283/333/325 ms
- 1 × upper_rear > cross: contact to contact 508 ms
- 1 × upper_rear > body_rear_straight: contact to contact 467 ms
- 1 × body_rear_straight > body_lead_straight > body_rear_straight: contact to contact 158/167 ms
- 1 × body_rear_straight > body_lead_straight > upper_rear: contact to contact 200/442 ms
- 1 × cross > jab > cross > hook_lead: contact to contact 300/275/350 ms
- 1 × hook_rear > jab > cross: contact to contact 300/392 ms
- 1 × upper_rear > upper_rear > body_lead_hook > cross: contact to contact 492/258/300 ms

## Guard loops kept

| Clip | Trial | Frames (120/s) | At, s | Seconds | Mirrored | Hips rise and fall, m | Join mismatch |
|---|---|---|---|---|---|---|---|
| guard_a | 15_13 | 1334–1514 | 11.12–12.62 | 1.50 | yes | 0.03 | 0.67 |
| guard_b | 13_17 | 3027–3235 | 25.23–26.96 | 1.73 | no | 0.17 | 0.91 |
| guard_c | 13_17 | 6–186 | 0.05–1.55 | 1.50 | no | 0.15 | 1.86 |

The brief asked for loops of 4 to 6 seconds. **The recordings do not hold one**: these boxers punch every second or two, and the longest stretch of guard with no punch, both hands up and one stance is 2.3 s. 9 stretches of a second and a half or more were found; the 3 kept are those whose last frame is most like their first, longer ones preferred. 6 more were left out because the boxer ducks or weaves in them (hips dropping over 0.2 m), which the rules do not know about. The game plays the kept ones one after another in a changing order, with a blend at each join, so the whole does not repeat for several seconds.

## Steps kept

| Clip | Trial | Frames (120/s) | At, s | Seconds | Metres (game size) | Mirrored |
|---|---|---|---|---|---|---|
| step_in_a | 14_03 | 56–96 | 0.47–0.80 | 0.33 | 0.34 | yes |
| step_in_b | 14_03 | 3803–3833 | 31.69–31.94 | 0.25 | 0.17 | yes |
| step_out_a | 13_18 | 2783–2815 | 23.19–23.46 | 0.27 | -0.28 | no |
| step_out_b | 13_17 | 58–84 | 0.48–0.70 | 0.22 | -0.18 | no |

64 steps with no punch in them were found; kept are those that leave the stance as it was and turn least.

## The times the rules read (mean of the kept single takes), seconds

| Kind | Takes | First movement to commit | Commit to contact | Contact to home | First movement to contact |
|---|---|---|---|---|---|
| jab | 2 | 0.23 | 0.192 | 0.454 | 0.422 |
| cross | 2 | 0.134 | 0.2 | 0.421 | 0.334 |
| hook | 4 | 0.296 | 0.244 | 0.55 | 0.540 |
| uppercut | 4 | 0.41 | 0.3 | 0.715 | 0.710 |
| body | 4 | 0.15 | 0.183 | 0.364 | 0.333 |

## What is missing or thin

- combination body_lead_straight > upper_rear: thrown 2 times, none usable as one take
- Nobody is hit, covers up, staggers or falls in these recordings: there are no clips for those. The fall stays the formula one.
- No guard loop of 4 to 6 seconds (see above).
- Hands are the noisiest part of this database; glove direction is not recorded, only where the wrist is.
- The fists peak at 4 to 9 m/s relative to the chest: shadow boxing at a working pace, not a fighter's fastest.
