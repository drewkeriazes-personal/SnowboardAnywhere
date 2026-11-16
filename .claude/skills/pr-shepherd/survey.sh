#!/usr/bin/env bash
# pr-shepherd survey (FEAT-324, FEAT-326). Lists every open PR in every repo of
# repos.sh (the game and MapPacker) with its mergeable state, failed checks and
# worktree, waiting until GitHub has finished computing `mergeable` (it reads
# UNKNOWN for 20 s or more after each merge to main).
# Usage: bash survey.sh [tries] [seconds-between]   (default 6 x 20 s)
tries=${1:-6}
gap=${2:-20}
. "$(dirname "$0")/repos.sh"
q='.[] | [.number, .mergeable, (if .isDraft then "draft" else "-" end), .headRefName,
  ([.statusCheckRollup[]? | select(.conclusion=="FAILURE" or .conclusion=="TIMED_OUT") | .name] | unique | join(",") | if .=="" then "-" else . end)] | @tsv'
printf 'repo\tPR\tmergeable\tdraft\tbranch\tfailed\tworktree\n'
any_unknown=0
while IFS='|' read -r tag repo path; do
  ok=0
  for i in $(seq 1 "$tries"); do
    if out=$(gh pr list -R "$repo" --state open --limit 100 \
          --json number,mergeable,isDraft,headRefName,statusCheckRollup -q "$q" 2>/dev/null); then ok=1; else ok=0; out=""; fi
    if [ "$ok" = 1 ] && ! printf '%s\n' "$out" | grep -q $'\tUNKNOWN\t'; then break; fi
    [ "$i" -lt "$tries" ] && sleep "$gap"
  done
  main=$(gh api "repos/$repo/commits/main" -q '.sha[0:7] + " " + (.commit.message | split("\n")[0])' 2>/dev/null)
  echo "# $tag $repo main: $main"
  [ "$ok" = 1 ] || { echo "# $tag: gh failed (check gh auth status)"; continue; }
  [ -z "$out" ] && { echo "# $tag: no open PRs"; continue; }
  # Worktree per branch, from that repo's own clone.
  wt=$(git -C "$path" worktree list --porcelain 2>/dev/null | awk '/^worktree /{p=substr($0,10)} /^branch /{sub("refs/heads/","",$2); print $2"\t"p}')
  while IFS=$'\t' read -r n m d b f; do
    w=$(printf '%s\n' "$wt" | awk -F'\t' -v b="$b" '$1==b{print $2; exit}')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$tag" "$n" "$m" "$d" "$b" "$f" "${w:--}"
  done <<< "$out"
  printf '%s\n' "$out" | grep -q $'\tUNKNOWN\t' && any_unknown=1
done < <(repo_lines)
[ "$any_unknown" = 1 ] && echo "still UNKNOWN after $tries tries: treat those as needing an agent"
exit 0
