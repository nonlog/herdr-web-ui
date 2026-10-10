# Automated upstream synchronization

This fork follows [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui) while preserving its own Windows native terminal, native geometry, Pi large-session paging, Codex recovery, semantic Escape, mobile history, and remote scrolling fixes.

## How it works

- `.github/workflows/upstream-sync.yml` runs daily and can be run manually from Actions. It fetches `devswha/herdr-web-ui` `main`.
- Updates are published to the same `automation/upstream-sync` branch and surfaced as one PR against `nonlog/herdr-web-ui:main`; a newer upstream tip updates that PR.
- The script first tries an ordinary Git merge. If it has conflicts, it **does not choose upstream's side**: the PR branch contains the upstream tip with GitHub merge conflicts, and the PR body names the conflicted paths. It never merges or deploys that state.
- Even if Git merges cleanly, updates touching a file that has been changed by our fork, or certain high-risk workflows, installer and terminal-control paths, are held for manual review.
- A new, clean candidate triggers the existing full CI through `workflow_dispatch`, because PR/push events created with `GITHUB_TOKEN` do not trigger other workflows. All three jobs—**Native Windows install**, **Fast checks**, and **Integration and browser**—must pass.
- Only if there are no conflicts, no shared-customization or sensitive-file changes, full CI succeeds, and the base/upstream/candidate hashes remain unchanged does the sync job fast-forward `main` to the **exact tested merge commit**. This preserves ancestry and uses `Codex <codex@openai.com>` for authored and committed merges.
- Updating source `main` **never automatically upgrades the installed Windows plugin or deploys to a server**. Deployment remains a separate, verified action.

## Reviewing a blocked update

Open the sync PR under [Pull requests](https://github.com/nonlog/herdr-web-ui/pulls). For a conflict PR, the automation branch is the **unmodified upstream tip**, not a safe merged result. Manually merge the fork's `main` into the branch, resolve conflicts with reference to [fork-features.md](fork-features.md), and run full CI before merging. Do not click "accept all incoming changes" in fork-customized files.

For a clean but held PR, inspect the listed overlapping/sensitive files and all related behavior before merging. The automated job will not overwrite manual commits made on the PR branch. If you merge it, normal Git history must retain both upstream and fork changes.

A successful update is indicated by the sync workflow result and, when eligible, the resulting commit on `main`. A blocked PR is an **open update requiring review**, not evidence that `main` already includes the newest upstream features.

## Permissions and safety

- Repository Actions: allow GitHub Actions to create PRs. The default `GITHUB_TOKEN` remains read-only; this workflow requests `contents: write`, `pull-requests: write` and `actions: write` explicitly.
- No additional PAT, GitHub App private key, or VPS credentials are needed. The sync job uses only the standard temporary `GITHUB_TOKEN`.
- Only the pinned upstream repository's `main` is followed. This workflow does not execute upstream project code with its write-capable token. Testing runs in the separate existing CI workflow.
- The sync job cannot force-push `main`. Its automated `main` push is an exact fast-forward of a validated merge; other changes to either repository during CI block promotion.
- Scheduled checks can be delayed or skipped by GitHub. Use **Actions → Upstream sync → Run workflow** to check immediately.

## Existing backlog

When the workflow was introduced, the fork and upstream already diverged with conflicts. The initial automated check therefore creates a review PR rather than attempting to resolve those conflicts or overwrite the local features.
