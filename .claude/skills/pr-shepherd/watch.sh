#!/usr/bin/env bash
# pr-shepherd watcher (FEAT-324). Polls origin/main and the open PR list and
# exits as soon as either changes, printing what changed, so a background run
# wakes the coordinator. Usage: bash watch.sh [interval-seconds] [max-minutes]
interval=${1:-60}
max=${2:-240}
repo=drewkeriazes/SnowboardAnywhere
main_sha() { gh api "repos/$repo/commits/main" -q .sha 2>/dev/null; }
open_prs() { gh pr list -R "$repo" --state open --json number -q '.[].number' 2>/dev/null | sort -n | tr '\n' ' '; }
m0=$(main_sha); p0=$(open_prs)
echo "watching: main=$m0 open=[$p0]"
deadline=$(( $(date +%s) + max * 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep "$interval"
  m=$(main_sha); p=$(open_prs)
  [ -z "$m" ] && continue  # network blip: try again
  if [ "$m" != "$m0" ] || [ "$p" != "$p0" ]; then
    echo "CHANGED"
    echo "main: $m0 -> $m"
    echo "open before: [$p0]"
    echo "open now:    [$p]"
    exit 0
  fi
done
echo "TIMEOUT: nothing changed in $max minutes (main=$m0 open=[$p0])"
