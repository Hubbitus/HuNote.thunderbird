#!/usr/bin/env bash
#
# release.sh — one-shot release flow for HuNote.
#
# Steps:
#   1. Detect next version (auto-bump patch of latest vX.Y.Z tag, or honor $1).
#   2. If working tree has changes — create release branch, commit, push,
#      open PR, wait CI green, merge (--merge, no squash), delete branch.
#   3. Fast-forward local main to origin/main.
#   4. Create annotated tag vX.Y.Z on main HEAD, push tag.
#   5. Watch Release workflow until it finishes; print result URL.
#
# Usage:
#   ./release.sh            # auto-bump patch
#   ./release.sh 0.2.0      # explicit version
#   ./release.sh --dry-run  # print plan, no side effects
#
set -euo pipefail

DRY=0
EXPLICIT=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY=1 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) EXPLICIT="$arg" ;;
    esac
done

run() {
    echo "+ $*" >&2
    if [[ $DRY -eq 1 ]]; then return 0; fi
    "$@"
}

# ---------- preconditions ----------
command -v gh >/dev/null || { echo "gh CLI required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != "main" ]]; then
    echo "must be on main (current: $branch)" >&2
    exit 1
fi

run git fetch --tags --prune origin

# ---------- version resolution ----------
if [[ -n "$EXPLICIT" ]]; then
    [[ "$EXPLICIT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 1; }
    NEXT="$EXPLICIT"
else
    last=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
    [[ -n "$last" ]] || { echo "no previous vX.Y.Z tag found" >&2; exit 1; }
    IFS=. read -r maj min pat <<<"${last#v}"
    NEXT="${maj}.${min}.$((pat + 1))"
    echo "last tag: $last → next: v$NEXT"
fi
TAG="v$NEXT"

git rev-parse "$TAG" >/dev/null 2>&1 && { echo "$TAG already exists" >&2; exit 1; }

# ---------- commit dirty tree via PR ----------
dirty=0
git diff --quiet && git diff --cached --quiet || dirty=1
# untracked files that are NOT in .gitignore count as dirty too; test tracked-only here
# (new files require explicit `git add` from the user; script won't guess).

if [[ $dirty -eq 1 ]]; then
    rel_branch="release/$TAG"
    echo ">>> working tree dirty — committing via PR on $rel_branch"
    run git checkout -b "$rel_branch"
    run git add -u
    run git commit -m "chore(release): prepare $TAG

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
    run git push -u origin "$rel_branch"
    pr_url=$(gh pr create --base main --head "$rel_branch" \
        --title "chore(release): prepare $TAG" \
        --body "Release $TAG.

🤖 Generated with [Claude Code](https://claude.com/claude-code)" \
        2>&1 | tail -1)
    echo "PR: $pr_url"
    pr_num=$(basename "$pr_url")

    echo ">>> waiting for CI on PR #$pr_num"
    if [[ $DRY -eq 0 ]]; then
        for i in {1..30}; do
            if gh pr checks "$pr_num" 2>/dev/null | grep -qE '\s(pending|queued|in_progress|completed)\s'; then
                break
            fi
            sleep 2
        done
        gh pr checks "$pr_num" --watch --fail-fast || { echo "CI failed" >&2; exit 1; }
    fi

    run gh pr merge "$pr_num" --merge --delete-branch
    run git checkout main
    run git pull --ff-only origin main
else
    echo ">>> working tree clean — tagging current main HEAD"
    run git pull --ff-only origin main
fi

# ---------- tag + push ----------
run git tag -a "$TAG" -m "Release $TAG"
run git push origin "$TAG"

# ---------- watch release workflow ----------
if [[ $DRY -eq 1 ]]; then
    echo "(dry-run) would watch Release workflow for $TAG"
    exit 0
fi

echo ">>> waiting for Release workflow to appear"
run_id=""
for i in {1..30}; do
    run_id=$(gh run list --workflow=release.yml --event=push --limit=5 \
        --json databaseId,headBranch -q \
        ".[] | select(.headBranch==\"$TAG\") | .databaseId" | head -1 || true)
    [[ -n "$run_id" ]] && break
    sleep 2
done
[[ -n "$run_id" ]] || { echo "release run not found after 60s" >&2; exit 1; }

echo "release run: $run_id"
gh run watch "$run_id" --exit-status || { echo "release workflow failed" >&2; exit 1; }

release_url=$(gh release view "$TAG" --json url -q .url)
echo ""
echo "✓ $TAG released: $release_url"
