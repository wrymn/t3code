#!/bin/sh
# Rebuilds this fork for an upstream release: merges the fork branch and the
# upstream release tag into a dedicated release worktree, builds the mac app,
# and prints the built .app path. The desktop app runs this from its update
# button (see apps/desktop/src/electron/ForkUpdater.ts).
#
#   scripts/fork-update.sh build <upstream-version>
#
# Output protocol on stdout: "@progress <0-100>", "@app <path>", "@error <msg>".
# Everything else goes to the log file.
#
# Env overrides: T3CODE_FORK_DIR (release worktree), T3CODE_FORK_BRANCH (branch
# holding your changes, default main), T3CODE_FORK_UPSTREAM (remote, default upstream).

# Wrapped in main so the shell parses the whole file before the merge below
# rewrites it on disk.
main() {
  set -u
  command=${1:-}
  version=${2:-}
  if [ "$command" != "build" ] || [ -z "$version" ]; then
    echo "@error usage: fork-update.sh build <upstream-version>"
    exit 2
  fi

  script_repo=$(cd "$(dirname "$0")/.." && pwd)
  common_dir=$(git -C "$script_repo" rev-parse --path-format=absolute --git-common-dir) || fail "Not a git checkout: $script_repo"
  primary_repo=$(dirname "$common_dir")
  fork_dir=${T3CODE_FORK_DIR:-$primary_repo-release}
  fork_branch=${T3CODE_FORK_BRANCH:-main}
  upstream=${T3CODE_FORK_UPSTREAM:-upstream}
  release_branch=fork-release
  tag=v$version

  if [ ! -e "$fork_dir" ]; then
    if git -C "$primary_repo" show-ref --verify --quiet "refs/heads/$release_branch"; then
      git -C "$primary_repo" worktree add "$fork_dir" "$release_branch" >/dev/null 2>&1
    else
      git -C "$primary_repo" worktree add -b "$release_branch" "$fork_dir" "$fork_branch" >/dev/null 2>&1
    fi || fail "Could not create the release worktree at $fork_dir"
  fi
  cd "$fork_dir" || fail "Missing release worktree $fork_dir"
  # Never merge upstream into some other checkout or branch, such as main.
  [ "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" = "$common_dir" ] ||
    fail "$fork_dir is not a worktree of $primary_repo"
  [ "$(git symbolic-ref --short -q HEAD)" = "$release_branch" ] ||
    fail "$fork_dir must have $release_branch checked out"

  mkdir -p release
  lock="$fork_dir/release/fork-update.lock"
  mkdir "$lock" 2>/dev/null || fail "Another fork update is running (remove $lock if not)"
  trap 'rm -rf "$lock"' EXIT INT TERM
  log="$fork_dir/release/fork-update.log"
  : >"$log"

  echo "@progress 2"
  git fetch "$upstream" --tags --quiet >>"$log" 2>&1 || fail "git fetch $upstream failed (log: $log)"
  git rev-parse --verify --quiet "$tag^{commit}" >/dev/null || fail "Upstream tag $tag not found"
  [ -z "$(git status --porcelain)" ] || fail "Release worktree $fork_dir has uncommitted changes"
  # Non-merge commits that are in neither the tag nor the fork branch are newer
  # upstream work; building would label that source with an older version.
  [ -z "$(git rev-list --no-merges -n 1 HEAD "^$tag" "^$fork_branch")" ] ||
    fail "$fork_dir has commits outside $tag and $fork_branch (newer upstream work, or rewritten $fork_branch history)"

  echo "@progress 5"
  merge "$fork_branch"
  merge "$tag"

  echo "@progress 10"
  vp i >>"$log" 2>&1 || fail "vp i failed (log: $log)"

  echo "@progress 20"
  # One directory per version, so a build never replaces an app the desktop
  # app has already offered to install.
  out="$fork_dir/release/fork/$version"
  rm -rf "$out"
  # Progress during the build is approximate: one point per few log lines.
  {
    T3CODE_FORK_SOURCE="$fork_dir" \
      T3CODE_DESKTOP_UPDATE_REPOSITORY="pingdotgg/t3code" \
      node scripts/build-desktop-artifact.ts --platform mac --target zip \
      --arch "$(uname -m | sed 's/x86_64/x64/')" --build-version "$version" --output-dir "$out" 2>&1
    echo "@exit $?"
  } | {
    lines=0
    status=1
    while IFS= read -r line; do
      case "$line" in
        "@exit "*) status=${line#@exit } ;;
        *)
          echo "$line" >>"$log"
          lines=$((lines + 1))
          percent=$((20 + lines / 3))
          [ "$percent" -gt 90 ] && percent=90
          echo "@progress $percent"
          ;;
      esac
    done
    exit "$status"
  } || fail "Build failed (log: $log)"

  echo "@progress 95"
  zip=$(ls "$out"/*.zip 2>/dev/null | head -n 1)
  [ -n "$zip" ] || fail "Build produced no zip (log: $log)"
  extracted="$out/app"
  ditto -x -k "$zip" "$extracted" || fail "Could not extract $zip"
  app=$(ls -d "$extracted"/*.app 2>/dev/null | head -n 1)
  [ -n "$app" ] || fail "No .app inside $zip"

  echo "@progress 100"
  echo "@app $app"
}

fail() {
  echo "@error $1"
  exit 1
}

merge() {
  if ! git merge --no-edit "$1" >>"$log" 2>&1; then
    conflicts=$(git diff --name-only --diff-filter=U | head -n 5 | tr '\n' ' ')
    git merge --abort >/dev/null 2>&1
    fail "Merging $1 conflicts in: $conflicts. Resolve it in $fork_dir (git merge $1), commit, then update again."
  fi
}

main "$@"; exit $?
