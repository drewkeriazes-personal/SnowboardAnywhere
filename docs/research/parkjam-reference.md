# Research: ParkJam and what applies here

ParkJam (@parkjamgame on Instagram) is a work-in-progress indie snowboard game. Its pitch: "Realistic rails, realistic jumps, realistic filming." It is shown only as Instagram reels and has a public Discord (83 members on 15 Nov 2026). This note records what it shows, what players say about it, and the lesson for each of our epics.

How it was studied (2026-11-15): the profile and the six newest reels (captions, likes, comments) were read logged out in Drew's Chrome, plus web searches. No build exists to run REA on, so nothing about its internals is known. The Discord was not joined. Engine, platform and developer are not stated anywhere public.

Labels: **observed** is read from the posts, **inferred** is a reading that was not proven.

## 1. What the reels show (observed)

| Reel | Posted | Likes | Comments |
|---|---|---|---|
| More sunset laps | 14 Nov | 463 | 28 |
| Down-flat-down is hard to lock in | 15 Nov | 124 | 3 |
| Hand drags coming soon | 11 Nov | 85 | 8 |
| Blunt stalls | 12 Nov | 35 | 0 |
| Top to bottom in the practice park | 7 Nov | 28 | 4 |
| Grabs + corks | 9 Nov | 23 | 3 |

- Features: round down rail, flat bar, culvert pipe, box, down-flat-down, tabletop jumps with clear lips and knuckles, groomed corduroy.
- Tricks: presses, butters, boardslides and 50-50s, blunt stalls, grabs, corks. Hand drags announced.
- Look: baggy hoodie and pants, helmet and goggles, branded boards (a Salomon graphic).
- Camera: low, tight follow shots like a real filmer, slight fisheye feel (inferred from framing).

## 2. What players say (observed)

- Praise is mostly for rail physics.
- Asks: mobile (several), PS5, Steam, touch controls like Street Skate, moving the camera, music, a less stiff rider, skis.
- One long comment asked for super quick reverts, faster stops and carves, and the upper body moving apart from the legs in slides.
- Backlash: the most-liked comment calls it vibecoded; several say "just play Shredders" (or Jibbers).

## 3. Lessons mapped to epics

| # | Lesson | Epic | Cards |
|---|---|---|---|
| 1 | Rails are what people notice; lock-in should get harder on kinks | EPIC-06 | FEAT-114 #197 (expand spec: shapes, lock-in window, balance, speed through), FEAT-191 #457 to prototype on synth without waiting on MapPacker DATA-018 |
| 2 | Stalls and hand drags are cheap, readable wins | EPIC-05, EPIC-06 | FEAT-114 #197 (stalls), FEAT-151 #338, new card idea: hand drag on carves |
| 3 | Grabs and corks first; make pop timing at the lip readable | EPIC-05 | FEAT-186 #452, FEAT-187 #453, FEAT-188 #454 (add early or late pop to the fall reason) |
| 4 | Board control depth: reverts, quick stops, upper body apart from legs, less stiff rider | EPIC-05 | FEAT-220 #504, FEAT-151 #338, FEAT-081 #143, new card idea: quick revert on landing |
| 5 | Filmer-style camera sells the realism | EPIC-08 | FEAT-136 #294, FEAT-190 #456, new card idea: filmer cam (follow or lead, fisheye, slow-mo below 0.25x) |
| 6 | Players want it on phones; we are already in the browser | EPIC-05 | FEAT-063 #96, FEAT-049 #81 |
| 7 | The baggy park-rat silhouette matters; keep no brands | EPIC-14 | FEAT-209 #481, FEAT-215 #487, add a baggy fit option |
| 8 | Real parks at real resorts set us apart from the "clone" pile | EPIC-06, EPIC-07, EPIC-09 | MapPacker DATA-018, FEAT-192 #458 |
| 9 | Golden-hour light carried the best reel by about 4x | EPIC-03 | keep sunset quality high |

## 4. What main does today (for the rows above)

- No rail or grind code (`rail` in `game/src` only matches bridge railings and landmark beams).
- No grabs (`input.grab` only softens the crash test in `sim/rider/Tricks.ts`).
- Spin stops when steer is released; takeoff zeroes carve yaw (`sim/rider/Jumps.ts`), which FEAT-187 fixes.
- Cameras: `chase | close | far | cine | fp | helmet | free | eye` (`world/ChaseCamera.ts`). Replay speeds 0.25 to 2x (`states/ReplayState.ts`).
- Press with a balance meter (`sim/rider/Press.ts`), hard carve; no butters yet.

## 5. Revisit when

A Steam page, itch.io page or public demo appears. Then REA can look at how their rails work.

Sources: https://www.instagram.com/parkjamgame/ and its reels, https://discord.com/invite/uwWtmySym, SnowboardAnywhere main at e36f28e.
