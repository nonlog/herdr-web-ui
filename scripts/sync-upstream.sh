#!/usr/bin/env bash
# Safe, unattended upstream integration for nonlog/herdr-web-ui.
# Never run upstream scripts with this job's write-capable token.
set -euo pipefail
export LC_ALL=C

if [[ "$GH_REPO" != "nonlog/herdr-web-ui" ]]; then
  echo "Refusing to write to an unexpected repository: $GH_REPO" >&2
  exit 1
fi

sync_branch="automation/upstream-sync"
sync_ref="refs/heads/$sync_branch"
tracking="refs/remotes/origin/$sync_branch"
upstream_url="https://github.com/devswha/herdr-web-ui.git"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git config user.name Codex
git config user.email codex@openai.com
git remote add upstream "$upstream_url"
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
git fetch --no-tags upstream +refs/heads/main:refs/remotes/upstream/main
fork_sha="$(git rev-parse refs/remotes/origin/main)"
upstream_sha="$(git rev-parse refs/remotes/upstream/main)"

if git merge-base --is-ancestor "$upstream_sha" "$fork_sha"; then
  echo "Fork main already includes upstream/main ($upstream_sha)."
  echo "No new upstream commits." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

common="$(git merge-base "$fork_sha" "$upstream_sha")"
if [[ -z "$common" ]]; then
  echo "Upstream has no common ancestor with this fork. Manual review required." >&2
  exit 1
fi

# Require manual review for any file previously customized by the fork, even
# when git's automatic 3-way merge reports no textual conflict.
git diff --name-only "$common" "$fork_sha" | sort -u > "$tmp/fork-paths"
git diff --name-only "$common" "$upstream_sha" | sort -u > "$tmp/upstream-paths"
comm -12 "$tmp/fork-paths" "$tmp/upstream-paths" > "$tmp/overlap"
: > "$tmp/sensitive"
while IFS= read -r file; do
  case "$file" in
    .github/*|AGENTS.md|*/AGENTS.md|package.json|bun.lock|install.ps1|herdr-plugin.toml|scripts/*|server/index.ts|server/codex.ts|server/pi-tree.ts|server/terminal-control.ts|server/native-geometry.ts|shared/protocol.ts|src/App.tsx|src/components/PaneTerminal.tsx|src/components/PaneTerminal.css|src/lib/ws.ts)
      echo "$file" >> "$tmp/sensitive" ;;
  esac
done < "$tmp/upstream-paths"
sort -u "$tmp/sensitive" -o "$tmp/sensitive"

previous=""
if git ls-remote --exit-code --heads origin "$sync_ref" >/dev/null 2>&1; then
  git fetch --no-tags origin "+$sync_ref:$tracking"
  previous="$(git rev-parse "$tracking")"
fi

# A reviewer may have manually resolved the conflict on the PR branch. Do not
# let the next scheduled run silently force-push away that work. The only
# replaceable heads are upstream snapshots or commits authored by this sync.
if [[ -n "$previous" ]]; then
  automation_owned=false
  if git merge-base --is-ancestor "$previous" "$upstream_sha"; then
    automation_owned=true # a previous, unchanged upstream snapshot
  elif git show -s --format=%B "$previous" | grep -qx 'Sync-Generated-By: nonlog/upstream-sync'; then
    automation_owned=true # this script's merge commit
  fi
  if [[ "$automation_owned" != true ]]; then
    echo "The upstream-sync PR branch contains manual commits; preserving it for review."
    echo "Upstream-sync branch has manual commits. Not force-pushing over a reviewer's work." >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
fi

git checkout -B upstream-sync-candidate "$fork_sha"
: > "$tmp/conflicts"
if git merge --no-ff --no-commit "$upstream_sha" > "$tmp/merge.log" 2>&1; then
  mode=clean
  # Reuse a validated, identical candidate rather than pushing a new merge
  # commit every day (which would invalidate CI and PR review each day).
  if [[ -n "$previous" ]] && [[ "$(git show -s --format=%P "$previous")" == "$fork_sha $upstream_sha" ]]; then
    git merge --abort
    git reset --hard "$previous"
  else
    git commit -m "chore: sync devswha/herdr-web-ui $(git rev-parse --short=12 "$upstream_sha")" \
      -m 'Sync-Generated-By: nonlog/upstream-sync'
  fi
else
  git diff --name-only --diff-filter=U > "$tmp/conflicts"
  if [[ ! -s "$tmp/conflicts" ]]; then
    cat "$tmp/merge.log" >&2
    echo "Unexpected upstream merge error without file conflicts." >&2
    exit 1
  fi
  # A PR with the upstream tip as its head shows GitHub's conflict state.
  # NEVER resolve conflicts with -X theirs or overwrite fork-only source.
  git merge --abort
  git reset --hard "$upstream_sha"
  mode=conflict
fi
candidate="$(git rev-parse HEAD)"
updated=false
if [[ "$previous" != "$candidate" ]]; then
  if [[ -n "$previous" ]]; then
    git push "--force-with-lease=$sync_ref:$previous" origin "HEAD:$sync_ref"
  else
    git push origin "HEAD:$sync_ref"
  fi
  updated=true
fi

manual=false
if [[ "$mode" == conflict || -s "$tmp/overlap" || -s "$tmp/sensitive" ]]; then
  manual=true
fi

write_paths() {
  local name="$1"
  local file="$2"
  printf '\n### %s\n\n' "$name"
  if [[ -s "$file" ]]; then
    printf '```text\n'
    head -100 "$file"
    printf '```\n'
  else
    printf 'None.\n'
  fi
}

{
  cat <<EOF
## Automated upstream update

Upstream: devswha/herdr-web-ui (main)
Fork base: $fork_sha
Upstream tip: $upstream_sha
Candidate: $candidate
Merge status: **$mode**
Requires manual review: **$manual**

Every candidate is prepared without discarding fork-only commits.
EOF
  if [[ "$mode" == conflict ]]; then
    printf '\n**Conflict mode:** this PR branch contains the raw upstream tip, not a resolved merge. Do not merge it as-is. Merge fork main into this branch, resolve conflicts preserving fork behavior, and run the complete CI. The scheduled job will never promote this state.\n'
  else
    printf '\n**Clean mode:** the PR branch contains a merge commit with both fork main and upstream main as parents.\n'
  fi
  if [[ "$manual" == true ]]; then
    printf '\n**Review hold:** no automatic promotion. Inspect the overlapping/customized and protected files below, resolve as needed, and validate via CI.\n'
  else
    printf '\n**Eligible for automatic promotion** only after all three required CI jobs pass and fork/upstream/PR heads remain unchanged. No automatic Windows plugin deployment.\n'
  fi
  write_paths "Conflicted paths" "$tmp/conflicts"
  write_paths "Fork-customized paths changed upstream" "$tmp/overlap"
  write_paths "Sensitive paths changed upstream" "$tmp/sensitive"
  cat <<'EOF'

### Verification and merge rules

- CI must pass: Native Windows install, Fast checks, and Integration and browser.
- Never use a conflict-resolution strategy that silently prefers upstream.
- Preserve Windows native terminal control, native geometry, independent ANSI history, semantic Escape, large Pi session paging, and Codex recovery.
- Review docs/fork-features.md before resolving a conflict.
- GitHub-token-created PR events do not automatically trigger other Actions; the sync job explicitly dispatches CI when a clean candidate is new.
EOF
} > "$tmp/pr.md"

pr="$(gh pr list --repo "$GH_REPO" --base main --head "$sync_branch" --state open --json number --jq '.[0].number // empty')"
if [[ -z "$pr" ]]; then
  gh pr create --repo "$GH_REPO" --base main --head "$sync_branch" \
    --title "chore: sync devswha/herdr-web-ui upstream" --body-file "$tmp/pr.md"
  pr="$(gh pr list --repo "$GH_REPO" --base main --head "$sync_branch" --state open --json number --jq '.[0].number // empty')"
else
  gh pr edit "$pr" --repo "$GH_REPO" --body-file "$tmp/pr.md"
fi
if [[ -z "$pr" ]]; then
  echo "Could not locate or create the upstream synchronization PR." >&2
  exit 1
fi
echo "Upstream candidate PR: https://github.com/$GH_REPO/pull/$pr"
{
  echo "Upstream tip: $upstream_sha"
  echo "Candidate PR: https://github.com/$GH_REPO/pull/$pr"
  echo "Mode: $mode; manual review: $manual"
} >> "$GITHUB_STEP_SUMMARY"

if [[ "$mode" == conflict ]]; then
  echo "Merge conflicts recorded in the PR. No code was promoted or built."
  exit 0
fi

# GITHUB_TOKEN-created push/PR events cannot trigger CI themselves.
# Dispatch the full existing workflow against the exact merged candidate.
if [[ "$updated" == true ]]; then
  echo "Dispatching all CI lanes for candidate $candidate."
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh workflow run ci.yml --repo "$GH_REPO" --ref "$sync_branch"
else
  started=""
  echo "No candidate changes; keeping existing PR and test results."
fi

if [[ "$manual" == true ]]; then
  echo "Manual review required. Skipping automatic promotion."
  exit 0
fi

# Automatic promotion is only for clean, non-customized, non-sensitive files.
# A full successful workflow is required even when main has no branch rules.
if [[ "$updated" != true ]]; then
  echo "Unchanged candidate: holding promotion until a fresh validated run."
  exit 0
fi

run_id=""
for _ in $(seq 1 75); do
  list="$(gh run list --repo "$GH_REPO" --workflow ci.yml --branch "$sync_branch" \
    --event workflow_dispatch --limit 20 --json databaseId,headSha,createdAt)"
  run_id="$(jq -r --arg sha "$candidate" --arg since "$started" \
    '[.[] | select(.headSha == $sha and .createdAt >= $since)] | sort_by(.createdAt) | last | .databaseId // empty' <<< "$list")"
  if [[ -n "$run_id" ]]; then break; fi
  sleep 10
done
if [[ -z "$run_id" ]]; then
  echo "Could not identify dispatched CI for $candidate; PR retained." >&2
  exit 1
fi

completed=false
for _ in $(seq 1 95); do
  gh run view "$run_id" --repo "$GH_REPO" --json status,conclusion,headSha,jobs > "$tmp/ci.json"
  if [[ "$(jq -r '.status' "$tmp/ci.json")" == completed ]]; then
    completed=true
    break
  fi
  sleep 20
done
if [[ "$completed" != true ]]; then
  echo "CI did not finish in time; no automatic promotion. PR retained." >&2
  exit 1
fi
if ! jq -e --arg sha "$candidate" '
  .conclusion == "success" and .headSha == $sha and
  ([.jobs[] | select(.conclusion == "success") | .name] |
    index("Native Windows install") != null and
    index("Fast checks") != null and
    index("Integration and browser") != null)
' "$tmp/ci.json" >/dev/null; then
  echo "Required CI lanes did not all pass. PR retained for review." >&2
  exit 1
fi

# An exact fast-forward of the validated merge commit: no second untested
# merge commit, and every automation-authored commit keeps Codex identity.
latest_main="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
latest_upstream="$(git ls-remote upstream refs/heads/main | awk '{print $1}')"
latest_candidate="$(git ls-remote origin "$sync_ref" | awk '{print $1}')"
if [[ "$latest_main" != "$fork_sha" || "$latest_upstream" != "$upstream_sha" || "$latest_candidate" != "$candidate" ]]; then
  echo "Fork, upstream, or candidate moved during CI; refusing promotion. PR retained."
  exit 0
fi
git push origin "$candidate:refs/heads/main"
echo "Fast-forwarded fully validated upstream integration $candidate to main." | tee -a "$GITHUB_STEP_SUMMARY"
