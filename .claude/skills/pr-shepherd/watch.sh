#!/usr/bin/env bash
# pr-shepherd watcher (FEAT-324, FEAT-326). Polls main and the open PR list of
# every repo in repos.sh (the game and MapPacker) and exits, printing what
# changed, when a main moves or an open PR closes, so a background run wakes
# the coordinator. A newly opened PR does not wake it (in the first live run,
# PRs opening were the only false wakes); it joins the watched list and shows
# in the next report. Usage: bash watch.sh [interval-s] [max-minutes]
# A failed gh call (network blip, rate limit) skips that poll instead of
# counting as a change; an empty list from a successful call is real (every
# PR closed) and does count.
interval=${1:-60}
max=${2:-240}
. "$(dirname "$0")/repos.sh"
main_sha() {
  local out
  out=$(gh api "repos/$1/commits/main" -q .sha 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}
open_prs() {
  local out
  out=$(gh pr list -R "$1" --state open --limit 100 --json number -q '.[].number' 2>/dev/null) || return 1
  printf '%s' "$out" | sort -n | tr '\n' ' '
}
declare -A REPO M P M0 P0 OPENED CLOSED
tags=""
while IFS='|' read -r tag repo path; do REPO[$tag]=$repo; tags="$tags$tag "; done < <(repo_lines)
# One poll of every repo into M and P; fails if any gh call failed.
poll() {
  local t
  for t in $tags; do
    M[$t]=$(main_sha "${REPO[$t]}") || return 1
    P[$t]=$(open_prs "${REPO[$t]}") || return 1
  done
}
deadline=$(( $(date +%s) + max * 60 ))
# Baseline: retry until every call succeeds, so a failed first poll can't make
# every later one look like a change.
until poll; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "TIMEOUT: gh never answered in $max minutes"; exit 1; }
  echo "gh failed; retrying in ${interval}s" >&2
  sleep "$interval"
done
for t in $tags; do M0[$t]=${M[$t]}; P0[$t]=${P[$t]}; OPENED[$t]=""; echo "watching $t ${REPO[$t]}: main=${M[$t]} open=[${P[$t]}]"; done
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  poll || continue  # gh failed: try again next poll
  changed=""
  for t in $tags; do
    CLOSED[$t]=""
    for n in ${P0[$t]}; do case " ${P[$t]} " in *" $n "*) ;; *) CLOSED[$t]="${CLOSED[$t]}$n ";; esac; done
    for n in ${P[$t]}; do case " ${P0[$t]} " in *" $n "*) ;; *) OPENED[$t]="${OPENED[$t]}$n ";; esac; done
    if [ "${M[$t]}" != "${M0[$t]}" ] || [ -n "${CLOSED[$t]}" ]; then changed="$changed$t "; fi
  done
  if [ -n "$changed" ]; then
    echo "CHANGED: $changed"
    for t in $tags; do
      [ "${M[$t]}" != "${M0[$t]}" ] && mv="moved" || mv="same"
      echo "$t main ($mv): ${M0[$t]} -> ${M[$t]}"
      echo "$t closed: [${CLOSED[$t]}]  opened: [${OPENED[$t]}]  open now: [${P[$t]}]"
    done
    exit 0
  fi
  for t in $tags; do P0[$t]=${P[$t]}; done  # absorb new PRs quietly
done
echo "TIMEOUT: nothing changed in $max minutes"
for t in $tags; do echo "$t main=${M0[$t]} open=[${P0[$t]}] opened=[${OPENED[$t]}]"; done
