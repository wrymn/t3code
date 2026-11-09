#!/bin/sh
# Lists this fork's features (main plus fork/* branches) against upstream:
# which are still active, which upstream already has, and which conflict.
#
# Env override: T3CODE_FORK_UPSTREAM (remote, default upstream).
set -u
upstream=${T3CODE_FORK_UPSTREAM:-upstream}
git fetch "$upstream" --quiet || exit 1
base="$upstream/main"
for branch in main $(git for-each-ref --format='%(refname:short)' 'refs/heads/fork/*'); do
  pending=$(git cherry "$base" "$branch" | grep -c '^+')
  if [ "$pending" -eq 0 ]; then
    state="upstreamed, safe to delete"
  elif git merge-tree --write-tree "$base" "$branch" >/dev/null 2>&1; then
    state="active, $pending commit(s)"
  else
    state="conflicts with $base"
  fi
  printf '%-32s %s\n' "$branch" "$state"
done
