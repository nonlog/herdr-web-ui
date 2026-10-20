import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "./commands.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { paneAgentOf, resolveAgent } from "./pane-context.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pane-routes-"));
  panes = {};
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string } };
        const id = request.params?.pane_id ?? "";
        const result = request.method === "pane.get" ? { pane: paneInfo(id) }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: panes[id]?.process ?? [] } }
          : request.method === "session.snapshot" ? { snapshot: { panes: Object.keys(panes).map(paneInfo), agents: [] } }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const OMO_PROCESS = { pid: 2147483647, argv: ["omo"], cwd: "" };

it("names an omo pane that herdr labels pi omo in the commands route, and types into it as omo only once omo holds a session", async () => {
  panes["w:p1"] = { agent: "pi", process: [{ ...OMO_PROCESS, cwd: root }] };
  panes["w:p2"] = { agent: "pi", process: [{ pid: 2147483646, argv: ["/usr/bin/pi"], cwd: root }] };
  // typing needs omo's own holder record (server/core/omo-pane-send.test.ts): an argv alone keeps herdr's label
  expect(await paneAgentOf("w:p1")).toBe("pi");
  // an ordinary pi stays pi
  expect(await paneAgentOf("w:p2")).toBe("pi");

  // omo's own palette says "Quit omo"; pi's says something else
  const quit = async (paneId: string) => {
    const url = new URL(`http://x/api/pane/commands?pane_id=${paneId}`);
    const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
    return ((await response!.json()) as { commands: { name: string; description: string }[] }).commands.find((command) => command.name === "quit")?.description;
  };
  expect(paneCommands("omo", root).find((command) => command.name === "quit")?.description).toBe("Quit omo");
  expect(await quit("w:p1")).toBe("Quit omo");
  expect(await quit("w:p2")).toBe(paneCommands("pi", root).find((command) => command.name === "quit")?.description);
});

it("resolves a pane with no agent to null and its commands route to []", async () => {
  panes["w:p3"] = { process: [] };
  expect(await paneAgentOf("w:p3")).toBeNull();
  const url = new URL("http://x/api/pane/commands?pane_id=w:p3");
  const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
  expect(await response!.json()).toEqual({ commands: [] });
});

const claudeLine = (version: string) => JSON.stringify({ type: "user", version, message: { role: "user", content: "hi" } }) + "\n";

it("reads a version from the store the pane's own transcript names, and leaks none to another pane", () => {
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  writeFileSync(first, claudeLine("2.1.100"));
  writeFileSync(second, claudeLine("2.1.200"));
  const pane = (agent: string) => ({ agent }) as never;
  expect(resolveAgent(pane("claude"), null, { path: first })).toEqual({ agent: "claude", version: "2.1.100" });
  expect(resolveAgent(pane("claude"), null, { path: second })).toEqual({ agent: "claude", version: "2.1.200" });
  expect(resolveAgent(pane("claude"), null, { path: first }).version).toBe("2.1.100");
  // no store, an agent that keeps no version, an omo pane: unverified
  expect(resolveAgent(pane("claude"), null).version).toBeNull();
  expect(resolveAgent(pane("pi"), null, { path: first }).version).toBeNull();
  expect(resolveAgent(pane("claude"), { omo: { agentDir: null, pluginDir: null } }, { path: first })).toEqual({ agent: "omo", version: null });
  // a session report names the agent when herdr's label is absent
  expect(resolveAgent({ agent_session: { agent: "codex" } } as never, null).agent).toBe("codex");
  expect(resolveAgent({} as never, null)).toEqual({ agent: null, version: null });
});
