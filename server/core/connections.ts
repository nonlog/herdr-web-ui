/**
 * A browser's WebSocket connection: what the upgrade records on it, how a frame is sent to it,
 * and the presence beat it sends. The connection state itself moves here in a later step.
 */
import type { ServerWebSocket } from "bun";
import type { ClientRole, ServerMessage } from "../../shared/protocol.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import type { MachineRelay } from "../machine-relay.ts";
import { OUTPUT_HARD_BYTES, type OutputWindow } from "../output-window.ts";
import type { PaneWatch } from "../watch.ts";

export interface SocketData {
  deviceId?: string;
  readOnly?: boolean;
  revoked?: boolean;
  unwatchDevice?: () => void;
  relay?: MachineRelay;
  /** A fresh claim per attach lifetime; deleting it invalidates queued terminal keys. */
  attached: Map<string, { keepSize: boolean }>;
  conversationInterests: Set<string>;
  watches: Map<string, PaneWatch>;
  output: Map<string, OutputWindow>;
  closing: boolean;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
  /** how often `mode` changed: a switch away and back during an await is still a change */
  roles: number;
}

/** A `presence` frame's answer, or null for any other frame. A relayed frame is only parsed when it can be one. */
export function presenceOf(raw: string | Buffer): boolean | null {
  const text = String(raw);
  if (!text.includes("\"presence\"")) return null;
  try {
    const message = JSON.parse(text) as { type?: unknown; active?: unknown };
    return message?.type === "presence" ? message.active === true : null;
  } catch {
    return null;
  }
}

export type Client = ServerWebSocket<SocketData>;

export function send(client: Client, message: ServerMessage): number {
  if (client.data.closing) return 0;
  try {
    const encoded = JSON.stringify(message);
    // Include JSON escaping in the transport budget, before Bun could drop a
    // frame at its own cap. An overload close is explicit and never auto-replayed.
    if (client.getBufferedAmount() + Buffer.byteLength(encoded) > OUTPUT_HARD_BYTES) {
      client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
      return 0;
    }
    // -1 means ALREADY queued. Never retry that frame, or terminal bytes repeat.
    const result = client.send(encoded);
    if (result === 0) client.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
    return result;
  } catch {
    /* client vanished mid-send */
    return 0;
  }
}
