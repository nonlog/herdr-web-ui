# Automated upstream synchronization

This fork follows [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui) while preserving its own Windows native terminal, native geometry, Pi large-session paging, Codex recovery, semantic Escape, mobile history, and remote scrolling fixes.

## How it works

- `.github/workflows/upstream-sync.yml` runs daily and can be run manually from Actions. It fetches `devswha/herdr-web-ui` `main`.
- Updates are published to the same `automation/upstream-sync` branch and surfaced as one PR against `nonlog/herdr-web-ui:main`; a newer upstream tip updates that PR.
- The script first tries an ordinary Git merge. If it has conflicts, it **does not choose upstream's side**. Without upstream workflow changes, the draft PR branch contains the raw upstream tip and lists conflicted paths; it never merges that state.
- **Upstream workflow changes require special handling:** GitHub's built-in `GITHUB_TOKEN` cannot push commits modifying `.github/workflows/`. In that case, the sync job creates a **draft tracking-only PR** containing `docs/upstream-sync-pending.md` with the upstream SHA and conflict list. That PR does **not** contain upstream source changes and must not be merged as a code update. A reviewer must integrate upstream with an authorized Git credential and run full CI; no long-lived PAT is stored in Actions.
- Even if Git merges cleanly, updates touching a file that has been changed by our fork, or certain high-risk workflows, installer and terminal-control paths, are held for manual review.
- A new, clean candidate triggers the existing full CI through `workflow_dispatch`, because PR/push events created with `GITHUB_TOKEN` do not trigger other workflows. All three jobs—**Native Windows install**, **Fast checks**, and **Integration and browser**—must pass.
- Only if there are no conflicts, no shared-customization or sensitive-file changes, full CI succeeds, and the base/upstream/candidate hashes remain unchanged does the sync job fast-forward `main` to the **exact tested merge commit**. This preserves ancestry and uses `Codex <codex@openai.com>` for authored and committed merges.
- Updating source `main` **never automatically upgrades the installed Windows plugin or deploys to a server**. Deployment remains a separate, verified action.

## Reviewing a blocked update

Open the sync PR under [Pull requests](https://github.com/nonlog/herdr-web-ui/pulls). For a conflict PR without workflow changes, the automation branch is the **unmodified upstream tip**, not a safe merged result. Manually merge fork `main` into the branch and resolve conflicts with reference to [fork-features.md](fork-features.md). For a **tracking-only PR**, do not merge the report; integrate upstream code on a separate branch with credentials authorized for workflow changes and run full CI. Never click "accept all incoming changes" for customized files.

For a clean but held PR, inspect the listed overlapping/sensitive files and all related behavior before merging. The automated job will not overwrite manual commits made on the PR branch. If you merge it, normal Git history must retain both upstream and fork changes.

A successful update is indicated by the sync workflow result and, when eligible, the resulting commit on `main`. A blocked PR is an **open update requiring review**, not evidence that `main` already includes the newest upstream features.

## Permissions and safety

- Repository Actions: allow GitHub Actions to create PRs. The default `GITHUB_TOKEN` remains read-only; this workflow requests `contents: write`, `pull-requests: write` and `actions: write` explicitly.
- No additional PAT, GitHub App private key, or VPS credentials are required for scheduled checks or tracking PRs. Actual upstream workflow-file changes require an authorized user to merge them separately; the scheduled job deliberately avoids storing a long-lived credential.
- Only the pinned upstream repository's `main` is followed. This workflow does not execute upstream project code with its write-capable token. Testing runs in the separate existing CI workflow.
- The sync job cannot force-push `main`. Its automated `main` push is an exact fast-forward of a validated merge; other changes to either repository during CI block promotion.
- Scheduled checks can be delayed or skipped by GitHub. Use **Actions → Upstream sync → Run workflow** to check immediately.

## Existing backlog

When the workflow was introduced, the fork and upstream already diverged with conflicts. The initial automated check therefore creates a review PR rather than attempting to resolve those conflicts or overwrite the local features.
