---
name: pr-shepherd
description: Keep every open PR mergeable while Drew merges them one after another. Sends a background agent to each PR with a problem (merge conflicts with main, failing checks), then watches main and sends agents again whenever a merge leaves a still-open PR conflicting. Use when Drew says "shepherd the PRs", "keep the PRs mergeable", "resolve conflicts as I merge", "babysit the open PRs" or calls /pr-shepherd.
---

# PR shepherd (FEAT-324)

Drew merges open PRs one at a time. Each merge can leave the others conflicting with `main`. This skill keeps them all green so he never waits on a conflict.

You are the **coordinator**. You do not resolve conflicts yourself; one background agent per PR does, and you keep it busy. The agents follow the **Agent brief** below; point them at this file instead of retyping it.

## Coordinator loop

1. **Survey.** `gh pr list --state open --json number,title,headRefName,isDraft,mergeable` (run it twice if `mergeable` comes back `UNKNOWN`: GitHub computes it lazily). For each PR also read failing checks: `gh pr view N --json statusCheckRollup -q '[.statusCheckRollup[] | select(.conclusion=="FAILURE") | .name]'`. Map each PR to its worktree with `git worktree list` (the branch is `issue-<n>-<slug>`).
2. **Dispatch.** Spawn one background agent (general-purpose) per PR that is `CONFLICTING` or has a failed check, all in one message so they run at once. The Agent tool can't name an agent, so keep a table of PR number to the agent ID each launch result returns; that ID is what `SendMessage` takes later. Prompt: "You are the pr-shepherd agent for PR #N (branch B, worktree W). Read `.claude/skills/pr-shepherd/SKILL.md` > Agent brief and follow it." A clean PR gets no agent until it needs one. Tell Drew which PRs got agents and which were already clean.
3. **Watch.** Start `bash .claude/skills/pr-shepherd/watch.sh 60 240` with `run_in_background`. It exits when `main` moves or the open PR list changes, printing what changed. Do not poll it; you are woken when it exits.
4. **React.** When it wakes you:
   - A PR that closed or merged drops out. If its agent is still working, stop it.
   - If `main` moved, re-survey the PRs still open. GitHub recomputes `mergeable` after a merge and returns `UNKNOWN` until it has, so survey again while any PR is `UNKNOWN` (no `sleep`: the session blocks it, and the extra `gh` calls take long enough); one still `UNKNOWN` after three surveys gets its agent anyway, which merges `main` and finds out itself. For each one now `CONFLICTING`: `SendMessage` to its agent (by the ID in your table) "main moved to <sha>; check for conflicts again per the brief", or spawn one if it has none.
   - Restart `watch.sh`. On `TIMEOUT` with exit 0 (nothing changed), restart it too, unless Drew has gone quiet for hours (then ask whether to keep going). Exit 1 means `gh` never answered: tell Drew (`gh auth status`, network) instead of restarting.
5. **Stop** when no PRs are left open or Drew says stop: stop the watcher (TaskStop), let running agents finish, and summarise each PR's state (merged, mergeable, still blocked and why).

Report each event in a line or two: "#704 conflict after #702 merged; agent resolving", "#689 pushed a1b2c3d, mergeable". Relay anything an agent couldn't settle as a question for Drew.

Don't touch the main checkout (other sessions keep uncommitted work there), and leave `spotify-private` alone (CLAUDE.md: Drew merges it himself).

## Agent brief

You own one PR. Work only in its worktree; never in the main checkout or another PR's worktree.

1. **Find or make the worktree.** `git worktree list` shows the one on the PR's branch. If none exists: `git worktree add ../wt<issue> <branch>`, where `<issue>` is the issue number in the branch name `issue-<issue>-<slug>` (not the PR number; for #727 on `issue-726-pr-shepherd` that is `../wt726`), and `<branch>` is the plain branch name (not `origin/<branch>`), so git makes a local branch that tracks the remote one. Then junction the worktree's `game/node_modules` to `C:\Users\Drew\git\SnowboardAnywhere\game\node_modules` with `New-Item -ItemType Junction`; never junction anything into `packs/`. Check it is clean (`git status`); if it holds someone's uncommitted work, stop and report instead of touching it.
2. **Sync with the PR branch.** `git fetch origin`, then compare `HEAD` with `origin/<branch>`. If the remote is ahead (Drew used "Update branch", or the review bot pushed), `git merge --ff-only origin/<branch>`. If they diverged, stop and report.
3. **Merge main.** `git merge origin/main` (merge, never rebase or force-push). If it conflicts, resolve every file by understanding both sides: read the PR's own diff (`git diff origin/main...HEAD` before the merge) and the main commits that touched the file (`git log origin/main --oneline -5 -- <file>`), and keep both intents. Generated or ordered lists (docs tables, `index.json`, lockfiles) usually want both entries. For `package-lock.json`, take main's and re-run `npm install` in the worktree only if the PR changed `package.json`. Never resolve by dropping the PR's change or main's without saying so in your report.
4. **Check.** `cd game && npx tsc --noEmit`. If the merge touched Python in `tools/`, run its tests too (for example `python tools/test_card_id.py`). Fix what the merge broke; don't refactor beyond it.
5. **Failing checks.** If the PR has a failed check on its head (`gh pr checks <n>`), read the failed job's log (`gh run view <run-id> --log-failed | tail -80`) and fix it if the cause is in the PR or in the merge. If it is flaky or caused by `main` itself, rerun it once (`gh run rerun <run-id> --failed`) and report rather than patch around it.
6. **Push.** Commit the merge with git's default message (add a line naming the card id when you fixed something beyond the conflict). Then, from the worktree with everything committed: if the change touches `game/`, push with `node tools/ci/local_render_budgets.mjs --push` (about 2 minutes on the GPU; it refuses a dirty tree, a `stills` label, or stale `node_modules`). Otherwise a plain `git push origin HEAD:<branch>`. Never push to `main`. Plain commit messages, no `Co-Authored-By` trailer.
7. **Report and stop.** Reply with: PR number, what conflicted and how you resolved each file, checks run, the pushed sha, and anything left for Drew. Then end your turn. The coordinator messages you again when `main` moves; when it does, repeat from step 2 with the same care.

A draft PR is handled the same way; don't mark it ready. If a conflict needs a product decision (both sides changed the same behaviour in incompatible ways), don't guess: leave the branch unpushed, describe the two options, and stop.
