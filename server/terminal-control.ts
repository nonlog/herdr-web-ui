/**
 * Herdr's newline-JSON terminal bridge. Unlike `terminal attach`, this works on
 * native Windows without a PTY sidecar: herdr renders ANSI frames itself and
 * accepts semantic input, resize, scroll and mouse commands on stdin.
 */
export interface TerminalControlOptions {
  command: string;
  target: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  takeover?: boolean;
  onData: (data: string) => void;
  onExit: (code: number | null, reason?: string) => void;
}

type TerminalControlFrame =
  | { type: "terminal.frame"; encoding: "ansi"; bytes: string; full?: boolean; width?: number; height?: number; seq?: number }
  | { type: "terminal.closed"; reason?: string };

export function decodeTerminalControlLine(line: string): TerminalControlFrame | null {
  let frame: unknown;
  try { frame = JSON.parse(line); } catch { return null; }
  if (!frame || typeof frame !== "object") return null;
  const value = frame as Record<string, unknown>;
  if (value.type === "terminal.closed") {
    return { type: "terminal.closed", ...(typeof value.reason === "string" ? { reason: value.reason } : {}) };
  }
  if (value.type !== "terminal.frame" || value.encoding !== "ansi" || typeof value.bytes !== "string") return null;
  return {
    type: "terminal.frame",
    encoding: "ansi",
    bytes: value.bytes,
    ...(typeof value.full === "boolean" ? { full: value.full } : {}),
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
    ...(typeof value.seq === "number" ? { seq: value.seq } : {}),
  };
}

export class TerminalControlSession {
  readonly exited: Promise<void>;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private closed = false;
  private paused = false;
  private resumePump!: () => void;
  private resumed: Promise<void> = Promise.resolve();
  private closeReason: string | undefined;

  constructor(private readonly options: TerminalControlOptions) {
    this.proc = Bun.spawn([
      options.command,
      "terminal", "session", "control", options.target,
      ...(options.takeover ? ["--takeover"] : []),
      "--cols", String(options.cols), "--rows", String(options.rows),
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    this.exited = Promise.all([this.proc.exited, this.pump()]).then(([code]) => {
      if (this.closed) return;
      this.closed = true;
      options.onExit(code ?? null, this.closeReason);
    });
  }

  private async pump(): Promise<void> {
    const stream = this.proc.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        if (this.paused) await this.resumed;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) this.consume(line);
          newline = pending.indexOf("\n");
        }
      }
      pending += decoder.decode();
      const tail = pending.trim();
      if (tail) this.consume(tail);
    } catch {
      /* the controller exited while its output was being read */
    } finally {
      reader.releaseLock();
    }
  }

  private consume(line: string): void {
    const frame = decodeTerminalControlLine(line);
    if (!frame) return;
    if (frame.type === "terminal.closed") {
      this.closeReason = frame.reason;
      return;
    }
    try {
      const data = Buffer.from(frame.bytes, "base64").toString("utf8");
      // The first full frame can be empty (a blank shell). Deliver it anyway so the
      // attachment can become input-ready without waiting for the first visible byte.
      this.options.onData(data);
    } catch {
      /* malformed frame bytes are ignored rather than painted into the terminal */
    }
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.closed) return false;
    const sink = this.proc.stdin;
    if (!sink || typeof sink === "number" || !("write" in sink)) return false;
    try {
      sink.write(`${JSON.stringify(frame)}\n`);
      sink.flush();
      return true;
    } catch {
      return false;
    }
  }

  write(data: string): boolean {
    return this.send({ type: "terminal.input", text: data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "terminal.resize", cols, rows });
  }

  scroll(direction: "up" | "down", lines: number, column?: number, row?: number, modifiers = 0): boolean {
    return this.send({
      type: "terminal.scroll", direction, lines, source: "wheel",
      ...(column === undefined ? {} : { column }),
      ...(row === undefined ? {} : { row }),
      ...(modifiers === 0 ? {} : { modifiers }),
    });
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.resumed = new Promise((resolve) => { this.resumePump = resolve; });
  }

  resumeOutput(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.resumePump();
  }

  /** PtySession-compatible name used by the shared output backpressure path. */
  resume(): void {
    this.resumeOutput();
  }

  kill(): void {
    if (this.closed) return;
    this.send({ type: "terminal.release" });
    this.closed = true;
    if (this.paused) {
      this.paused = false;
      this.resumePump();
    }
    const sink = this.proc.stdin;
    try { if (sink && typeof sink !== "number" && "end" in sink) sink.end(); } catch {}
    // release normally exits immediately; the bounded kill prevents a broken CLI from leaking.
    const timer = setTimeout(() => { try { this.proc.kill(); } catch {} }, 1000);
    void this.proc.exited.finally(() => clearTimeout(timer));
  }
}

