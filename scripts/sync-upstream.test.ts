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
