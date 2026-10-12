#!/usr/bin/env bash
# Merge actual upstream commits. Never substitute copied source for ancestry.
set -euo pipefail
export LC_ALL=C
export GIT_AUTHOR_NAME=Codex GIT_AUTHOR_EMAIL=codex@openai.com
export GIT_COMMITTER_NAME=Codex GIT_COMMITTER_EMAIL=codex@openai.com

[[ "${GH_REPO:-}" == "nonlog/herdr-web-ui" ]] || { echo "Unexpected repository" >&2; exit 1; }
upstream_url="https://github.com/devswha/herdr-web-ui.git"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git config user.name Codex
git config user.email codex@openai.com
git remote add upstream "$upstream_url"
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
git fetch --no-tags upstream +refs/heads/main:refs/remotes/upstream/main
base="$(git rev-parse refs/remotes/origin/main)"
latest="$(git rev-parse refs/remotes/upstream/main)"
state="docs/upstream-sync-state.json"
[[ -f "$state" ]] || { echo "Missing tracked upstream integration baseline" >&2; exit 1; }
previous="$(jq -er '.last_merged_sha // .last_applied_sha' "$state")"
[[ "$(jq -r .upstream "$state")" == devswha/herdr-web-ui ]] || { echo "Unknown upstream state owner" >&2; exit 1; }
git cat-file -e "${previous}^{commit}"
git merge-base --is-ancestor "$previous" "$latest" || {
  echo "Upstream history was rewritten; existing baseline is not its ancestor" >&2
  exit 1
}
if git merge-base --is-ancestor "$latest" "$base"; then
  echo "No new upstream commits; upstream is an ancestor of main" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi

git log --format= --name-only "$base..$latest" -- .github/workflows | sed '/^$/d' | sort -u > "$tmp/workflows"
git diff --name-only "$previous" "$latest" > "$tmp/source-files"
: > "$tmp/conflicts"

# A conflict report belongs to this run, not a mergeable document-only PR.
review() {
  local reason="$1"
  {
    echo '# Upstream commit update requires review'
    echo
    echo '**No upstream code was promoted to main. Resolve the listed conflicts and run full CI.**'
    echo
    echo "Reason: $reason"
    echo "Fork base: $base"
    echo "Recorded upstream baseline: $previous"
    echo "New upstream tip: $latest"
    echo
    echo 'Unresolved paths:'
    if [[ -s "$tmp/conflicts" ]]; then sed 's/^/- /' "$tmp/conflicts"; else echo '- Not identified'; fi
    echo
    echo 'Upstream changes:'
    sed 's/^/- /' "$tmp/source-files"
    echo
    echo 'Workflow history requiring maintainer permissions:'
    if [[ -s "$tmp/workflows" ]]; then sed 's/^/- /' "$tmp/workflows"; else echo '- None'; fi
    echo
    echo 'Resolve using a fresh branch, keep docs/fork-features.md capabilities,'
    echo 'and submit the exact result to GitHub Actions CI before merging.'
    echo 'Keep the upstream merge parent; do not squash the synchronization commit.'
  } | tee -a "$GITHUB_STEP_SUMMARY"
  echo "::error::Upstream commit sync requires review: $reason"
}

if ! git merge-base --is-ancestor "$previous" "$base"; then
  review 'recorded source baseline is not in main history; a real maintainer merge is required'
  exit 1
fi
if [[ -s "$tmp/workflows" ]]; then
  review 'upstream workflow commits require maintainer review and workflow write permission'
  exit 1
fi

branch="automation/upstream-sync-${base:0:12}-${latest:0:12}"
git checkout -B upstream-sync-candidate "$base"
if ! git merge --no-ff --no-commit "$latest" > "$tmp/merge.log" 2>&1; then
  git diff --name-only --diff-filter=U > "$tmp/conflicts" || true
  if [[ ! -s "$tmp/conflicts" ]]; then cat "$tmp/merge.log" >> "$tmp/conflicts"; fi
  review 'source code conflicts during Git merge'
  exit 1
fi

jq -n --arg sha "$latest" \
  '{upstream:"devswha/herdr-web-ui",last_merged_sha:$sha}' > "$tmp/newstate"
cp "$tmp/newstate" "$state"
git add "$state"

# Changes to authentication and ingress enforcement need scrutiny beyond
# application CI. Regular terminal, UI, API, tests, installers and dependencies
# auto-integrate if Git merge and all platform CI jobs succeed.
git diff --cached --name-only > "$tmp/changed"
: > "$tmp/security"
while IFS= read -r file; do
  case "$file" in
    server/auth.ts|server/access.ts|server/machine-security.ts|server/ssh.ts|server/input-guard.ts|server/http.ts|server/open-access.ts|server/portal.ts|server/index.ts|scripts/sync-upstream.sh|.github/actions/*)
      echo "$file" >> "$tmp/security" ;;
  esac
done < "$tmp/changed"

git diff --cached --check || { review 'merge has whitespace errors'; exit 1; }
git commit -m "chore(sync): merge upstream $(git rev-parse --short=12 "$latest")" \
  -m 'Sync-Generated-By: nonlog/upstream-commit-sync' -m "Upstream-Merged-SHA: $latest"
candidate="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$latest" "$candidate" || { echo "Candidate lost upstream history" >&2; exit 1; }
ref="refs/heads/$branch"
earlier=""
if git ls-remote --heads --exit-code origin "$ref" >/dev/null 2>&1; then
  git fetch --no-tags origin "+$ref:refs/remotes/origin/$branch"
  earlier="$(git rev-parse "refs/remotes/origin/$branch")"
  if [[ "$(git rev-parse "$earlier^{tree}")" != "$(git rev-parse "$candidate^{tree}")" ]] ||
     [[ "$(git show -s --format=%P "$earlier")" != "$base $latest" ]] ||
     ! git show -s --format=%B "$earlier" | grep -qx 'Sync-Generated-By: nonlog/upstream-commit-sync'; then
    echo "Existing candidate branch differs from the generated merge; refusing to overwrite" >&2
    exit 1
  fi
  git checkout --detach "$earlier"
  candidate="$earlier"
else
  git push origin "HEAD:$ref"
fi

# Dispatch instead of relying on GITHUB_TOKEN-created push/PR events. CI is a
# separate workflow with contents:read, so untrusted upstream code cannot use
# this workflow's write-capable token.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run ci.yml --repo "$GH_REPO" --ref "$branch"
run_id=""
for _ in $(seq 1 75); do
  list="$(gh run list --repo "$GH_REPO" --workflow ci.yml --branch "$branch" \
    --event workflow_dispatch --limit 20 --json databaseId,headSha,createdAt)"
  run_id="$(jq -r --arg sha "$candidate" --arg since "$started" \
    '[.[] | select(.headSha == $sha and .createdAt >= $since)] | sort_by(.createdAt) | last | .databaseId // empty' <<< "$list")"
  [[ -n "$run_id" ]] && break
  sleep 10
done
[[ -n "$run_id" ]] || { echo "Could not locate dispatched CI run" >&2; exit 1; }

completed=false
for _ in $(seq 1 95); do
  gh run view "$run_id" --repo "$GH_REPO" --json status,conclusion,headSha,jobs > "$tmp/ci.json"
  if [[ "$(jq -r '.status' "$tmp/ci.json")" == completed ]]; then completed=true; break; fi
  sleep 20
done
[[ "$completed" == true ]] || { echo "CI still pending; candidate retained" >&2; exit 1; }

if ! jq -e --arg sha "$candidate" '
  .conclusion == "success" and .headSha == $sha and
  ([.jobs[] | select(.conclusion == "success") | .name] as $passed |
    (["Native Windows install","Native macOS session identity",
      "Fast checks","Integration and browser"] - $passed | length) == 0)
' "$tmp/ci.json" >/dev/null; then
  echo "CI failed; candidate preserved on $branch, no main update" >&2
  exit 1
fi

if [[ -s "$tmp/security" ]]; then
  details="$(sed 's/^/- /' "$tmp/security")"
  number="$(gh pr list --repo "$GH_REPO" --state open --base main --head "$branch" --json number --jq '.[0].number // empty')"
  printf 'Upstream commits through %s passed complete CI (run %s), but change security-sensitive files:\n\n%s\n\nReview before merging; preserve upstream ancestry and do not squash or force-push this branch.\n' "$latest" "$run_id" "$details" > "$tmp/security-review.md"
  if [[ -z "$number" ]]; then
    gh pr create --repo "$GH_REPO" --base main --head "$branch" --draft \
      --title 'chore(sync): upstream commit security review' --body-file "$tmp/security-review.md"
  else
    gh pr edit "$number" --repo "$GH_REPO" --body-file "$tmp/security-review.md"
  fi
  echo "Full CI passed; security-sensitive paths require review" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# Check the exact test commit and both repositories have not moved during CI.
now_base="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
now_latest="$(git ls-remote upstream refs/heads/main | awk '{print $1}')"
now_branch="$(git ls-remote origin "$ref" | awk '{print $1}')"
if [[ "$now_base" != "$base" || "$now_latest" != "$latest" || "$now_branch" != "$candidate" ]]; then
  echo "Repository moved during CI; validated candidate remains on $branch" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi
git push origin "$candidate:refs/heads/main"
# GITHUB_TOKEN pushes do not trigger push workflows; publish the validated source explicitly.
gh workflow run pages.yml --repo "$GH_REPO" --ref main
{
  echo "Merged upstream commits through $latest; upstream is an ancestor of main"
  echo "CI: https://github.com/$GH_REPO/actions/runs/$run_id"
} >> "$GITHUB_STEP_SUMMARY"
