/**
 * The checks, from one entry point: CI's jobs call it, and so does a developer or an agent
 * before pushing, so both run the same thing.
 *
 *   bun run check fast                  what CI's "Fast checks" job runs: workflow syntax, generated
 *                                       types, typecheck, build, unit tests. No herdr needed.
 *   bun run check integration browser   CI's "Integration and browser" job: a build, then the named
 *                                       lanes side by side (either name alone runs that lane)
 *   bun run check full                  fast, then both lanes
 *   bun run check run <command…>        any command on the same isolated herdr: one contract test
 *                                       file, one browser script
 *
 * Whatever needs herdr runs on a herdr of its own. Its config, its plugin state and the web UI's
 * state live in a directory made for this run (XDG_CONFIG_HOME, XDG_STATE_HOME,
 * HERDR_WEB_STATE_DIR), under a session name made for this run. Nothing reads the user's herdr
 * config, so no plugin installed there starts with the test servers, and two runs on one PC
 * share no socket and no file. The run stops its herdr servers and removes the directory when
 * it ends, also when it is interrupted. CHECK_DIR names a directory to use and keep instead
 * (CI reads the failure logs from it).
 *
 * Only one run with a lane at a time on a PC: the contract and browser tests are bound by
 * timing, and two runs side by side fail each other. A second one says so and exits. The lock
 * is a loopback port the run listens on (LOCK_PORT), so a run that died holds nothing.
 *
 * What a run still shares with the PC: the checkout (`fast` rewrites the generated types file
 * while it checks it, and every mode builds into dist/, so one run per checkout), herdr's
 * worktree root, and Playwright's browser cache.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MODES = ["fast", "integration", "browser", "full", "run"] as const;
export type Mode = (typeof MODES)[number];
const LANES = { integration: "bun run test:integration", browser: "bash scripts/ci-browser.sh" } as const;
type Lane = keyof typeof LANES;

const USAGE = "Usage: bun run check fast | integration | browser | integration browser | full | run <command…>";

/** What to run, from the arguments: the fast steps, the lanes, or one command. */
export function plan(args: readonly string[]): { fast: boolean; lanes: Lane[]; command: string[] | null } {
  const [first, ...rest] = args;
  if (first === "run") {
    if (rest.length === 0) throw new Error(USAGE);
    return { fast: false, lanes: [], command: rest };
  }
  if (args.length === 0 || args.some((arg) => arg === "run" || !(MODES as readonly string[]).includes(arg))) throw new Error(USAGE);
  const full = args.includes("full");
  const lanes = (Object.keys(LANES) as Lane[]).filter((lane) => full || args.includes(lane));
  return { fast: full || args.includes("fast"), lanes, command: null };
}

/** actionlint as CI pins it. The archive is checked against its SHA-256 before it is unpacked. */
const ACTIONLINT = { version: "1.7.12", sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8" };

/** A unix socket's path holds about 104 bytes on macOS and 108 on Linux. */
const SOCKET_PATH_MAX = 100;

/** What a shell inside a herdr pane carries of that herdr: nothing in a run may reach it by these. */
const LIVE_HERDR = ["HERDR_SOCKET", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

export interface Isolation {
  env: Record<string, string>;
  /** where the run's herdr keeps its sessions */
  sessions: string;
  /** removes the directory, unless the caller named it */
  remove: () => void;
}

/**
 * A herdr of the run's own: the environment that points herdr, its plugins and the web UI at one
 * directory, and a session name no other run has.
 */
export function isolate(base: Record<string, string | undefined>, kept: string | undefined = base["CHECK_DIR"]): Isolation {
  if (base["HERDR_TEST_LIVE"] === "1") throw new Error("HERDR_TEST_LIVE=1 runs tests in the herdr you work in; unset it for `bun run check`");
  // short on purpose: the session's socket path has to fit a unix socket address
  const dir = kept ? resolve(kept) : mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "hwc-"));
  const session = `check-${randomBytes(3).toString("hex")}`;
  const config = join(dir, "config");
  for (const path of [config, join(dir, "state"), join(dir, "web-state")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const sessions = join(config, "herdr", "sessions");
  // the integration lane's workers are `<session>-<n>`
  const socket = join(sessions, `${session}-9`, "herdr.sock");
  if (socket.length > SOCKET_PATH_MAX) {
    if (!kept) rmSync(dir, { recursive: true, force: true });
    throw new Error(`${socket} is too long for a unix socket (${socket.length} > ${SOCKET_PATH_MAX}); set CHECK_DIR to a shorter path`);
  }
  const env: Record<string, string> = {};
  // not what names the herdr this was started from (a pane of the user's): its socket, its pane
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !LIVE_HERDR.includes(name)) env[name] = value;
  Object.assign(env, {
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(dir, "state"),
    HERDR_WEB_STATE_DIR: join(dir, "web-state"),
    HERDR_TEST_SESSION: session,
    // One integration file at a time: four at once made the timing-bound contract tests fail in
    // turn on CI's four cores. HERDR_TEST_SHARDS raises it (scripts/ci-tests.ts).
    HERDR_TEST_SHARDS: base["HERDR_TEST_SHARDS"] || "1",
  });
  return { env, sessions, remove: () => { if (!kept) rmSync(dir, { recursive: true, force: true }); } };
}

/** The loopback port a run with a lane listens on while it runs: the lock. */
export const LOCK_PORT = 41737;

/**
 * One run with a lane at a time on this PC. The lock is a listening loopback port: taking it is
 * one step, and it is free again the moment its run is gone, however it ended, so there is no
 * lock left behind to take over. Whoever holds it answers a connection with its pid. Resolves
 * with the release, or with the pid of the run that holds it (NaN when something else listens
 * there).
 */
export function lock(port = LOCK_PORT, pid = process.pid): Promise<{ release: () => void } | { heldBy: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.end(String(pid)); });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") { reject(error); return; }
      let said = "";
      const client = connect(port, "127.0.0.1");
      client.setTimeout(2_000, () => client.destroy());
      client.on("data", (chunk) => { said += chunk.toString(); });
      client.on("error", () => undefined);
      client.on("close", () => resolve({ heldBy: /^\d+$/.test(said) ? Number(said) : Number.NaN }));
    });
    server.listen(port, "127.0.0.1", () => {
      // the lock must not keep the run alive once its work is done
      server.unref();
      resolve({ release: () => { server.close(); } });
    });
  });
}

async function main(): Promise<void> {
  let todo: ReturnType<typeof plan>;
  try { todo = plan(process.argv.slice(2)); } catch (error) { console.error((error as Error).message); process.exit(2); }
  const needsHerdr = todo.lanes.length > 0 || todo.command !== null;
  const cleanups: (() => void)[] = [];
  let child: ChildProcess | null = null;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const step of cleanups.reverse()) try { step(); } catch (error) { console.error(`check: cleanup failed: ${(error as Error).message}`); }
  };
  let ending = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (ending) return;
      ending = true;
      void (async () => {
        // The step runs in a process group of its own, and a lane starts processes of its own
        // in it: the whole group gets the signal, and has ended before the herdr and the
        // directory it uses are taken away.
        if (child?.pid !== undefined) await endGroup(child.pid, signal);
        cleanup();
        process.exit(signal === "SIGINT" ? 130 : 143);
      })();
    });
  }

  /** Runs one step in the foreground, in its own process group; resolves with its exit code. */
  const run = (label: string, command: string[], env: Record<string, string | undefined>): Promise<number> => {
    const startedAt = Date.now();
    console.log(`\n=== ${label}: ${command.join(" ")}`);
    return new Promise((done) => {
      const started = spawn(command[0]!, command.slice(1), { stdio: "inherit", env, detached: true });
      child = started;
      const finish = (code: number): void => {
        // a run that is being ended is the signal handler's to finish, once the step's group is gone
        if (ending) return;
        child = null;
        times.push({ label, seconds: (Date.now() - startedAt) / 1000, code });
        done(code);
      };
      started.on("error", (error) => { console.error(`check: ${command[0]}: ${error.message}`); finish(127); });
      started.on("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
    });
  };
  const times: { label: string; seconds: number; code: number }[] = [];
  const bun = process.execPath;
  // tests make commits in repositories of their own: an identity for a PC (or a runner) that has none
  const identity = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout?.trim()
    ? {}
    : { GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@example.invalid", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@example.invalid" };
  const plain = { ...process.env, ...identity };

  let code = 0;
  try {
    // before the fast steps too: `full` is refused at once, not after a minute of them
    if (todo.lanes.length > 0) {
      const held = await lock();
      if ("heldBy" in held) {
        throw new Error(Number.isNaN(held.heldBy)
          ? `port ${LOCK_PORT} on 127.0.0.1, which a run with a lane holds while it runs, is in use by something else`
          : `another \`bun run check\` with a lane is running on this PC (pid ${held.heldBy}); the tests are bound by timing, so wait for it to end`);
      }
      cleanups.push(held.release);
    }
    if (todo.fast) {
      code = await actionlint(run, plain);
      for (const [label, command] of [
        ["generated types are fresh", [bun, "run", "generate:types", "--check"]],
        ["typecheck", [bun, "run", "typecheck"]],
        ["build", [bun, "run", "build"]],
        ["unit tests", [bun, "run", "test:unit"]],
      ] as const) {
        if (code !== 0) break;
        code = await run(label, [...command], plain);
      }
    }
    if (code === 0 && needsHerdr) {
      const herdr = process.env["HERDR_WEB_HERDR_BIN"] || "herdr";
      if (!Bun.which(herdr)) throw new Error("this needs herdr on PATH (or HERDR_WEB_HERDR_BIN)");
      const isolation = isolate(process.env);
      cleanups.push(isolation.remove);
      const env = { ...isolation.env, ...identity };
      // every session in the run's own config directory is the run's: the browser scripts leave theirs running
      cleanups.push(() => {
        for (const session of existsSync(isolation.sessions) ? readdirSync(isolation.sessions) : []) {
          spawnSync(herdr, ["--session", session, "server", "stop"], { env, stdio: "ignore", timeout: 10_000 });
        }
      });
      console.log(`\ncheck: herdr session ${env["HERDR_TEST_SESSION"]}, config and state in ${resolve(isolation.sessions, "../../..")}`);
      if (todo.command) code = await run("run", todo.command, env);
      else {
        // the browser scripts serve dist/, and the fast steps have built it already
        if (!todo.fast) code = await run("build", [bun, "run", "build"], env);
        if (code === 0) code = await run("lanes", [bun, "scripts/ci-lanes.ts", ...todo.lanes.map((lane) => `${lane}=${LANES[lane]}`)], env);
      }
    }
  } catch (error) {
    console.error(`check: ${(error as Error).message}`);
    code = 1;
  } finally {
    cleanup();
  }
  if (times.length > 1) {
    console.log("");
    for (const step of times) console.log(`${step.code === 0 ? "ok    " : "FAILED"} ${step.label} (${step.seconds.toFixed(1)}s)`);
  }
  process.exit(code);
}

/** How long a step's processes get to end after a signal before they are killed. */
const END_GRACE_MS = 5_000;

/** Signals a process group and waits until no process is left in it, killing what outlasts the grace. */
async function endGroup(group: number, signal: NodeJS.Signals): Promise<void> {
  // only "no such process" says the group is empty: a process that may not be signalled is still there
  const none = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ESRCH";
  const left = (): boolean => { try { process.kill(-group, 0); return true; } catch (error) { return !none(error); } };
  const gone = async (ms: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; left();) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  try { process.kill(-group, signal); } catch (error) { if (none(error)) return; }
  if (await gone(END_GRACE_MS)) return;
  try { process.kill(-group, "SIGKILL"); } catch (error) { if (none(error)) return; }
  if (!(await gone(2_000))) console.error(`check: processes of the interrupted step are still running (process group ${group})`);
}

/**
 * Workflow syntax, with the release CI pins. It is fetched once into node_modules/.cache; a
 * platform the pin does not cover leaves the check to CI, and says so.
 */
async function actionlint(run: (label: string, command: string[], env: Record<string, string | undefined>) => Promise<number>, env: Record<string, string | undefined>): Promise<number> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    console.log("\n=== workflow syntax: skipped (actionlint is pinned for Linux x64; CI checks it)");
    return 0;
  }
  const dir = join("node_modules", ".cache", `actionlint-${ACTIONLINT.version}`);
  const binary = join(dir, "actionlint");
  if (!existsSync(binary)) {
    const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT.version}/actionlint_${ACTIONLINT.version}_linux_amd64.tar.gz`;
    let archive: Uint8Array | null = null;
    for (let attempt = 1; attempt <= 3 && !archive; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (response.ok) archive = new Uint8Array(await response.arrayBuffer());
      } catch { /* tried again */ }
    }
    if (!archive) { console.error(`check: could not fetch ${url}`); return 1; }
    const sha256 = createHash("sha256").update(archive).digest("hex");
    if (sha256 !== ACTIONLINT.sha256) { console.error(`check: actionlint ${ACTIONLINT.version} has SHA-256 ${sha256}, not the pinned one`); return 1; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "actionlint.tgz"), archive);
    const unpacked = spawnSync("tar", ["xzf", "actionlint.tgz", "actionlint"], { cwd: dir, stdio: "inherit" });
    rmSync(join(dir, "actionlint.tgz"), { force: true });
    if (unpacked.status !== 0) return 1;
  }
  return run("workflow syntax", [binary, "-shellcheck="], env);
}

// last: main() uses every constant above
if (import.meta.main) await main();
