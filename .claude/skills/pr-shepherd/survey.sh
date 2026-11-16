#!/usr/bin/env bash
# pr-shepherd survey (FEAT-324). Lists every open PR with its mergeable state,
# failed checks and worktree, waiting until GitHub has finished computing
# `mergeable` (it reads UNKNOWN for 20 s or more after each merge to main).
# Usage: bash survey.sh [tries] [seconds-between]   (default 6 x 20 s)
tries=${1:-6}
gap=${2:-20}
repo=drewkeriazes/SnowboardAnywhere
q='.[] | [.number, .mergeable, (if .isDraft then "draft" else "-" end), .headRefName,
  ([.statusCheckRollup[]? | select(.conclusion=="FAILURE" or .conclusion=="TIMED_OUT") | .name] | unique | join(",") | if .=="" then "-" else . end)] | @tsv'
for i in $(seq 1 "$tries"); do
  out=$(gh pr list -R "$repo" --state open --limit 100 \
        --json number,mergeable,isDraft,headRefName,statusCheckRollup -q "$q" 2>/dev/null) || out=""
  if [ -n "$out" ] && ! printf '%s\n' "$out" | grep -q $'\tUNKNOWN\t'; then break; fi
  [ "$i" -lt "$tries" ] && sleep "$gap"
done
main=$(gh api "repos/$repo/commits/main" -q '.sha[0:7] + " " + (.commit.message | split("\n")[0])' 2>/dev/null)
echo "main: $main"
[ -z "$out" ] && { echo "no open PRs (or gh failed: check gh auth status)"; exit 0; }
# Worktree per branch, from git worktree list --porcelain.
wt=$(git worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^branch /{sub("refs/heads/","",$2); print $2"\t"p}')
printf 'PR\tmergeable\tdraft\tbranch\tfailed\tworktree\n'
printf '%s\n' "$out" | while IFS=$'\t' read -r n m d b f; do
  w=$(printf '%s\n' "$wt" | awk -F'\t' -v b="$b" '$1==b{print $2; exit}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$m" "$d" "$b" "$f" "${w:--}"
done
printf '%s\n' "$out" | grep -q $'\tUNKNOWN\t' && echo "still UNKNOWN after $tries tries: treat those as needing an agent"
exit 0
