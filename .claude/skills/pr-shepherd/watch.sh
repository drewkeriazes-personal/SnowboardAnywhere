#!/usr/bin/env bash
# pr-shepherd watcher (FEAT-324, FEAT-326). Polls main and the open PR list of
# every repo in repos.sh (the game and MapPacker) and exits, printing what
# changed, when a main moves or an open PR closes, so a background run wakes
# the coordinator. A newly opened PR does not wake it (in the first live run,
# PRs opening were the only false wakes); it joins the watched list and shows
# in the next report. Usage: bash watch.sh [interval-s] [max-minutes]
# A failed gh call (network blip, rate limit, a repo the token can't read)
# leaves that repo reading unchanged instead of counting as a change, and the
# other repo is still watched; an empty list from a successful call is real (every
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
declare -A REPO M P M0 P0 OPENED CLOSED BASE FAIL
tags=""
while IFS='|' read -r tag repo path; do REPO[$tag]=$repo; tags="$tags$tag "; done < <(repo_lines)
# One poll of every repo. Each repo stands alone: a repo whose gh call fails
# keeps its last good M/P (so it reads as unchanged) and is named on stderr
# once per outage; the others are still compared. A repo's first good answer
# is its baseline. Returns 0 when at least one repo has a baseline.
poll() {
  local t m p any=1
  for t in $tags; do
    if m=$(main_sha "${REPO[$t]}") && p=$(open_prs "${REPO[$t]}"); then
      M[$t]=$m; P[$t]=$p
      [ -n "${FAIL[$t]}" ] && echo "gh answers for $t (${REPO[$t]}) again" >&2
      FAIL[$t]=""
      if [ -z "${BASE[$t]}" ]; then
        BASE[$t]=1; M0[$t]=$m; P0[$t]=$p; OPENED[$t]=""
        echo "watching $t ${REPO[$t]}: main=$m open=[$p]"
      fi
    elif [ -z "${FAIL[$t]}" ]; then
      FAIL[$t]=1
      echo "gh failed for $t (${REPO[$t]}); keeping its last result and retrying each poll" >&2
    fi
    [ -n "${BASE[$t]}" ] && any=0
  done
  return $any
}
# Repos gh is not answering for, for the reports.
unreachable() {
  local t out=""
  for t in $tags; do
    if [ -z "${BASE[$t]}" ]; then out="$out$t(never answered) "
    elif [ -n "${FAIL[$t]}" ]; then out="$out$t(last poll failed) "; fi
  done
  printf '%s' "$out"
}
deadline=$(( $(date +%s) + max * 60 ))
# Baseline: retry until at least one repo answers; a repo that answers later
# gets its baseline then, so a failed first poll can't look like a change.
until poll; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "TIMEOUT: gh never answered for any repo in $max minutes"; exit 1; }
  sleep "$interval"
done
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  poll
  changed=""
  for t in $tags; do
    [ -n "${BASE[$t]}" ] || continue
    CLOSED[$t]=""
    for n in ${P0[$t]}; do case " ${P[$t]} " in *" $n "*) ;; *) CLOSED[$t]="${CLOSED[$t]}$n ";; esac; done
    for n in ${P[$t]}; do case " ${P0[$t]} " in *" $n "*) ;; *) OPENED[$t]="${OPENED[$t]}$n ";; esac; done
    if [ "${M[$t]}" != "${M0[$t]}" ] || [ -n "${CLOSED[$t]}" ]; then changed="$changed$t "; fi
  done
  if [ -n "$changed" ]; then
    echo "CHANGED: $changed"
    for t in $tags; do
      [ -n "${BASE[$t]}" ] || continue
      [ "${M[$t]}" != "${M0[$t]}" ] && mv="moved" || mv="same"
      echo "$t main ($mv): ${M0[$t]} -> ${M[$t]}"
      echo "$t closed: [${CLOSED[$t]}]  opened: [${OPENED[$t]}]  open now: [${P[$t]}]"
    done
    u=$(unreachable); [ -n "$u" ] && echo "UNREACHABLE: $u"
    exit 0
  fi
  for t in $tags; do [ -n "${BASE[$t]}" ] && P0[$t]=${P[$t]}; done  # absorb new PRs quietly
done
echo "TIMEOUT: nothing changed in $max minutes"
for t in $tags; do [ -n "${BASE[$t]}" ] && echo "$t main=${M0[$t]} open=[${P0[$t]}] opened=[${OPENED[$t]}]"; done
u=$(unreachable); [ -n "$u" ] && echo "UNREACHABLE: $u"
exit 0
