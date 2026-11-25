# Code architecture: readable code, lean comments, one job per file (FEAT-390)

Card: FEAT-390, [SnowboardAnywhere#871](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/871) and its twin [MapPacker-SnowboardAnywhere#259](https://github.com/drewkeriazes-personal/MapPacker-SnowboardAnywhere/issues/259). Built by: FEAT-391 ([#872](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/872), MapPacker-SnowboardAnywhere#260). Folded in: FEAT-359 ([#820](https://github.com/drewkeriazes-personal/SnowboardAnywhere/issues/820), the `Vegetation.ts` / `clumps.ts` split). Left to its own document: FEAT-389 (MapPacker-SnowboardAnywhere#255, `docs/research/build-order.md` in MapPacker, the inside of `build_pack.py`).

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
10. **Python modules do nothing on import.** Work happens in functions; a script ends in `if __name__ == "__main__": main()`. No module-level state shared through globals.
11. **A move PR only moves and renames.** Behaviour changes get their own PR and card. A move PR proves nothing changed: game, the physics and synth-pack checks pass and render budgets match `main`; pipeline, synth and Vail packs byte-identical and the same build time.
12. **No performance loss.** Game frame cost by GPU timer queries (`perf-check`), pipeline build time and output bytes. A change that moves either says why in the PR.

(Survey, layouts and the PR plan follow in later commits.)
