#!/usr/bin/env bash
# pr-shepherd watcher (FEAT-324). Polls origin/main and the open PR list and
# exits as soon as either changes, printing what changed, so a background run
# wakes the coordinator. Usage: bash watch.sh [interval-seconds] [max-minutes]
# A failed gh call (network blip, rate limit) skips that poll instead of
# counting as a change; an empty list from a successful call is real (every
# PR closed) and does count.
interval=${1:-60}
max=${2:-240}
repo=drewkeriazes/SnowboardAnywhere
main_sha() {
  local out
  out=$(gh api "repos/$repo/commits/main" -q .sha 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}
open_prs() {
  local out
  out=$(gh pr list -R "$repo" --state open --json number -q '.[].number' 2>/dev/null) || return 1
  printf '%s' "$out" | sort -n | tr '\n' ' '
}
deadline=$(( $(date +%s) + max * 60 ))
# Baseline: retry until both calls succeed, so a failed first poll can't make
# every later one look like a change.
until m0=$(main_sha) && p0=$(open_prs); do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "TIMEOUT: gh never answered in $max minutes"; exit 1; }
  echo "gh failed; retrying in ${interval}s" >&2
  sleep "$interval"
done
echo "watching: main=$m0 open=[$p0]"
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  m=$(main_sha) && p=$(open_prs) || continue  # gh failed: try again next poll
  if [ "$m" != "$m0" ] || [ "$p" != "$p0" ]; then
    echo "CHANGED"
    echo "main: $m0 -> $m"
    echo "open before: [$p0]"
    echo "open now:    [$p]"
    exit 0
  fi
done
echo "TIMEOUT: nothing changed in $max minutes (main=$m0 open=[$p0])"
