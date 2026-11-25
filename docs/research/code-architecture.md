# Code architecture: readable code, lean comments, one job per file (FEAT-390)

Card: FEAT-390, [SnowboardAnywhere#871](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/871) and its twin [MapPacker-SnowboardAnywhere#259](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/issues/259). Built by: FEAT-391 ([#872](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/872), MapPacker-SnowboardAnywhere#260). Folded in: FEAT-359 ([#820](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/820), the `Vegetation.ts` / `clumps.ts` split). Left to its own document: FEAT-389 (MapPacker-SnowboardAnywhere#255, PR [MapPacker-SnowboardAnywhere#263](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/pull/263), `docs/research/build-order.md` in MapPacker, the inside of `build_pack.py`). The two documents are reconciled: see [Reconciled with FEAT-389](#reconciled-with-feat-389) and [Cross-repo](#cross-repo).

Status: **draft for Drew's review.** Nothing in either repo changes until Drew approves. The rules below are a proposal; once agreed they go into both repos' `CLAUDE.md` and the `lean` skill (step 2 of the card), and the plan is built PR by PR under FEAT-391.

Surveyed: game `origin/main` at `ce9bb75`, MapPacker `origin/main` at `c72be69` (2026-11-25).

## Proposed rules (step 2, for Drew to agree)

Today the only structural rule is FEAT-352's 1,000-line cap per file. These would replace and extend it in both `CLAUDE.md` files and the `lean` skill. Each one is something the `lean` pass can check on a diff.

1. **Comments say why, a constraint or a unit.** Never a retelling of the next lines. A comment above a function is at most a third of the function's length; a file header is at most 6 lines and says what the file is for and what it is not.
2. **No history in source.** No card diaries, dates, "Drew picked", rejected variants, before / after numbers or tuning logs. Those live in the PR, the card or `docs/research/`. A card id appears only as a pointer a reader needs, at most one per comment (`// why the 2.5x: docs/research/forest-ground.md`, or `// BUG-142`), never as a prefix on every line.
3. **Before a long comment is cut, its reasoning has a home.** The PR that cuts it checks the card, PR or research doc holds the why, and moves it there if not.
4. **One job per file, class and function.** The file name says the job. A file that holds two unrelated jobs splits. A function past about 80 lines of code (shader source excepted) is a finding; one past 150 splits.
5. **Files: aim under 600 lines, cap 1,000.** Over 600 is a lean finding ("split it when you next add to it"); over 1,000 stays a hard stop, as today.
6. **Shader source lives in its own module** (`<name>.glsl.ts` next to the material that uses it), as named chunks, not inside a factory function hundreds of lines long.
7. **Folders by domain, imported where used.** New code goes in the domain folder of the layouts below. No new file at the top of `game/src/world/`, `game/tools/` or `pipeline/` once those layouts exist.
8. **One home per helper.** Math (`clamp`, `clamp01`, `lerp`, `smoothstep`, seeded `rng`, `hash01`, segment and polygon tests), HTML escaping, time formatting, pack readers (tile lookups, mask and height reads), JSON and path helpers each have one module per repo. Use three.js `MathUtils`, the standard library or numpy first. The lean skill's rung 2 names these modules.
9. **Lines under 140 characters.** Long one-line functions and trailing comments push the reader sideways; break them.
10. **Python modules do nothing on import.** Work happens in functions; a script ends in `if __name__ == "__main__": main()`. No module-level state shared through globals. `build_pack.py` is the one exception until FEAT-389's split (P11) is done: its stages leave module level one PR at a time, and the shared state becomes FEAT-389's `Frame` and `Grids`.
11. **A move PR only moves and renames.** Behaviour changes get their own PR and card. A move PR proves nothing changed: game, the physics and synth-pack checks pass and render budgets match `main`; pipeline, synth and Vail packs byte-identical and the same build time. Code moved verbatim may leave a function past rule 4's 150 lines or a file past rule 5's 600 (`build_pack.py`'s stages 5, 5b, 6 and 8 will); the PR lists them, and the split is the next PR, byte-proved the same way. The 1,000-line cap still holds. Move PRs need no Refresh packs run: `refresh_packs.py` marks all 19 resorts behind on any `pipeline/` change, but a rebuild publishes nothing while the content key is unchanged.
12. **No performance loss.** Game frame cost by GPU timer queries (`perf-check`), pipeline build time and output bytes. A change that moves either says why in the PR.
13. **A comment or wrap pass proves it changed no code.** Game: the `vite build` bundle is byte-identical to `main`'s (minified output carries no comments or line breaks; text inside shader strings is code, so a comment pass leaves it alone). Pipeline: every module's `ast.dump` with docstrings stripped is identical to `main`'s.

How the rules land (step 2, after Drew agrees): one PR per repo puts them in `CLAUDE.md` in place of the FEAT-352 / FEAT-382 "Lean code" paragraph, and the game PR adds them to `.claude/skills/lean/SKILL.md` section 3 (Structure checks), with the helper modules of rule 8 named in rung 2. Rules 5, 9 and the card-id half of rule 2 could also become warnings in `tools/ci/repo_rules.py`; that is Drew's call, not part of this card.

## Ranked findings

Ranked by how much each gets in a reader's way: how often a reader meets it, and how much it costs them when they do. Measured on `origin/main`; method and scripts at the end.

| # | Finding | Measure | Where it bites |
|---:|---|---|---|
| 1 | **Card history in comments.** Comments read as a changelog: card ids, who picked what, what it used to be. The reader reads past the history to find the rule. | Game `src`: 2,050 card ids in comments, one per 15 code lines; comments are 36% of the non-space characters. Pipeline: 628 card ids (558 in `pipeline/`), 28% of the characters. Worst: `sim/rider/tuning.ts` 74 ids in 102 code lines, `sim/Rider.ts` 82, `world/Vegetation.ts` 109, `build_pack.py` 116. | Everywhere, on every read. |
| 2 | **Two functions that are a whole domain.** `createTerrainMaterial` is 600 lines (536 of them shader strings); `createSession` is a 485-line closure holding spawn, sun, settings, modes, the event bus, the main menu, scene setup and the frame loop. Neither has names for its parts. | `terrain/TerrainMaterial.ts:117`, `session/Session.ts:81`. Next: `clumps.ts` `buildMaterial` 212, `Buildings.ts` `extrude` 193, `Terrain.ts` `build` 175, `RiderRig.ts` `buildRig` 175. 17 game functions over 100 lines, 54 over 60. | Terrain look and session start-up, two of the most edited areas. |
| 3 | **`build_pack.py` is a script, not a module.** 1,016 of its 1,581 lines run at module level against globals (`X0`, `W`, `SOURCES`, `REL`), so no stage can be read, tested or imported alone. | 25 top-level defs; the rest is module-level code. | Every pipeline change touches it. **Owned by FEAT-389.** |
| 4 | **Flat folders past the point of browsing.** The tree doesn't say what belongs together or where new code goes. | MapPacker `pipeline/` 47 modules and `pipeline/tests/` 51 files, flat. Game `game/tools/` 104 `.mjs` (62 of them `*check.mjs`), `game/src/world/` 51 files, `game/src/ui/` 44. | Finding code; placing new code. |
| 5 | **Files doing several jobs.** | Over 600 lines: game 8 (`Vegetation.ts` 1,088, over the cap; `clumps.ts` 951, `treeLines.ts` 869, `TerrainMaterial.ts` 716, `Terrain.ts` 706, `SettingsOverlay.ts` 667, `generate.ts` 655, `Audio.ts` 633); pipeline 11 (`resort.py` 1,857, `build_pack.py` 1,581, `pack_report.py` 1,057, `tree_lines.py` 962, `build_resort.py` 879, `gen_content.py` 832, `published.py` 798, `traffic.py` 726, `cover.py` 673, `publish_merge.py` 671, `species.py` 655). Jobs per file below. | Forest, terrain and resort planning. |
| 6 | **Helpers copied instead of shared, even where a shared one exists.** `ui/esc.ts` exists and 8 UI files define their own identical `esc`; `sim/Rng.ts` exists and 5 files bring their own generator. | Game: `smoothstep` 12 copies (`THREE.MathUtils.smoothstep` also exists), `clamp01` 5, `esc` 8, time formatting 7 (3 formats), `segDist` 4, point-in-polygon 2, `hash01` 3 different functions, `pushW` / `lerpW` copied whole between `Monster.ts` and `RiderRig.ts`, `HeightSet.request` and `MaskSet.request` 96% alike; 204 inline `Math.min(Math.max(...))` clamps beside 90 uses of `MathUtils.clamp`. Pipeline: `smoothstep` 5, `read_mask` 4, `read_heights` 2, `load_json` 3, polygon `inside` 2, `maintainers` 2, CI step summary 2, `to_local` 2. | A reader can't trust two copies behave alike, and a fix lands in one. |
| 7 | **Long lines.** One-line functions with several statements, long trailing comments. | Lines over 160 characters: game `src` 828, game tools 1,117, pipeline 44. | Reading diffs and code side by side. |
| 8 | **File headers that tell the story.** Module docstrings of 25 to 54 lines open the pipeline's bigger files; several game files open with 20 to 52 lines. Much is design that belongs in `docs/`, or history that belongs in the card. | Pipeline: 61 comment blocks of 8 lines or more; `tree_lines.py` 54, `build_resort.py` 50, `traffic.py` 45, `tools/ci/raw_cache.py` 45, `publish_pack.py` 44. Game: 111 blocks of 8 or more; `TerrainMaterial.ts` 52, `Moguls.ts` 44, `ReleaseToast.ts` 35, `Tracks.ts` 31. | The first screen of each file. |
| 9 | **Giant classes in the pipeline.** | `pack_report.py` `Report` 632 lines, its `check` method 288; `tree_lines.py` `Planner` 662; `resort.py` 90 top-level defs mixing name search, OSM lookups, the data plan, prompts and the `add` orchestration. | The scorecard and the resort planner. |
| 10 | **Comment-heavy small files.** Mostly fine (many are tuning tables, where a comment per constant is the point), but the ratio hides the card ids inside them. | Files with 30+ code lines: game median ratio 0.25, 64 of 181 at 0.3 or more, 16 at 0.5 or more (`tuning.ts` 2.16, `lineCanopy.ts` 0.75, `AttractShots.ts` 0.73); pipeline median 0.13, 17 of 105 at 0.3 or more (`stands.py` 0.51, `widths.py` 0.50). | Cut the history, keep the units. |
| 11 | **Shader duplication** is small: a handful of repeated GLSL lines (varyings, `covUV`, a billboard bias) across the 24 files with shader strings. | Under 15 repeated lines. | Low. |

Not a finding: the overall comment ratio (game 0.26, pipeline 0.20) is not high by itself. What hurts is what the comments say (findings 1 and 8), not how many there are.

## Game

### Big files and their jobs

| File | Lines | Jobs today | Split |
|---|---:|---|---|
| `world/Vegetation.ts` | 1,088 | reach and LOD settings (module `let`s and setters, lines 43 to 155); cell loading and stand stems (`load`, `loadStand`, `regenerate`, `dropCell`); the near LOD sets and their culling (`gather`, `packNear`, `cull`, `tileWanted`, `castWanted`); far impostor packing (`buildFar`, `checkFar`, `packFar`, `tileRange`); tree queries (`trunkAt`, `forEachTree`, `crownContact`, `setSolid`); the 141-line `update` that drives them | FEAT-359: G2 |
| `world/trees/clumps.ts` | 951 | the stand mix per pack (`standMix`); patch generation (`genPatch`, `widenPatch`); the bake material and steps; 246 lines of GLSL (`CROWN_GLSL`, `TONE_FN`, `buildMaterial` 212); `ClumpCanopy` block placement and update | FEAT-359: G3 |
| `pack/treeLines.ts` | 869 | 100 lines of tuning constants; 2D geometry (`segClosest`, `project`, `along`, `SegGrid`, `TrunkIndex`); planning lines from runs (`planRuns`, `planBoxes`, `avoid`, `finish`); taking the baked lines (`takeBaked`); the queries the world asks (`trenchAt`, `wornAt`, `brakeAt`, `nearestLine`, `trimAt`, `trimTile`) | G5 |
| `terrain/TerrainMaterial.ts` | 716 | cover uniforms; one 600-line `createTerrainMaterial` holding 536 lines of shader patches | G4 |
| `terrain/Terrain.ts` | 706 | procedural forest noise (`vnoise2`, `proceduralForest`); chunk LOD selection and streaming (`update`, `select`); the 175-line chunk `build`; a dozen pass-through setters for cover, snow, moguls and shade | G12 |
| `ui/SettingsOverlay.ts` | 667 | pages and rows; key binding capture (`drawKeys`, `listenKey`); pad binding capture (`listenPad`); search; credits; reset prompts | G9 |
| `world/trees/generate.ts` | 655 | a mesh `Builder`; primitive shapes (`tube`, `card`, `starCone`, `blob`); tree plans per species (`makePlan`, `hardwoodPlan`, `crownProfile`); LOD0 (143 lines) and LOD1 geometry | G12 |
| `audio/Audio.ts` | 633 | music source, playlists and queue (`loadPlaylist`, `buildQueue`, `playItem`, `nextTrack`); 15 sound effects synthesised in place (`burst`, `tone`, `creak`, `footstep`, `rockScrape` and more); the per-frame rider mix (`update`, 87 lines) | G11 |
| `session/Session.ts` | 565 | one `createSession` closure; its own section markers name eight jobs: spawn point, sun and time, settings application, modes, the news bus, the main menu, scene setup, the frame and states | G7 |

### Comments

`game/src`: 29,761 code lines, 7,745 comment lines (ratio 0.26), 2,050 card ids, comments 36% of non-space characters. Game tools (`.mjs`): 15,811 code, 2,690 comment (0.17), 396 card ids. The ratio per file for every file of 300 lines and up is in the appendix.

The worst blocks are dense rather than long. `Vegetation.ts:396` is six lines of FEAT-292 / BUG-130 history inside `update`. `tuning.ts` puts a card id on most constants (`FEAT-133: steering while braking opens ...`). The 24-line comment that opens `Vegetation.ts` has a FEAT-074 and a FEAT-158 paragraph, which is design for `docs/developer-guide.md`. History words in comments: "Drew" 18 times, dates 5, "originally" / "until 2026" 7.

Open PR game #870 (FEAT-387) moves card ids out of visible strings in 11 tool files and two workflows. It doesn't touch `game/src` and changes no finding.

### Duplicated helpers

Found by matching every function's token stream with identifiers renamed by position, plus a 90% near-match. Copies identical after renaming, or nearly:

| Helper | Copies | One home |
|---|---|---|
| `smoothstep` / `smooth` / `ss` | 12: `pack/treeLines.ts`, `sim/PadFeedback.ts`, `terrain/Moguls.ts`, `terrain/rockCover.ts`, `world/Eat.ts`, `world/riderView/math.ts`, `world/Shrubs.ts`, `world/SnowCover.ts`, `world/TreeBrush.ts`, `world/trees/lineCanopy.ts`, `world/trees/snow.ts`, `world/trees/trim.ts` | `core/math.ts` (or `THREE.MathUtils.smoothstep(x, a, b)`) |
| `clamp01` | 5: `sim/SnowConditions.ts`, `world/Spray.ts`, `world/TreeBrush.ts`, `world/trees/generate.ts`, `world/trees/snow.ts` | `core/math.ts` |
| `lerp` / `mix` | `world/trees/generate.ts` (exported), `terrain/rockCover.ts` | `THREE.MathUtils.lerp` |
| `esc` | 8 local copies (`FirstRun`, `LiftPicker`, `MainMenu`, `PauseMenu`, `ReleaseToast`, `ResortPicker`, `RunCard`, `SettingsOverlay`) beside `ui/esc.ts` | `ui/esc.ts` |
| time formatting | 7 in `MainMenu`, `PauseMenu`, `OutrunUI` (2), `TrialHud`, `ReplayBar`, `RunCard`; 3 formats | `ui/format.ts`, one function per format |
| `segDist` | 4: `sim/Boundary.ts`, `world/slowSignSites.ts`, `world/people/plan.ts`, `world/Buildings.ts` | `core/geom2d.ts` |
| point in polygon | `world/Buildings.ts` `pointInPoly`, `sim/Collider.ts` `insidePoly` | `core/geom2d.ts` |
| `polyLength` | `sim/Courses.ts`, `world/slowSignSites.ts` | `core/geom2d.ts` |
| `pushW`, `lerpW` (bone weights) | `world/Monster.ts`, `world/RiderRig.ts` | one rig helper |
| seeded random | `sim/Rng.ts` (mulberry32) and 5 others: `audio/Jukebox.ts` `mulberry`, `world/Clouds.ts`, `world/people/plan.ts`, `world/trees/generate.ts`, `world/trees/textures.ts` | `sim/Rng.ts`, only where the sequence is the same |
| hashes | `world/trees/species.ts` `hash01(x, y, salt)`, `world/slowSignSites.ts` `hash01(s)`, `world/Rocks.ts` `hash01(v)`, `world/people/plan.ts` `hashString`, `terrain/Moguls.ts` `hash` | different functions under one name: rename, don't merge |
| tile sets | `pack/HeightSet.ts` and `pack/MaskSet.ts`: `request` 96% alike, plus `key` and `contains` | one tiled-set base |
| dispose loops | 4 different `traverse(... dispose)` loops (`AttractGhosts` 2, `Monster`, `RiderView`) | `core/dispose.ts` |

Not every copy can merge in a move PR: the random generators and hashes differ in algorithm, and swapping one changes what is drawn. The plan merges only copies that are identical after renaming, and renames the rest so the names stop claiming they are the same.

### Target layout for `game/src`

The top-level domains stay (`core`, `pack`, `terrain`, `world`, `sim`, `ui`, `session`, `states`, `audio`, `modes`, `account`, `firebase`). What changes is inside the crowded ones, plus the shared helpers.

```
core/          + math.ts (clamp01, smoothstep), geom2d.ts (segDist, pointInPoly, polyLength), dispose.ts
pack/          Pack format types treeline fetch
  tiles/       HeightSet MaskSet CoverSet CanopyGrid tiledSet tileDecode tileDecode.worker tileStats
  treeLines/   constants geometry plan TreeLines (the queries)
terrain/       Terrain chunkBuild chunkSave drawnGround exposure oldTracks Moguls proceduralForest
  material/    TerrainMaterial uniforms terrain.glsl
  rock/        rockCover rockShader
world/         SceneRender
  trees/       today's trees/, plus TreeBrush TreeFade TreeShade TreeWells Shrubs, vegetation/ and clumps/ (FEAT-359)
  sky/         Atmosphere Clouds Sky Sun SunClock scattering ParticleLight Lens
  snow/        Snow SnowCover snowLook Deform Tracks Bootprints Spray Puffs Eat
  rider/       RiderView RiderModel RiderRig RiderChair Ragdoll Gait BumpAbsorb carveLean, and riderView/
  camera/      ChaseCamera
  lifts/       Lifts LiftLines LiftModels
  places/      Buildings Bridges Landmarks Roads Rocks BoundaryRope SlowSigns slowSignSites DropZones RunsOverlay
  people/      today's, plus StaticPeople Monster
  attract/     AttractShots AttractGhosts
  modes/       TrialWorld
sim/           Rider Rng Replay Prefetch, rider/ as today
  input/       Controls DualSense Pad PadFeedback
  lift/        LiftLine LiftRide
  ground/      Boundary Collider OutOfBounds SnowConditions Snowpack
  challenges/  Courses Outrun TimeTrial RunStats
ui/            esc format Toast Units
  menu/        MainMenu PauseMenu FirstRun LiftPicker ResortPicker LauncherBrowser MenuNav MenuKeys MenuShotForm MenuStill
  settings/    Settings SettingsOverlay SettingsRows bindings search
  hud/         HudLine HudEvents HintBar KeyHints KeyLabels ContextPrompt PressMeter RestartRing SpeedLines GoggleView
               TrialHud OutrunUI RunCard ReplayBar ReleaseToast Conditions Loading
  input/       PadGlyphs PadNav TouchControls InputView
  map/         MountainView ResortMap Labels
  account/     AccountLine AccountPanel BuildWatch
audio/         Audio (the mixer) Music Sfx ChaseAudio Jukebox
session/       Session (wiring) spawn sunClock applySettings modes news menu scene frame, World warmUp devSaves eventSources
```

`game/tools/` (104 flat files), by what a tool is for, with the shared modules in `lib/`:

```
game/tools/
  lib/          browser paths rider probe views host same_origin
  checks/       the 62 *check.mjs
  shots/        shoot shoot_attract shoot_features shoot_spots cishot cishot_diff compare aerial brakeshot carveshot
                peopleshot treeshot (+ treeshot/) canopy_clip canopy_compare attract_look auto_attract trim_take
  perf/         loadperf playperf tileperf treeperf gpu_ab
  serve/        launcher launcher_browser dev_hot pack_routes resort_build_routes build_progress
  packs/        get_pack package source_hashes prep_textures.py
  ghost_lines/  today's, plus ghost_lines.mjs and its config
  accounts/     today's, plus set_role
```

Moving `game/tools` touches 107 distinct tool paths named in 41 files (workflows, docs, skills, `package.json`), so it is a PR of its own with a reference sweep. The commands Drew types (`npm run get`, `node tools/shoot.mjs`) keep working through `package.json` scripts, or the docs change in the same PR.

## Pipeline (MapPacker)

### Big files and their jobs

| File | Lines | Jobs today | Split |
|---|---:|---|---|
| `resort.py` | 1,857 | name search and matching (`search`, `closest_names`, `match_quality`); OSM lookups (`osm_*`, `stream_members`); HTTP (`curl_json`, `fetch_json`); the data plan (UTM boxes, DEM, lidar, NAIP, tiers, sizes; `plan` alone is 189 lines); a Mapterhorn vector-tile reader (`_varint`, `mvt_strings`); the plan report (`plan_md`); comparing configs; interactive prompts (`ask*`); the `add` orchestration (`cmd_add`, `pack_build`, `ride`, `publish_pending`); the CLI | P6 |
| `build_pack.py` | 1,581 | 13 stages inline at module level | **FEAT-389** (P11) |
| `pack_report.py` | 1,057 | pack readers (`read_heights`, `read_mask`, `read_instances`, `read_stands`); polyline and run geometry; course thresholds; tree density; the `Report` class (632 lines: `measure` 140, `check` 288 over every DATA-022 line); the CLI | P8 |
| `tree_lines.py` | 962 | eligibility; the `Planner` class (662 lines: cost field, tracing, `ride` 133, forks, `export` 67); validation; the CLI | P4 |
| `build_resort.py` | 879 | the stage cache (`sha`, `file_sha`, `same_code`); 12 stages as `<stage>_inputs` / `_present` / `_run` triples; `decide`; the CLI | P5 |
| `gen_content.py` | 832 | the default start (`choose_start`, `StartCheck`, `walk_from`); menu shots (`Panorama`, `best_view`, `choose_shots`); the attract index and stills on disk | P9 |
| `published.py` | 798 | Wikipedia infobox parsing; trail lists; the OSM ski-area match; comparing with the pack; writing and refreshing | P7 |
| `traffic.py` | 726 | grid and pack readers; the `Field` sim (`simulate` 115); tile encode and decode; the CLI | P4 |
| `cover.py` | 673 | forest cover levels from crowns, lidar and land cover; calibration; its own pack window readers | readers to `shared/` (P1) |
| `publish_merge.py` | 671 | the PR decision (`decide`, `label_ok`, `files_ok` and more); the GitHub API; release then merge; the sweep | P10 |
| `species.py` | 655 | species classification east and west; LANDFIRE lookups; crown radii; shrubs; a debug PNG | one domain: comment pass only |

### Comments

`pipeline/`: 12,500 code lines, 2,557 comment lines (ratio 0.20), 558 card ids. With `tools/ci/` and `tools/`: 14,261 code, 2,954 comment (0.21), 628 card ids; comments are 28% of non-space characters. Tests: 8,332 code, 479 comment, 202 card ids. History words: "Drew" 5, dates 6. The worst are the module docstrings (finding 8), which often hold a stage's design; those move to `docs/` before they are cut (rule 3).

Open PR MapPacker #252 (FEAT-386) moves card ids out of visible strings (workflow input descriptions, CI messages) into trailing comments across 20 files. It raises the card-id count a little and changes no ranking. #256, #257 and #258 (PC runner) touch `tools/ci/` (`build_pack_ci.py`, `build_failures.py`, `refresh_packs.py` +98 / -25, `wait_turn.py`); none takes a file past 600 lines, and they change no finding.

### Duplicated helpers

| Helper | Copies | One home |
|---|---|---|
| `smoothstep` | 5: `pack_geom.py` `smooth`, `species.py`, `widths.py` (identical), `cover.py`, `moguls.py` `_smoothstep`; `relocate.py` has its own `smoothstep` and `tier_sources.py` a different `smooth` | `shared/mathx.py` |
| pack readers | `read_mask` in `cover.py`, `pack_report.py`, `traffic.py`, and `piste_dir.py` `read_mask_channel`; `read_heights` in `pack_report.py`, `traffic.py`; `cover.py` `read_height_set` | `shared/packread.py` |
| JSON | `load_json` in `pack_report.py`, `resort.py`; `pack_lint.py` `_load_json`; 38 inline `json.load(open(...))` in 12 modules | `shared/jsonio.py` |
| polygon `inside` | `extract_osm.py`, `placenames.py` | `shared/geom.py` |
| `to_local` | `build_pack.py`, `cover.py` | `shared/geom.py` (the `build_pack.py` side under FEAT-389) |
| `maintainers` | `publish_pack.py`, `tools/ci/build_pack_ci.py` (identical) | `publishing/` |
| CI step summary | `tools/ci/build_failures.py` `write_summary`, `tools/ci/build_pack_ci.py` `summary` (identical) | one `tools/ci/` module |
| path setup | 34 `sys.path.insert` lines | packages remove most |

`paths.py` already is the one home for the layout, and it holds: outside it only `publish_pack.py` and `pack_report.py` join `resorts/` or `manifests/` themselves.

### Target layout for `pipeline/`

Code moves into packages; **the commands people and workflows type stay where they are** (`resort.py`, `build_resort.py`, `build_pack.py`, `publish_pack.py`, `publish_merge.py`, `publish_check.py`, `pack_report.py`, `synth_pack.py`, `contract.py`, `fetch_index.py`, `releases.py`, `release_zip.py`, `paths.py` and the fetch scripts; 21 files outside `pipeline/` name them), each a short entry script that imports its package and calls `main()`. Every entry already runs with `pipeline/` on `sys.path`, so packages import by short name (`from forest import species`). None of the package names below imports anything in Drew's Python today; `build` is avoided because PyPA's `build` package uses it.

```
pipeline/
  <entry scripts, today's names>
  shared/       paths retry (+ retry.json) jsonio packread geom mathx pack_geom
  planning/     search osm hosts dataplan mvt planreport compare prompts add (from resort.py),
                tiers tier_sources ept_select gen_manifest, published/ (parse compare write)
  fetching/     fetch.ps1 fetch_static.ps1 fetch_landfire.mjs landfire_args.mjs fetch_index fetch_grooming extract_osm osm_filter osm_check
  building/     stages/ (FEAT-389), packwriter relocate synth_pack terrain_ao coarse_set piste_dir moguls lift_towers
                straightness naip_calib placenames
  forest/       species stands cover canopy canopy_spots far_trees treeline widths
  routes/       tree_lines/ (cost field, tracing, export), traffic/ (field, tiles)
  content/      start shots files (from gen_content.py), pack_content
  checks/       pack_report/ (readers, runs, trees, one module per checklist group, the table), pack_lint contract
  publishing/   publish_pack publish_check publish_merge (decide, github) release_zip releases
  running/      build_resort/ (cache, stages, decide)
  tests/        one folder per package, mirroring it
tools/ci/       could split into build/ and checks/ later; at 15 files it can stay flat
```

The inside of `build_pack.py` (its stage modules, the stage interface and the order, including whether the traffic map moves earlier) belongs to **FEAT-389**: [`docs/research/build-order.md` > Q5](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/blob/issue-255-build-order/docs/research/build-order.md#q5-split-build_packpy-into-stage-modules) in [MapPacker-SnowboardAnywhere#263](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/pull/263). This layout gives it a home, `building/stages/`, and the `shared/` modules it can import.

### Reconciled with FEAT-389

FEAT-389's Q5 was first written without this document; #263 at `7bc4445` takes this layout. Both now agree on the rows below, and the "Answer" column says whose it was.

| Point | FEAT-389 (#263) | Here | Answer and why |
|---|---|---|---|
| Package for the stages | `pipeline/build/` at first, `building/stages/` since `7bc4445` | `building/stages/` | **This document's, now in both.** `pipeline/` is on `sys.path`, so a `build/` folder there shadows PyPA's `build` package for any code run with `pipeline/` on the path, and reads as the build output folder. #263's files: `frame.py`, `runner.py`, `terrain.py`, `canopy_height.py`, `naip.py`, `landfire.py`, `features.py`, `mogul_scores.py`, `masks.py`, `trees.py`, `shrubs_rocks.py`, `meta.py`, `post.py`. |
| Stage module names | as above | none proposed | **#263's.** Stage modules are named by stage, domain modules by domain; the mogul stage is `mogul_scores.py` so it does not share a name with `building/moguls.py`. |
| Where domain modules go | "stay where they are until FEAT-390 says" | `forest/`, `routes/`, `building/` (P2 to P4) | **This document's.** The stage modules import them from their package: `forest.cover`, `routes.tree_lines`, `routes.traffic`, `building.moguls`, `building.packwriter`. |
| The frame's transforms (`to_local`, `to_ll`) | in `Frame` | `to_local` to `shared/geom.py` (P1) | **Both:** `shared/geom.py` holds the function (it also serves `cover.py`), `Frame` holds the box and calls it. One home per helper (rule 8). |
| Rule 10 (nothing on import) and the runner | stages run through a runner; `Frame` replaces the globals `X0`, `W`, `SOURCES`, `REL`; stages 1 to 9 "stay inline, run as one stage" in P11.1 | rule 10 | **Agree.** #263's `Stage` / `Grids` / runner is how `build_pack.py` meets rule 10; rule 10 names `build_pack.py` as the exception until P11.7. Open in #263: how P11.1 runs the inline block "as one stage" while its 25 top-level defs still read the module globals. |
| File and function size | stages 5, 5b, 6 and 8 are 160 to 300 lines; each moves as one `run` function, split in a second byte-proved PR | rules 4 and 5 | **Both:** rule 11 says a move PR may leave a function over 150 lines and the split is the next byte-proved PR. Every stage module is under 600 lines (#263: stage 6, about 300, is the biggest). |
| Move proof | this document's, with `tools/pack_bytes.py` saying which folder differs when a key does | `tools/ci/pack_content_key.py` key; two runs each | **Agree.** `pack_content_key.py` is the gate, `pack_bytes.py` the diagnosis, for every P PR. `pack_bytes.py` should walk files with `publish_pack.pack_files` and skip `STAMPS`, so the two never disagree on what a pack is. |
| Per-stage timing | `meta.json` `buildStages`, added to `publish_pack.STAMPS` in the same PR | not addressed | **#263's.** Not under `build`: `meta.build` is a string stamp the game keys its saved resort data and menu stills on (`core/builtData.ts`, `session/warmUp.ts`, `attract/index.json` `looks.<id>.pack`). A top-level key in `STAMPS` stays out of the content key, the game doesn't read it, and MapPacker's `docs/pack-format.md` lists it with the stamps. |
| P11's place in the order | after P1 (P11.1 imports `shared/geom.to_local`), beside P2 to P4 | "beside any of the above" | **#263's.** A stage imports its domain module by whatever path is current and the later move updates the import. FEAT-389's behaviour cards touch `traffic.py`, `tree_lines.py` and `moguls.py`, so they don't run beside P3 and P4; whichever lands first, the other rebases. |

P11 in the plan below is FEAT-389's P11.1 to P11.7 in its order, a deletion PR in front (P11.0) and its freeing-by-declaration PR after (P11.8).

### FEAT-389's follow-ups and this plan

#263's "Follow-ups for Drew to pick from":

| # | Follow-up | Here |
|---:|---|---|
| 1 | rough traffic at 7b feeding the tree line seeds | not in this plan: a behaviour card, after P11 (rule 11) |
| 2 | the mogul traffic term | not in this plan: a behaviour card, after P11 |
| 3 | the `build_pack.py` split | **covered: P11** |
| 4 | one cat-track rule for `moguls.py` and `traffic.py` | not a dedupe: the two rules disagree on unnamed tracks, so merging them changes output. Its own card, after P3 and P4 put both modules in place |
| 5 | stage 12 beside 9b, 10 and 11 | not in this plan: a build-time change, after P11 |
| 6 | delete `piste_polys` and `snowfield` | **covered: P11.0**, the deletion PR before the split |
| - | freeing by declaration in place of the `del`s (Q5) | **covered: P11.8** |
| 7 | `tree_lines.py`'s docstring | **covered: P13** (the `routes/` comment pass) |
| 8 | a pack byte-compare tool and the build-time noise | **covered:** `tools/pack_bytes.py` is the first commit of FEAT-391's pipeline side, next to the code stats tool, and the proof of every P PR |
| 9 | `treelinecheck.mjs` fails on Vail | filed as BUG-182, [SnowboardAnywhere#878](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/878); G5's proof allows for it (below) |

## Refactor plan (step 3, built under FEAT-391)

Ordered so the cheapest wins for a reader come first, one area per PR. Four kinds of PR, each with its proof:

- **Dedupe**: copies replaced by one helper. Proof as a move.
- **Move**: files to folders, imports updated, nothing edited inside. Proof, game: CI's physics and synth-pack checks pass and `render-budgets` matches `main`, plus `tsc`. Pipeline: `python -m pytest pipeline/tests`; then synth and Vail built on Drew's PC from `main` and from the branch give the same `tools/ci/pack_content_key.py` key (it hashes the pack leaving out `meta.json`'s stamps) and no folder differs in `tools/pack_bytes.py` (FEAT-389's per-folder compare), and build times within the run-to-run spread (two runs each).
- **Split**: one file into a folder of modules, code moved verbatim. Proof as a move.
- **Comment pass**: rules 1, 2 and 9 applied to one area, history moved to the card or `docs/research/` first (rule 3). Proof: rule 13.

Two PRs in the same area go in order; PRs in different areas can run in parallel worktrees.

### Game

| # | Kind | Area | What moves where | Extra proof |
|---:|---|---|---|---|
| G1 | dedupe | math and UI helpers | `core/math.ts` (`clamp01`, `smoothstep`), `core/geom2d.ts` (`segDist`, `pointInPoly`, `polyLength`), `ui/esc.ts` for all 8 copies, `ui/format.ts` (one function per time format), the rig weight helpers shared by `Monster.ts` and `RiderRig.ts`. Only copies identical after renaming. About 80 lines fewer. | none |
| G2 | split | FEAT-359: `world/Vegetation.ts` | `world/trees/vegetation/`: `reach.ts` (LOD and reach settings and setters), `cells.ts` (cell records, loading, stand stems), `nearSets.ts` (near LODs and culling), `farPack.ts` (impostor packing), `queries.ts` (`trunkAt`, `forEachTree`, `crownContact`, burial, `setSolid`), `Vegetation.ts` (the class and `update`) | `standcheck`, `clumpcheck`, `treefadecheck` |
| G3 | split | FEAT-359: `world/trees/clumps.ts` | `world/trees/clumps/`: `standMix.ts`, `patch.ts`, `clumps.glsl.ts`, `bake.ts`, `ClumpCanopy.ts`. Closes #820 with G2. | `clumpcheck` |
| G4 | split | `terrain/TerrainMaterial.ts` | `terrain/material/`: `uniforms.ts`, `terrain.glsl.ts` (each patch a named export), `TerrainMaterial.ts` (the factory, under 100 lines). Shader strings come out character for character. | CI's shader compile check; the patched shader source from `onBeforeCompile` identical to `main`'s (a one-off dump) |
| G5 | split | `pack/treeLines.ts` | `pack/treeLines/`: `constants.ts`, `geometry.ts`, `plan.ts`, `TreeLines.ts` | `treelinecheck` output identical to `main`'s on synth and on one fixed Vail pack kept for both sides, not whatever `npm run get vail` serves that day (FEAT-389's seeds card moves Vail's lines; Vail fails one check on `main` today, BUG-182 #878, so "passes" is not the bar) |
| G6 | move + dedupe | pack tile sets | the six tile files to `pack/tiles/`, and one tiled-set base for `HeightSet` / `MaskSet` (`request`, `key`, `contains`) | `packcachecheck`; `tileperf` on Drew's GPU |
| G7 | split | `session/Session.ts` | one module per section marker (spawn, sun clock, settings application, modes, news, menu, scene, frame), with a typed session context in place of the closure's shared locals. The riskiest split: closure variables become parameters. | `statecheck`, `menucheck`, `ridecheck`; a Vail load on Drew's PC |
| G8 | move | `world/` | the subfolders of the target layout | none |
| G9 | move + split | `ui/` | the subfolders; `SettingsOverlay.ts` binding capture and search to `ui/settings/` | `menucheck`, `accountmenucheck` |
| G10 | move | `sim/` | `input/`, `lift/`, `ground/`, `challenges/` | none beyond the physics checks |
| G11 | split | `audio/Audio.ts` | `Music.ts`, `Sfx.ts`, `Audio.ts` as the mixer | a headed listen on Drew's PC (no check covers sound) |
| G12 | split | `terrain/Terrain.ts`, `world/trees/generate.ts` | `chunkBuild.ts`, `proceduralForest.ts`; `world/trees/geometry/` (builder and shapes, plans, LODs) | `standcheck` |
| G13 | move | `game/tools/` | the tools layout, every path in workflows, docs, skills and `package.json` updated in the same PR. MapPacker calls several of these tools by path (see [Cross-repo](#cross-repo)), so a MapPacker PR that finds each at its old or new path merges first | CI runs every check from its new path; MapPacker's `render-budgets` and a `build_resort.py` `attract` run find the moved tools |
| G14 to G20 | comment pass | one per area: `sim/` (first `rider/tuning.ts` and `Rider.ts`), `world/trees/`, `terrain/`, `pack/`, `session/` with `states/` and `core/`, `ui/`, the rest of `world/` | rule 13 |
| G21 | comment pass | `game/tools/` and `tools/` | tools aren't bundled, so rule 13 doesn't apply: `node --check` and CI's checks |

### Pipeline

| # | Kind | Area | What moves where | Extra proof |
|---:|---|---|---|---|
| P1 | dedupe | shared helpers | the `shared/` package: `mathx.smoothstep`, `packread` (`read_mask`, `read_heights`), `jsonio.load_json`, `geom.inside`; callers outside `build_pack.py` switch to them (the cat-track rules and the lift-top flag against traffic's release stay out: they differ in behaviour, FEAT-389 follow-ups); `paths.py` and `retry.py` move in, `pipeline/paths.py` stays as an entry because workflows call it | none |
| P2 | move | `forest/` | `species`, `stands`, `cover`, `canopy`, `canopy_spots`, `far_trees`, `treeline`, `widths`; their tests to `tests/forest/` | none |
| P3 | move | `building/` (not the stages) | `packwriter`, `relocate`, `terrain_ao`, `coarse_set`, `piste_dir`, `moguls`, `lift_towers`, `straightness`, `naip_calib`, `placenames`; `synth_pack.py` stays an entry | none |
| P4 | split | `routes/` | `tree_lines.py` to `routes/tree_lines/` (cost field, tracing, export, with `Planner` broken along those lines), `traffic.py` to `routes/traffic/` (field, tiles) | `treeLines.json` and `traffic/` byte-identical on Vail |
| P5 | split | `build_resort.py` | `running/build_resort/`: `cache.py`, `stages.py` (the inputs / present / run triples), `decide.py` | `build_resort.py vail` on an unchanged raw folder skips the same stages |
| P6 | split | `resort.py` | `planning/`: `search`, `osm`, `hosts`, `dataplan`, `mvt`, `planreport`, `compare`, `prompts`, `add`; `resort.py` stays the CLI | `SBA_NETWORK=1` pytest; `resort.py plan vail` writes a byte-identical config and plan |
| P7 | move + split | the rest of `planning/`, and `fetching/` | `tiers`, `tier_sources`, `ept_select`, `gen_manifest`; `published.py` to `planning/published/` (parse, compare, write); the fetch scripts and OSM filters; `.cmd` launchers and workflows updated | `gen_manifest.py vail` writes a byte-identical manifest |
| P8 | split | `pack_report.py` | `checks/pack_report/`: readers to `shared/packread`, run geometry, tree density, one module per checklist group, `Report` as the table | `pack_report.py packs/vail` byte-identical report |
| P9 | split | `gen_content.py` | `content/`: `start`, `shots`, `files` | Vail's start and menu shots byte-identical |
| P10 | split + move | `publishing/` | `publish_pack`, `publish_check`, `publish_merge` (the pure decision apart from the GitHub calls), `release_zip`, `releases` | pytest (`test_publish_merge.py` covers the decision) |
| P11 | split | `build_pack.py` | P11.0 deletes the dead `piste_polys` and `snowfield` (proof as a move). P11.1 to P11.7 are [FEAT-389's "PRs in order"](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/blob/issue-255-build-order/docs/research/build-order.md#prs-in-order-p111-to-p117-each-a-pure-move-feat-391), in its order, into `building/stages/` ([reconciled above](#reconciled-with-feat-389)). P11.8 swaps the hand-written `del`s for the runner's freeing by declaration: not a move, proved by the same key and a Vail build's peak memory against `main`'s | as FEAT-389 gives per PR; stage 8's PR also compares `trees/`, `stands/`, `shrubs/`, `rocks/` |
| P12 to P17 | comment pass | one per package: `forest/`, `routes/`, `planning/`, `checks/` with `content/`, `publishing/` with `running/` and `tools/ci/`, then `building/` (P17, after P11: `build_pack.py`'s 116 card ids move with the stages); module docstrings over 6 lines moved to `docs/` first | rule 13 (AST) |

### Order across both repos

1. The rules into `CLAUDE.md` and the lean skill (step 2: two PRs, game and MapPacker) once Drew agrees, so the refactor PRs follow them.
2. G1 and P1: the smallest PRs, and the later splits import from them.
3. G2 and G3 (FEAT-359): the only file over the cap.
4. The splits, by how often each area is edited: G4, G5, P4, P5, P6, G7, P8, then the rest.
5. The folder moves (G8 to G10, G13, P2, P3, P7, P10) after their big files are split, so a file moves once.
6. P11 once FEAT-389's document is approved, after P1 (P11.1 imports `shared/geom.to_local`) and beside the rest: it touches only `build_pack.py` and `building/stages/`, and a later move of a domain module updates the stage's import. FEAT-389's behaviour cards (rough traffic at 7b, the mogul term, the tree line seeds, stage 12 in parallel) follow it.
7. The comment passes last in each area, after its moves, so git's rename detection keeps the history readable and the passes cut text that is already in its final place.

38 numbered PRs (game G1 to G21, pipeline P1 to P17, each comment pass one PR); with P11 as its 9 PRs (P11.0 to P11.8), 46 PRs, plus the two rules PRs. The first three: **G1** (game helpers), **P1** (pipeline `shared/`), **G2** (FEAT-359, `Vegetation.ts`).

## Cross-repo

What one repo's plan changes for the other. None changes the pack format (`PACK_FORMAT` / `FORMAT_VERSION`); the ones marked **look** change what a rider sees on a rebuilt pack.

From FEAT-389 ([#263](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/pull/263)) to the game:

- **Old tracks (FEAT-380), look.** `terrain/oldTracks.ts` draws from the pack's `traffic/` layer, read through `pack/MaskSet.ts`. The tree line seeds from 7b change 68 of Vail's 144 traffic tiles (traffic follows the tree lines), so the tracks move where the lines moved. G6 (one tiled-set base for `HeightSet` / `MaskSet`) touches that reader; its proof should load a pack with `traffic/`.
- **Moguls, look.** `terrain/Moguls.ts` draws `moguls/`; `pack/types.ts` and `ui/ResortMap.ts` read `features.json` `mogulScore`. The traffic term moves 48 of Vail's 121 scores and 39 tiles. `mogulcheck.mjs` runs on synth in CI; a Vail run after that card is what shows the change.
- **Tree lines, look.** `pack/treeLines.ts` `takeBaked` reads `treeLines.json` (FEAT-334) and the game moves its stems out of the trenches, so new seeds move near trees though `trees/` and `stands/` stay byte-identical. G5 splits this file; it must land independent of the seed card (G5 is a move, proven on a fixed pack). The game's own planner (`planRuns`, G5's `plan.ts`) is the fallback for packs without `treeLines.json` and does not follow the seeds; whether it can go once every published pack has baked lines is a question for Drew, not part of G5.
- **`treelinecheck.mjs` on Vail.** Fails "the piles ease up, never a wall" on `main` today: BUG-182, [#878](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/878). G5's proof is "same output as `main`", not "passes"; #263's tree line checks use it the same way.
- **Per-stage timings (`meta.json` `buildStages`).** A new top-level field in `publish_pack.STAMPS`, not under `meta.build` (a string the game keys saved resort data and menu stills on). The game doesn't read it and the content key leaves it out, so no format change.
- **Refresh and republish.** Move PRs leave every content key unchanged, so they need no Refresh packs run and publish nothing. FEAT-389's three behaviour cards change nearly every pack's key: one refresh after all three, not one per card, and a synth republish that moves the render budgets the game's CI keys on.

From this plan to the game:

- **Pipeline module paths named in game code.** 15 game files point at pipeline modules in comments (`pack/treeLines.ts`, `tools/treelinecheck.mjs` name `pipeline/tree_lines.py`; `world/trees/stands.ts`, `widths.ts`, `clumps.ts` name `stands.py`, `species.py`, `widths.py`; `format.ts`, `get_pack.mjs` name `packwriter.py`). P2 to P4 move those modules; the game's comment passes (G14 to G20) update the pointers, or the P PR lists them for the game. Entry scripts stay put, so `tools/resort_build_routes.mjs`'s `python pipeline/resort.py search` call keeps working.

From this plan to MapPacker:

- **Game files the contract reads.** `pipeline/contract.py` reads `game/src/pack/format.ts`, `pack/treeline.ts`, `world/trees/species.ts` and `world/trees/widths.ts` by path. The game layout above keeps all four where they are; any later game PR that moves one needs the MapPacker change first, or both together.
- **Game tools MapPacker runs.** `build_resort.py` (`GAME_TOOL`: `game/tools/auto_attract.mjs`, `tools/propose_spots.py`), `resort.py` `ride` (`game/tools/shoot.mjs`), `checks.yml` and `tools/ci/render_budgets_lib.mjs` (`tools/cishot.mjs`, the game's `tools/ci/render_report.py`), `format-check` (`get_pack.mjs`), and `build-pack.yml`'s job name that `build_progress.mjs` reads. G13 moves the first five; the MapPacker side lands first (G13's row).
- **Mirrored formulas.** `world/trees/stands.ts`, `widths.ts` and `species.ts` mirror `stands.py`, `widths.py` and `species.py` across the two languages. Rule 8's "one home" holds within a repo; across repos the pair stays, held by `contract.py`, and a split on either side keeps the mirrored function whole.

## Method, scripts and what was not measured

Scripts (in the session's scratch folder, not the repo):
- `ts_metrics.cjs` parses each `.ts` and `.mjs` file with the TypeScript compiler (the game's `node_modules/typescript` 5.9). A line is code if any token touches it (template literals, so shader strings, count as code), else comment, else blank. It records comment blocks (runs of comment-only lines), card ids in comments and each function's token stream with identifiers renamed by position.
- `py_metrics.py` does the same for Python with `tokenize` and `ast`; docstrings count as comments. It also counts module-level code lines.
- `dups.py` groups functions identical after renaming (25 tokens or more), pairs near-matches at 90% (`difflib`), and lists names defined in two or more files.
- `report.py` writes the tables. Pattern counts (inline clamps, `json.load`, `sys.path`, history words, tool paths named in docs and workflows) are `grep`s.

Worth keeping: the metrics and duplicate scripts as one tool (say `tools/code_stats/`), for re-running these numbers and for the lean skill to check rules 1, 2, 4, 5 and 8 on a diff. Proposed as the first commit of FEAT-391, not added here, since this card changes no code.

Not measured:
- **Jobs per file** is judgement from each big file's outline (top-level declarations and methods), not a metric.
- **Duplicates written differently**: the token match finds copies, not the same idea in other words (dispose loops and inline clamps were counted by `grep` instead). Python near-matches came out empty at 90%, which may be the coarse `ast.dump` tokens rather than none existing.
- **Performance and output baselines** for the plan (GPU frame cost, render budgets, pipeline build time, pack keys): each PR measures its own before and after; nothing was run here.
- **Shell and PowerShell** (`fetch.ps1`, `fetch_static.ps1`, `tools/pc-runner/*.ps1`, `.sh`) and workflow YAML are left out of the counts.
- **Tests** were measured but not ranked: MapPacker's 51 test files are 10,900 lines, two over 600 (`test_publish_merge.py` 914, `test_resort_plan.py` 611); the game's tests are the `*check.mjs` tools, counted with the tools.
- **Comment quality** beyond card ids, history words and block length: whether a comment retells the code needs a reader. The examples under finding 1 come from reading, not a count.

## Appendix: per-file numbers

Lines by `wc -l`. Code and comment lines as defined above; ratio is comment / code; the longest comment block is a run of comment-only lines, with the line it starts on.

### Game `game/src` (TypeScript, 300 lines and up)

| File | Lines | Code | Comment | Ratio | Card ids | Longest comment block |
|---|---:|---:|---:|---:|---:|---|
| `game/src/world/Vegetation.ts` | 1,088 | 843 | 214 | 0.25 | 109 | 24 lines at 19 |
| `game/src/world/trees/clumps.ts` | 951 | 780 | 137 | 0.18 | 7 | 29 lines at 12 |
| `game/src/pack/treeLines.ts` | 869 | 620 | 210 | 0.34 | 29 | 29 lines at 3 |
| `game/src/terrain/TerrainMaterial.ts` | 716 | 627 | 83 | 0.13 | 26 | 52 lines at 10 |
| `game/src/terrain/Terrain.ts` | 706 | 528 | 148 | 0.28 | 69 | 7 lines at 38 |
| `game/src/ui/SettingsOverlay.ts` | 667 | 591 | 46 | 0.08 | 17 | 7 lines at 15 |
| `game/src/world/trees/generate.ts` | 655 | 537 | 88 | 0.16 | 25 | 16 lines at 5 |
| `game/src/audio/Audio.ts` | 633 | 501 | 108 | 0.22 | 37 | 19 lines at 19 |
| `game/src/session/Session.ts` | 565 | 462 | 83 | 0.18 | 74 | 3 lines at 165 |
| `game/src/world/Tracks.ts` | 556 | 388 | 149 | 0.38 | 49 | 31 lines at 10 |
| `game/src/sim/Rider.ts` | 547 | 343 | 177 | 0.52 | 82 | 22 lines at 24 |
| `game/src/world/RiderRig.ts` | 535 | 421 | 87 | 0.21 | 15 | 9 lines at 5 |
| `game/src/world/trees/materials.ts` | 533 | 436 | 80 | 0.18 | 22 | 16 lines at 9 |
| `game/src/world/Lifts.ts` | 526 | 428 | 69 | 0.16 | 15 | 7 lines at 10 |
| `game/src/ui/ResortMap.ts` | 509 | 437 | 51 | 0.12 | 11 | 7 lines at 7 |
| `game/src/sim/Outrun.ts` | 502 | 398 | 80 | 0.20 | 6 | 12 lines at 8 |
| `game/src/audio/Jukebox.ts` | 498 | 429 | 45 | 0.10 | 2 | 13 lines at 2 |
| `game/src/world/ChaseCamera.ts` | 491 | 332 | 134 | 0.40 | 47 | 8 lines at 21 |
| `game/src/ui/MountainView.ts` | 472 | 373 | 67 | 0.18 | 2 | 8 lines at 13 |
| `game/src/terrain/Moguls.ts` | 467 | 334 | 113 | 0.34 | 28 | 44 lines at 1 |
| `game/src/world/Buildings.ts` | 435 | 337 | 84 | 0.25 | 20 | 9 lines at 58 |
| `game/src/states/RideFrame.ts` | 434 | 319 | 90 | 0.28 | 55 | 6 lines at 323 |
| `game/src/ui/ResortPicker.ts` | 433 | 295 | 107 | 0.36 | 31 | 23 lines at 5 |
| `game/src/world/Monster.ts` | 426 | 347 | 58 | 0.17 | 8 | 12 lines at 10 |
| `game/src/pack/Pack.ts` | 409 | 271 | 105 | 0.39 | 49 | 7 lines at 153 |
| `game/src/sim/Collider.ts` | 406 | 305 | 77 | 0.25 | 18 | 7 lines at 256 |
| `game/src/world/RiderView.ts` | 402 | 280 | 98 | 0.35 | 47 | 7 lines at 22 |
| `game/src/world/Shrubs.ts` | 385 | 305 | 60 | 0.20 | 5 | 21 lines at 9 |
| `game/src/world/LiftLines.ts` | 375 | 282 | 70 | 0.25 | 10 | 16 lines at 7 |
| `game/src/world/trees/textures.ts` | 362 | 306 | 33 | 0.11 | 1 | 13 lines at 3 |
| `game/src/ui/MainMenu.ts` | 355 | 299 | 39 | 0.13 | 14 | 7 lines at 58 |
| `game/src/world/Clouds.ts` | 342 | 298 | 32 | 0.11 | 4 | 14 lines at 4 |
| `game/src/sim/rider/tuning.ts` | 334 | 102 | 220 | 2.16 | 74 | 12 lines at 79 |
| `game/src/world/Landmarks.ts` | 329 | 247 | 66 | 0.27 | 9 | 9 lines at 6 |
| `game/src/sim/Boundary.ts` | 326 | 266 | 40 | 0.15 | 2 | 15 lines at 3 |
| `game/src/world/Rocks.ts` | 320 | 248 | 58 | 0.23 | 20 | 11 lines at 97 |
| `game/src/ui/ReleaseToast.ts` | 315 | 219 | 72 | 0.33 | 20 | 35 lines at 5 |
| `game/src/ui/PauseMenu.ts` | 313 | 268 | 30 | 0.11 | 5 | 8 lines at 38 |
| `game/src/world/Spray.ts` | 311 | 232 | 64 | 0.28 | 14 | 17 lines at 5 |
| `game/src/world/TreeBrush.ts` | 302 | 202 | 80 | 0.40 | 1 | 24 lines at 5 |

### Game tools (`.mjs`, 300 lines and up)

| File | Lines | Code | Comment | Ratio | Card ids | Longest comment block |
|---|---:|---:|---:|---:|---:|---|
| `game/tools/ghost_lines.mjs` | 615 | 517 | 82 | 0.16 | 1 | 32 lines at 1 |
| `game/tools/menucheck.mjs` | 564 | 485 | 70 | 0.14 | 11 | 7 lines at 1 |
| `game/tools/ghost_lines/page.mjs` | 478 | 400 | 65 | 0.16 | 2 | 16 lines at 96 |
| `game/tools/ghost_lines/image.mjs` | 450 | 367 | 69 | 0.19 | 1 | 9 lines at 313 |
| `game/tools/get_pack.mjs` | 438 | 336 | 78 | 0.23 | 22 | 18 lines at 1 |
| `game/tools/mogulcheck.mjs` | 403 | 333 | 61 | 0.18 | 18 | 9 lines at 1 |
| `game/tools/releasecheck.mjs` | 389 | 329 | 38 | 0.12 | 5 | 10 lines at 1 |
| `game/tools/compare.mjs` | 349 | 292 | 46 | 0.16 | 5 | 28 lines at 1 |
| `game/tools/accountcheck.mjs` | 344 | 316 | 13 | 0.04 | 7 | 5 lines at 1 |
| `game/tools/lipcheck.mjs` | 340 | 241 | 85 | 0.35 | 7 | 21 lines at 1 |
| `game/tools/aircheck.mjs` | 337 | 281 | 48 | 0.17 | 1 | 23 lines at 1 |
| `game/tools/buildprogresscheck.mjs` | 312 | 279 | 20 | 0.07 | 1 | 7 lines at 1 |
| `game/tools/treelinecheck.mjs` | 309 | 254 | 40 | 0.16 | 9 | 17 lines at 1 |
| `game/tools/playperf.mjs` | 307 | 265 | 37 | 0.14 | 5 | 19 lines at 1 |
| `game/tools/padcheck.mjs` | 303 | 265 | 32 | 0.12 | 6 | 15 lines at 1 |
| `game/tools/launcher.mjs` | 301 | 232 | 49 | 0.21 | 11 | 17 lines at 1 |

### MapPacker `pipeline/` and `tools/ci/` (Python, 300 lines and up, tests left out)

| File | Lines | Code | Comment | Ratio | Card ids | Longest comment block |
|---|---:|---:|---:|---:|---:|---|
| `pipeline/resort.py` | 1,857 | 1,452 | 173 | 0.12 | 35 | 30 lines at 1 |
| `pipeline/build_pack.py` | 1,581 | 1,249 | 252 | 0.20 | 116 | 22 lines at 1 |
| `pipeline/pack_report.py` | 1,057 | 850 | 102 | 0.12 | 35 | 25 lines at 1 |
| `pipeline/tree_lines.py` | 962 | 780 | 146 | 0.19 | 8 | 54 lines at 1 |
| `pipeline/build_resort.py` | 879 | 596 | 118 | 0.20 | 50 | 50 lines at 1 |
| `pipeline/gen_content.py` | 832 | 642 | 97 | 0.15 | 11 | 39 lines at 1 |
| `pipeline/published.py` | 798 | 605 | 92 | 0.15 | 10 | 29 lines at 1 |
| `pipeline/traffic.py` | 726 | 605 | 79 | 0.13 | 3 | 45 lines at 1 |
| `pipeline/cover.py` | 673 | 466 | 140 | 0.30 | 47 | 25 lines at 1 |
| `pipeline/publish_merge.py` | 671 | 496 | 84 | 0.17 | 16 | 26 lines at 1 |
| `pipeline/species.py` | 655 | 404 | 148 | 0.37 | 34 | 15 lines at 80 |
| `pipeline/relocate.py` | 590 | 433 | 87 | 0.20 | 15 | 33 lines at 1 |
| `pipeline/publish_pack.py` | 550 | 389 | 90 | 0.23 | 25 | 44 lines at 1 |
| `tools/ci/probe_hosts.py` | 492 | 355 | 70 | 0.20 | 12 | 31 lines at 1 |
| `tools/ci/build_pack_ci.py` | 439 | 315 | 74 | 0.23 | 24 | 33 lines at 1 |
| `tools/ci/build_failures.py` | 411 | 315 | 42 | 0.13 | 4 | 19 lines at 1 |
| `pipeline/far_trees.py` | 391 | 292 | 61 | 0.21 | 13 | 22 lines at 1 |
| `tools/ci/raw_cache.py` | 375 | 258 | 68 | 0.26 | 10 | 45 lines at 1 |

