import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolate, lock, plan } from "./check.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "hwc-test-")); made.push(dir); return dir; };

describe("plan", () => {
  it("reads the modes: the fast steps, the lanes, both, or one command", () => {
    expect(plan(["fast"])).toEqual({ fast: true, lanes: [], command: null });
    expect(plan(["browser"])).toEqual({ fast: false, lanes: ["browser"], command: null });
    expect(plan(["browser", "integration"])).toEqual({ fast: false, lanes: ["integration", "browser"], command: null });
    expect(plan(["full"])).toEqual({ fast: true, lanes: ["integration", "browser"], command: null });
    expect(plan(["run", "bun", "test", "./a.test.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "test", "./a.test.ts"] });
  });

  it("refuses what it does not know instead of running something else", () => {
    for (const args of [[], ["quick"], ["fast", "run"], ["run"]]) expect(() => plan(args)).toThrow("Usage");
  });
});

describe("isolate", () => {
  it("points herdr, its plugins and the web UI at one directory of the run's own, under its own session name", () => {
    const first = isolate({ PATH: "/bin", XDG_CONFIG_HOME: "/home/someone/.config" });
    const second = isolate({ PATH: "/bin" });
    try {
      expect(first.env["PATH"]).toBe("/bin");
      expect(first.env["XDG_CONFIG_HOME"]).not.toBe("/home/someone/.config");
      for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_WEB_STATE_DIR"]) {
        expect(existsSync(first.env[name]!)).toBe(true);
        expect(first.env[name]).not.toBe(second.env[name]);
      }
      expect(first.sessions).toBe(join(first.env["XDG_CONFIG_HOME"]!, "herdr", "sessions"));
      expect(first.env["HERDR_TEST_SESSION"]).toMatch(/^check-[0-9a-f]{6}$/);
      expect(first.env["HERDR_TEST_SESSION"]).not.toBe(second.env["HERDR_TEST_SESSION"]);
      // one integration file at a time unless asked otherwise
      expect(first.env["HERDR_TEST_SHARDS"]).toBe("1");
      expect(isolate({ HERDR_TEST_SHARDS: "4" }, scratch()).env["HERDR_TEST_SHARDS"]).toBe("4");
    } finally {
      const dir = join(first.env["XDG_CONFIG_HOME"]!, "..");
      first.remove();
      second.remove();
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("keeps a directory the caller named, and refuses one too long for a socket", () => {
    const kept = scratch();
    const isolation = isolate({}, kept);
    expect(isolation.env["XDG_CONFIG_HOME"]).toBe(join(kept, "config"));
    isolation.remove();
    expect(existsSync(join(kept, "config"))).toBe(true);
    expect(() => isolate({}, join(scratch(), "a".repeat(80)))).toThrow("too long for a unix socket");
  });

  it("refuses to run in the herdr the user works in, and hands on nothing that names it", () => {
    expect(() => isolate({ HERDR_TEST_LIVE: "1" }, scratch())).toThrow("HERDR_TEST_LIVE");
    // as a shell inside one of the user's panes has them
    const { env } = isolate({ HERDR_SOCKET: "/live.sock", HERDR_SOCKET_PATH: "/live.sock", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_WEB_HERDR_BIN: "/bin/herdr" }, scratch());
    expect(Object.keys(env).filter((name) => name.startsWith("HERDR_")).sort()).toEqual(["HERDR_TEST_SESSION", "HERDR_TEST_SHARDS", "HERDR_WEB_HERDR_BIN", "HERDR_WEB_STATE_DIR"]);
  });
});

describe("lock", () => {
  /** a port nothing listens on: asked of the system, then given back */
  const freePort = async (): Promise<number> => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    return port;
  };

  it("lets one run in, names the run that holds it, and is free again once released", async () => {
    const port = await freePort();
    const first = await lock(port, 111);
    expect("release" in first).toBe(true);
    expect(await lock(port, 222)).toEqual({ heldBy: 111 });
    (first as { release: () => void }).release();
    const next = await lock(port, 222);
    expect("release" in next).toBe(true);
    (next as { release: () => void }).release();
  });

  it("says so when something that is no run listens on the port", async () => {
    const other = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.end("hello"); }, data() {} } });
    try {
      expect(await lock(other.port, 222)).toEqual({ heldBy: Number.NaN });
    } finally {
      other.stop(true);
    }
  });
});
