# pr-shepherd repo list (FEAT-326), sourced by watch.sh and survey.sh.
# One entry per repo: short tag, GitHub repo, main checkout on Drew's PC.
# Override with SHEPHERD_REPOS="tag|owner/repo|path;tag|owner/repo|path".
SHEPHERD_REPOS=${SHEPHERD_REPOS:-"SA|drewkeriazes/SnowboardAnywhere|C:/Users/Drew/git/SnowboardAnywhere;MP|drewkeriazes/MapPacker-SnowboardAnywhere|C:/Users/Drew/git/MapPacker-SnowboardAnywhere"}
repo_lines() { printf '%s\n' "$SHEPHERD_REPOS" | tr ';' '\n' | sed '/^$/d'; }
