---
name: lean
description: Cut and tighten the current branch before it is pushed. Finds code that does not need to exist, duplicates something already in the repo, or makes the code harder to read, and applies the cuts that keep behavior. Quality and size only; correctness bugs are /code-review's job and the PR bot's. Use when Drew says "lean", "tighten this", "cut this down", "quality pass", "thermo review", or before the first push of any PR that changes code (CLAUDE.md, FEAT-352).
---

# Lean pass

One pass over the branch diff, by you, inline. No subagents unless the diff is over about 800 changed lines (then one Explore agent per top-level folder, each given only its slice of the diff). Read the diff and the files it touches, nothing else unless a rule below sends you there.

## 1. Scope
- `git diff --stat main...HEAD`, then `git diff main...HEAD -- <files>`. Uncommitted work: add `git diff HEAD`.
- Review only added or changed lines. Old code is out of scope unless the change makes it dead or duplicates it.
- Skip docs-only diffs: say so and stop.

## 2. The ladder (for every new function, class, file, option or branch)
Take the first rung that holds and flag the code if a higher rung was available:
1. Does it need to exist? (Not asked for by the card, no caller, "for later".)
2. Is it already in this repo? This rung saves the most: grep for the name and for the idea (a lerp, a clamp, a tile lookup, a dispose loop). Link the existing one.
3. Does three.js, the DOM or the TS standard library already do it?
4. Does an installed dependency do it? (`game/package.json` only; never add one for this.)
5. Can it be a few lines instead of a module?

## 3. Structure checks
- **File size:** a file that crosses 1,000 lines in this diff is a finding. A file already over it (`world/Vegetation.ts`, `world/trees/clumps.ts` today) may grow only by wiring, about 20 lines, with the logic in a new module; past that, split first. Either way, search the board for a split card and file one if none exists (BOARD.md rule 3), so a reason in the PR is never the end of it.
- **Code judo:** a restructure that keeps behavior and removes code (merge two near-copies, replace a flag-driven branch with data, delete a wrapper that only forwards).
- **Spaghetti:** one-off `if` checks for a special case dropped into shared code; a feature's logic leaking into `terrain/`, `pack/` or `sim/` modules that do not own it.
- **Magic:** clever indirection, string-keyed dispatch, or hidden state where a direct call would read plainly.
- **Types:** new `as` casts, `any`, `unknown`, `!` or `?` that hide a real case instead of handling it.
- **Names and numbers:** a bare number with units gets a named constant (`CLUMP_REACH_E`); a name that needs a comment to explain it gets renamed.
- **Comments:** keep the why, cut the what. A known limit taken on purpose gets `// shortcut: <limit>, <when to revisit>` and a board card (BOARD.md rule 3), not just the comment.

## 4. Never cut
Pack loading validation, `dispose()` on unload, fixed-timestep physics, coordinate conversions, error handling that stops silent wrong output, accessibility, or anything the card asked for.

## 5. Apply
- Sort findings: structural regressions, missed code judo, spaghetti, type holes, size, names. Keep at most 8; drop nits a reader would not miss.
- Apply the ones that keep behavior and are local to the diff. Then `cd game && npx tsc --noEmit`. If the change touches rendering, say which `render-check` or `shoot.mjs` stat would prove nothing moved; do not run it unless Drew asks.
- Leave the rest as a list for Drew with the file and line and one line on why.

## 6. Report (short)
```
Lean: -<n> lines (<before> to <after>), <k> cuts applied, <m> left for you.
Applied: <file:line> <what>   (one line each)
Left:    <file:line> <what, why it needs you>
Not checked: <what you skipped, e.g. visuals, MapPacker side>
```
