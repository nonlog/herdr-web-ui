import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { paneScrollInfo, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-terminal-control-"));
const first = createServer({
  port: 0,
  hostname: "127.0.0.1",
  token: "",
  stateDir: join(root, "first"),
  terminalAttach: false,
  terminalControl: true,
  attachHeldRetryMs: 100,
});
const second = createServer({
  port: 0,
  hostname: "127.0.0.1",
  token: "",
  stateDir: join(root, "second"),
  terminalAttach: false,
  terminalControl: true,
  attachHeldRetryMs: 100,
});
const workspaces: string[] = [];
const sockets: WebSocket[] = [];

afterAll(async () => {
  for (const socket of sockets) socket.close();
  first.stop();
  second.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

function connect(port: number, paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = {
    data: "",
    ready: 0,
    resumed: 0,
    exits: 0,
    errors: [] as string[],
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "pty-data" && frame.pane_id === paneId) state.data = (state.data + frame.data).slice(-131072);
    if (frame.type === "input-ready" && frame.pane_id === paneId && frame.ready !== false) state.ready++;
    if (frame.type === "attach-resumed" && frame.pane_id === paneId) state.resumed++;
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type === "error" && (frame.pane_id === undefined || frame.pane_id === paneId)) state.errors.push(frame.code);
  });
  const send = (message: ClientMessage): void => ws.send(JSON.stringify(message));
  return {
    ws,
    state,
    send,
    open: until(() => ws.readyState === WebSocket.OPEN, "websocket open"),
  };
}

describe("terminal session control transport", () => {
  it("streams, scrolls, waits for an existing controller and supports explicit takeover", async () => {
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-terminal-control" });
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const a = connect(first.port, paneId);
    const b = connect(second.port, paneId);
    try {
      await a.open;
      a.send({ type: "attach", pane_id: paneId, cols: 90, rows: 24 });
      await until(() => a.state.ready > 0, "first controller ready");

      a.send({ type: "input", pane_id: paneId, text: "for i in $(seq 1 80); do echo control-line-$i; done\r" });
      await until(() => a.state.data.includes("control-line-80"), "controller receives shell output");

      expect((await paneScrollInfo(paneId))?.offset_from_bottom ?? 0).toBe(0);
      a.send({ type: "scroll", pane_id: paneId, direction: "up", lines: 10 });
      await until(async () => (await paneScrollInfo(paneId))?.offset_from_bottom === 10, "semantic scroll moves herdr history");
      a.send({ type: "scroll", pane_id: paneId, direction: "down", lines: 10 });
      await until(async () => (await paneScrollInfo(paneId))?.offset_from_bottom === 0, "semantic scroll returns to bottom");

      await b.open;
      b.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await until(() => b.state.errors.includes("attach_held"), "second bridge waits for controller");
      await Bun.sleep(300);
      expect(b.state.exits).toBe(0);
      expect(b.state.ready).toBe(0);

      b.send({ type: "take-over", pane_id: paneId });
      await until(() => b.state.resumed > 0 && b.state.ready > 0, "second bridge explicitly takes controller");
      await until(() => a.state.errors.includes("attach_held"), "displaced first bridge waits instead of ending");
      expect(a.state.exits).toBe(0);

      b.send({ type: "input", pane_id: paneId, text: "echo control-takeover-ok\r" });
      await until(() => b.state.data.includes("control-takeover-ok"), "taken-over controller accepts input");
    } finally {
      a.ws.close();
      b.ws.close();
    }
  }, 30_000);
});
