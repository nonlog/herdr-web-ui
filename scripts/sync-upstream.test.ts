import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise real Git merge ancestry with disposable repositories, never this checkout or herdr.
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

function fixture(workflow = false): { root: string; previous: string; latest: string } {
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
  if (workflow) writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: new-upstream-workflow\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream additions");
  const latest = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-qc", "fork", previous);
  return { root, previous, latest };
}

test("upstream commits become ancestors without replacing fork-specific fixes", () => {
  const { root, latest } = fixture();
  writeFileSync(join(root, "src", "local-history.ts"), "export const nativeGeometry = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fork-only Windows controller");
  git(root, "merge", "--no-ff", "--no-commit", latest);
  git(root, "commit", "-qm", "merge upstream history");
  expect(git(root, "rev-list", "--count", `HEAD..${latest}`)).toBe("0");
  expect(readFileSync(join(root, "src", "terminal.ts"), "utf8")).toContain("search = true");
  expect(readFileSync(join(root, "src", "local-history.ts"), "utf8")).toContain("nativeGeometry = true");
  expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")).toBe("name: existing\n");
});

test("conflicting edits are rejected for review rather than choosing incoming code", () => {
  const { root } = fixture();
  git(root, "switch", "upstream");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'upstream';\nexport const search = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "upstream modifies same setting");
  const latest = git(root, "rev-parse", "HEAD");
  git(root, "switch", "fork");
  writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'fork';\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fork behavior");
  const applied = spawnSync("git", ["merge", "--no-ff", "--no-commit", latest], { cwd: root, encoding: "utf8" });
  expect(applied.status).not.toBe(0);
  expect(git(root, "diff", "--name-only", "--diff-filter=U")).toContain("src/terminal.ts");
});

for (const reason of ["conflict", "workflow", "legacy", "manual", "merged"]) {
test.skipIf(process.platform === "win32")(`the sync script holds ${reason} for review without publishing a tracking PR`, () => {
  const { root, previous } = fixture(reason === "workflow");
  git(root, "switch", "upstream");
  if (reason === "conflict") {
    writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'upstream';\nexport const search = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "upstream changes the same terminal setting");
  }
  const latest = git(root, "rev-parse", "HEAD");
  git(root, "switch", "fork");
  const remotes = mkdtempSync(join(tmpdir(), "herdr-upstream-remotes-"));
  fixtures.push(remotes);
  const upstream = join(remotes, "upstream.git");
  const origin = join(remotes, "origin.git");
  git(root, "clone", "--bare", root, upstream);
  git(upstream, "update-ref", "refs/heads/main", latest);
  git(root, "switch", "-c", "main");
  if (reason === "merged") git(root, "merge", "--no-ff", "--no-commit", latest);
  if (reason === "conflict") writeFileSync(join(root, "src", "terminal.ts"), "export const mode = 'fork';\n");
  if (reason === "legacy") writeFileSync(join(root, "src", "terminal.ts"), git(root, "show", `${latest}:src/terminal.ts`) + "\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "upstream-sync-state.json"), JSON.stringify({
    upstream: "devswha/herdr-web-ui", last_merged_sha: reason === "legacy" || reason === "merged" ? latest : previous,
  }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "fork baseline and incompatible terminal");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "clone", "--bare", root, origin);
  const branch = `automation/upstream-sync-${base.slice(0, 12)}-${latest.slice(0, 12)}`;
  if (reason === "manual") git(origin, "update-ref", `refs/heads/${branch}`, base);
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
  expect(result.status).toBe(reason === "merged" ? 0 : 1);
  if (reason === "legacy") expect(readFileSync(summary, "utf8")).toContain("baseline is not in main history");
  if (reason === "merged") expect(readFileSync(summary, "utf8")).toContain("upstream is an ancestor of main");
  if (reason === "conflict" || reason === "workflow") expect(readFileSync(summary, "utf8")).toContain(reason === "workflow" ? ".github/workflows/ci.yml" : "src/terminal.ts");
  if (reason === "manual") expect(result.stderr).toContain("refusing to overwrite");
  else if (reason !== "merged") expect(result.stdout).toContain("::error::Upstream commit sync requires review");
  expect(git(origin, "rev-parse", "main")).toBe(base);
  expect(git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/automation/")).toBe(reason === "manual" ? `refs/heads/${branch}` : "");
  expect(() => readFileSync(calls)).toThrow();
});
}

for (const sensitive of ["", "portal.ts", "index.ts", "workflow"]) {
  test.skipIf(process.platform === "win32")(`complete sync ${sensitive && sensitive !== "workflow" ? `holds ${sensitive} changes for review` : "promotes the tested commit and dispatches Pages"}`, () => {
    const { root, previous, latest } = fixture(sensitive === "workflow");
    git(root, "switch", "-c", "main");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "upstream-sync-state.json"), JSON.stringify({
      upstream: "devswha/herdr-web-ui", last_merged_sha: previous,
    }));
    writeFileSync(join(root, "src", "local-history.ts"), "export const nativeGeometry = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fork baseline and Windows feature");
    const base = git(root, "rev-parse", "HEAD");
    const remotes = mkdtempSync(join(tmpdir(), "herdr-upstream-success-"));
    fixtures.push(remotes);
    const upstream = join(remotes, "upstream.git");
    const origin = join(remotes, "origin.git");
    git(root, "clone", "--bare", root, upstream);
    let target = latest;
    if (sensitive && sensitive !== "workflow") {
      git(root, "switch", "upstream");
      mkdirSync(join(root, "server"));
      writeFileSync(join(root, "server", sensitive), "export const publicIngress = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "upstream public ingress");
      target = git(root, "rev-parse", "HEAD");
      git(root, "switch", "main");
    }
    git(upstream, "fetch", root, target);
    git(upstream, "update-ref", "refs/heads/main", target);
    git(root, "clone", "--bare", root, origin);
    git(root, "remote", "add", "origin", origin);
    git(root, "config", `url.${upstream.replaceAll("\\", "/")}.insteadOf`, "https://github.com/devswha/herdr-web-ui.git");
    const summary = join(remotes, "summary.md");
    const calls = join(remotes, "gh-calls");
    const result = spawnSync("bash", ["-c", `
      gh() {
        printf '%s\\n' "$*" >> "$GH_CALL_LOG"
        case "$1 $2" in
          'workflow run'|'pr create') return 0;;
          'run list') printf '[{"databaseId":123,"headSha":"%s","createdAt":"%s"}]\\n' "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)";;
          'run view') printf '{"status":"completed","conclusion":"success","headSha":"%s","jobs":[{"name":"Detect changes","conclusion":"success"},{"name":"Native Windows install","conclusion":"success"},{"name":"Native macOS session identity","conclusion":"success"},{"name":"Fast checks","conclusion":"success"},{"name":"Integration tests","conclusion":"success"},{"name":"Browser regression (ui-regression)","conclusion":"success"},{"name":"Browser regression (other scripts)","conclusion":"success"}]}\\n' "$(git rev-parse HEAD)";;
          'pr list') return 0;;
          *) return 99;;
        esac
      }
      export -f gh
      source "$1"
    `, "sync-test", join(import.meta.dir, "sync-upstream.sh")], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, GH_REPO: "nonlog/herdr-web-ui", GITHUB_STEP_SUMMARY: summary, GH_CALL_LOG: calls, SYNC_WORKFLOWS_AUTHORIZED: sensitive === "workflow" ? "true" : "false" },
    });
    expect(result.status).toBe(0);
    const branch = `automation/upstream-sync-${base.slice(0, 12)}-${target.slice(0, 12)}`;
    const candidate = git(origin, "rev-parse", branch);
    expect(JSON.parse(git(origin, "show", `${candidate}:docs/upstream-sync-state.json`))).toMatchObject({
      last_merged_sha: target,
    });
    expect(git(origin, "show", "-s", "--format=%P", candidate)).toBe(`${base} ${target}`);
    expect(git(origin, "rev-list", "--count", `${candidate}..${target}`)).toBe("0");
    expect(git(origin, "show", `${candidate}:src/local-history.ts`)).toContain("nativeGeometry = true");
    expect(git(origin, "show", `${candidate}:.github/workflows/ci.yml`)).toBe("name: existing");
    expect(git(origin, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", candidate)).toBe("Codex <codex@openai.com>\nCodex <codex@openai.com>");
    const published = readFileSync(calls, "utf8");
    expect(published).toContain(`workflow run ci.yml --repo nonlog/herdr-web-ui --ref ${branch}`);
    expect(git(origin, "rev-parse", "main")).toBe(sensitive && sensitive !== "workflow" ? base : candidate);
    if (sensitive && sensitive !== "workflow") {
      expect(published).toContain(`pr create --repo nonlog/herdr-web-ui --base main --head ${branch} --draft`);
      expect(published).not.toContain("workflow run pages.yml");
    } else {
      expect(published).toContain("workflow run pages.yml --repo nonlog/herdr-web-ui --ref main");
      expect(readFileSync(summary, "utf8")).toContain(`Merged upstream commits through ${target}`);
    }
  });
}
