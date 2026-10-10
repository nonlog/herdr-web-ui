#!/usr/bin/env bash
# Integrate upstream *source* changes with 3-way patching while retaining fork
# history. The temporary GITHUB_TOKEN deliberately never updates workflow files.
set -euo pipefail
export LC_ALL=C

[[ "${GH_REPO:-}" == "nonlog/herdr-web-ui" ]] || { echo "Unexpected repository" >&2; exit 1; }
upstream_url="https://github.com/devswha/herdr-web-ui.git"
branch="automation/upstream-source-sync"
review_branch="automation/upstream-source-sync-review"
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
previous="$(jq -er '.last_applied_sha' "$state")"
[[ "$(jq -r .upstream "$state")" == devswha/herdr-web-ui ]] || { echo "Unknown upstream state owner" >&2; exit 1; }
git cat-file -e "${previous}^{commit}"
git merge-base --is-ancestor "$previous" "$latest" || {
  echo "Upstream history was rewritten; existing baseline is not its ancestor" >&2
  exit 1
}
if [[ "$previous" == "$latest" ]]; then
  echo "No new upstream changes" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi

git diff --name-only "$previous" "$latest" -- .github/workflows > "$tmp/workflows"
git diff --name-only "$previous" "$latest" -- . ':(exclude).github/workflows' > "$tmp/source-files"
git diff --binary --no-ext-diff "$previous" "$latest" -- . ':(exclude).github/workflows' > "$tmp/source.patch"

# Save a draft *tracking* PR when a source merge is not safe. It contains only
# a report: it is NOT a diff that anyone should merge to gain upstream features.
review() {
  local reason="$1"
  git reset --hard "$base"
  git checkout -B upstream-sync-review "$base"
  mkdir -p docs
  {
    echo '# Upstream source update requires review'
    echo
    echo '**TRACKING ONLY: DO NOT MERGE THIS DOCUMENT AS AN UPSTREAM UPDATE.**'
    echo
    echo "Reason: $reason"
    echo "Fork base: $base"
    echo "Last processed upstream: $previous"
    echo "New upstream tip: $latest"
    echo
    echo 'Unresolved paths:'
    if [[ -s "$tmp/conflicts" ]]; then sed 's/^/- /' "$tmp/conflicts"; else echo '- Not identified'; fi
    echo
    echo 'Upstream source changes (workflow files excluded):'
    sed 's/^/- /' "$tmp/source-files"
    echo
    echo 'Upstream workflow files excluded because GITHUB_TOKEN cannot modify them:'
    if [[ -s "$tmp/workflows" ]]; then sed 's/^/- /' "$tmp/workflows"; else echo '- None'; fi
    echo
    echo 'Resolve using a fresh branch, keep docs/fork-features.md capabilities,'
    echo 'and submit the exact result to GitHub Actions CI before merging.'
    echo 'Update docs/upstream-sync-state.json only for changes actually integrated.'
  } > docs/upstream-sync-pending.md
  git add docs/upstream-sync-pending.md

  local ref="refs/heads/$review_branch" earlier=""
  if git ls-remote --heads --exit-code origin "$ref" >/dev/null 2>&1; then
    git fetch --no-tags origin "+$ref:refs/remotes/origin/$review_branch"
    earlier="$(git rev-parse "refs/remotes/origin/$review_branch")"
    if ! git show -s --format=%B "$earlier" | grep -qx 'Sync-Generated-By: nonlog/upstream-source-sync'; then
      echo "Review branch has manual commits; leaving them untouched" >&2
      return 0
    fi
    if git show -s --format=%B "$earlier" | grep -qx "Upstream-Source-SHA: $latest" &&
       git show -s --format=%B "$earlier" | grep -qx "Fork-Base-SHA: $base"; then
      git reset --hard "$earlier"
    fi
  fi
  if [[ "$(git rev-parse HEAD)" == "$base" ]]; then
    git commit -m 'chore: track upstream source conflicts for review' \
      -m 'Sync-Generated-By: nonlog/upstream-source-sync' \
      -m "Upstream-Source-SHA: $latest" -m "Fork-Base-SHA: $base"
  fi
  if [[ -n "$earlier" ]]; then
    git push "--force-with-lease=$ref:$earlier" origin "HEAD:$ref"
  else
    git push origin "HEAD:$ref"
  fi
  local number
  number="$(gh pr list --repo "$GH_REPO" --state open --base main --head "$review_branch" --json number --jq '.[0].number // empty')"
  if [[ -z "$number" ]]; then
    gh pr create --repo "$GH_REPO" --base main --head "$review_branch" --draft \
      --title 'chore: upstream source update needs conflict review (tracking only)' \
      --body "Source sync of $latest needs review ($reason). **DO NOT MERGE THIS TRACKING PR.** The report in docs/upstream-sync-pending.md lists unresolved paths; the upstream code was not incorporated."
  else
    gh pr edit "$number" --repo "$GH_REPO" \
      --body "Source sync of $latest needs review ($reason). **DO NOT MERGE THIS TRACKING PR.** The report in docs/upstream-sync-pending.md lists unresolved paths; the upstream code was not incorporated."
  fi
  echo "Upstream source sync held: $reason" | tee -a "$GITHUB_STEP_SUMMARY"
}

git checkout -B upstream-sync-candidate "$base"
: > "$tmp/conflicts"
if [[ -s "$tmp/source.patch" ]]; then
  if ! git apply --index --3way "$tmp/source.patch" > "$tmp/apply.log" 2>&1; then
    git diff --name-only --diff-filter=U > "$tmp/conflicts" || true
    if [[ ! -s "$tmp/conflicts" ]]; then cat "$tmp/apply.log" >> "$tmp/conflicts"; fi
    review 'source code conflicts during three-way patch application'
    exit 0
  fi
fi

# Source integration deliberately squashes only non-workflow changes. This avoids
# the GitHub App workflows permission restriction, without storing a PAT.
changed_workflows="$(jq -R -s 'split("\n") | map(select(length>0))' < "$tmp/workflows")"
jq -n --arg sha "$latest" --argjson old "$(cat "$state")" \
  --argjson changed "$changed_workflows" \
  '{upstream:"devswha/herdr-web-ui",last_applied_sha:$sha,
    workflow_changes_pending:( ($old.workflow_changes_pending // []) + $changed | unique | sort )}' > "$tmp/newstate"
cp "$tmp/newstate" "$state"
git add "$state"
if git diff --cached --quiet; then
  echo "No source or state changes; nothing to promote" | tee -a "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# Changes to authentication and ingress enforcement need scrutiny beyond
# application CI. Regular terminal, UI, API, tests, installers and dependencies
# auto-integrate if Git's 3-way apply and all platform CI jobs succeed.
git diff --cached --name-only > "$tmp/changed"
: > "$tmp/security"
while IFS= read -r file; do
  case "$file" in
    server/auth.ts|server/access.ts|server/machine-security.ts|server/ssh.ts|server/input-guard.ts|server/http.ts|server/open-access.ts)
      echo "$file" >> "$tmp/security" ;;
  esac
done < "$tmp/changed"

git diff --cached --check || { review 'source patch has whitespace errors'; exit 0; }
git commit -m "chore: integrate upstream source $(git rev-parse --short=12 "$latest")" \
  -m 'Sync-Generated-By: nonlog/upstream-source-sync' -m "Upstream-Source-SHA: $latest"
candidate="$(git rev-parse HEAD)"
ref="refs/heads/$branch"
earlier=""
if git ls-remote --heads --exit-code origin "$ref" >/dev/null 2>&1; then
  git fetch --no-tags origin "+$ref:refs/remotes/origin/$branch"
  earlier="$(git rev-parse "refs/remotes/origin/$branch")"
  if ! git merge-base --is-ancestor "$earlier" "$base" &&
     ! git show -s --format=%B "$earlier" | grep -qx 'Sync-Generated-By: nonlog/upstream-source-sync'; then
    echo "Existing candidate branch contains manual work; refusing to overwrite" >&2
    exit 1
  fi
  git push "--force-with-lease=$ref:$earlier" origin "HEAD:$ref"
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
  body="Upstream source $latest passed complete CI (run $run_id), but changes security-sensitive files:\n\n$details\n\nReview before merging; do not force-push the base."
  if [[ -z "$number" ]]; then
    gh pr create --repo "$GH_REPO" --base main --head "$branch" --draft \
      --title 'chore: upstream source sync security review' --body "$body"
  else
    gh pr edit "$number" --repo "$GH_REPO" --body "$body"
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
{
  echo "Integrated upstream source through $latest"
  echo "CI: https://github.com/$GH_REPO/actions/runs/$run_id"
  if [[ -s "$tmp/workflows" ]]; then
    echo "Workflow changes recorded but not applied:"
    sed 's/^/- /' "$tmp/workflows"
  fi
} >> "$GITHUB_STEP_SUMMARY"
