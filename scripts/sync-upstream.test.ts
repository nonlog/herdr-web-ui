import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The auto-sync workflow runs git apply --3way against a previous upstream
// baseline. Test with disposable repositories, not this checkout or herdr.
const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: "Codex", GIT_AUTHOR_EMAIL: "codex@openai.com", GIT_COMMITTER_NAME: "Codex", GIT_COMMITTER_EMAIL: "codex@openai.com" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(): { root: string; previous: string; latest: string } {
  const root = mkdtempSync(join(tmpdir(), "herdr-upstream-sync-"));
  fixtures.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Codex");
  git(root, "config", "user.email", "codex@openai.com");
  git(root, "config", "core.autocrlf", "false");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'base';\n");
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: existing\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const previous = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-qc", "upstream");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'base';\nexport const search = true;\n");
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: new-upstream-workflow\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream additions");
  const latest = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-qc", "fork", previous);
  return { root, previous, latest };
}

function sourcePatch(root: string, previous: string, latest: string): string {
  return git(root, "diff", "--binary", previous, latest, "--", ".", ":(exclude).github/workflows") + "\n";
}

test("non-workflow upstream features apply without replacing fork-specific fixes", () => {
  const { root, previous, latest } = fixture();
  writeFileSync(join(root, "src", "local-history.ts"), "export const nativeGeometry = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fork-only Windows controller");
  const patch = sourcePatch(root, previous, latest);
  const applied = spawnSync("git", ["apply", "--index", "--3way", "-"], { cwd: root, input: patch, encoding: "utf8" });
  expect(applied.status).toBe(0);
  expect(readFileSync(join(root, "src", "terminal.ts"), "utf8")).toContain("search = true");
  expect(readFileSync(join(root, "src", "local-history.ts"), "utf8")).toContain("nativeGeometry = true");
  expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")).toBe("name: existing\n");
});

test("conflicting edits are rejected for review rather than choosing incoming code", () => {
  const { root, previous } = fixture();
  git(root, "switch", "upstream");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'upstream';\nexport const search = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream modifies same setting");
  const latest = git(root, "rev-parse", "HEAD");
  git(root, "switch", "fork");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'fork';\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fork behavior");
  const applied = spawnSync("git", ["apply", "--index", "--3way", "-"], { cwd: root, input: sourcePatch(root, previous, latest), encoding: "utf8" });
  expect(applied.status).not.toBe(0);
  expect(git(root, "diff", "--name-only", "--diff-filter=U")).toContain("src/terminal.ts");
});

test.skipIf(process.platform === "win32")("the sync script fails with a conflict summary without publishing a tracking PR", () => {
  const { root, previous } = fixture();
  git(root, "switch", "upstream");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'upstream';\nexport const search = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream changes the same terminal setting");
  const latest = git(root, "rev-parse", "HEAD");
  git(root, "switch", "fork");
  const remotes = mkdtempSync(join(tmpdir(), "herdr-upstream-remotes-"));
  fixtures.push(remotes);
  const upstream = join(remotes, "upstream.git");
  const origin = join(remotes, "origin.git");
  git(root, "clone", "--bare", root, upstream);
  git(upstream, "update-ref", "refs/heads/main", latest);
  git(root, "switch", "-c", "main");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'fork';\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "upstream-sync-state.json"), JSON.stringify({
    upstream: "devswha/herdr-web-ui", last_applied_sha: previous, workflow_changes_pending: [],
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "fork baseline and incompatible terminal");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "clone", "--bare", root, origin);
  git(root, "remote", "add", "origin", origin);
  git(root, "config", `url.${upstream.replaceAll("\\", "/")}.insteadOf`, "https://github.com/devswha/herdr-web-ui.git");
  const summary = join(remotes, "summary.md");
  const calls = join(remotes, "gh-calls");
  const result = spawnSync("bash", ["-c", `
    gh() { printf '%s\\n' "$*" >> "$GH_CALL_LOG"; return 99; }
    export -f gh
    source "$1"
  `, "sync-test", join(import.meta.dir, "sync-upstream.sh")], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, GH_REPO: "nonlog/herdr-web-ui", GITHUB_STEP_SUMMARY: summary, GH_CALL_LOG: calls },
  });
  expect(result.status).toBe(1);
  expect(readFileSync(summary, "utf8")).toContain("src/terminal.ts");
  expect(result.stdout).toContain("::error::Upstream source sync requires review");
  expect(git(origin, "rev-parse", "main")).toBe(base);
  expect(git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/automation/")).toBe("");
  expect(() => readFileSync(calls)).toThrow();
});
