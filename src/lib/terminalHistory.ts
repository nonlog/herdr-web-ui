/** A bounded, passive history cache. No scroll/input/resize command may enter this module. */
export const HISTORY_INITIAL_LINES = 512;
export const HISTORY_MAX_LINES = 20_000;
export const HISTORY_REFRESH_MS = 1500;

export interface HistorySnapshot { text: string; truncated: boolean }
export type HistoryReader = (pane: string, lines: number, signal: AbortSignal) => Promise<HistorySnapshot>;

/** One request at a time per pane epoch; stale completions cannot alter a new pane's cache. */
export class TerminalHistoryCache {
  pane: string | null = null;
  snapshot: HistorySnapshot | null = null;
  loadedLines = 0;
  wantedLines = HISTORY_INITIAL_LINES;
  stale = true;
  loading = false;
  error = false;
  private epoch = 0;
  private changes = 0;
  private controller: AbortController | null = null;

  constructor(private readonly read: HistoryReader, private readonly changed: () => void) {}

  reset(pane: string | null): void {
    this.epoch++;
    this.controller?.abort();
    this.controller = null;
    this.pane = pane;
    this.snapshot = null;
    this.loadedLines = 0;
    this.wantedLines = HISTORY_INITIAL_LINES;
    this.stale = true;
    this.loading = false;
    this.error = false;
    this.changes++;
  }

  invalidate(): void { this.stale = true; this.changes++; }

  /** Refresh only while the user is at live bottom. A read view is deliberately frozen. */
  refresh(): void {
    if (!this.stale && this.snapshot) return;
    if (!this.loading) this.wantedLines = HISTORY_INITIAL_LINES;
    this.ensure(HISTORY_INITIAL_LINES, true);
  }

  ensure(lines: number, refresh = false): void {
    const pane = this.pane;
    if (pane === null) return;
    const wanted = Math.min(HISTORY_MAX_LINES, Math.max(HISTORY_INITIAL_LINES, Math.ceil(lines)));
    this.wantedLines = Math.max(this.wantedLines, wanted);
    // Cached rows paint immediately, even if newer live output arrived. Never invalidate a
    // reading position just to refresh it. An explicit expansion can fetch a larger snapshot.
    if (!refresh && this.snapshot && (this.loadedLines >= wanted || !this.snapshot.truncated)) return;
    if (this.loading) return;
    const epoch = this.epoch;
    const changes = this.changes;
    const requested = this.wantedLines;
    const controller = new AbortController();
    this.controller = controller;
    this.loading = true;
    this.error = false;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    this.changed();
    void Promise.resolve().then(() => this.read(pane, requested, controller.signal)).then((snapshot) => {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      this.snapshot = snapshot;
      this.loadedLines = requested;
      this.stale = this.changes !== changes;
    }).catch(() => {
      if (epoch === this.epoch) this.error = true;
    }).finally(() => {
      clearTimeout(timeout);
      if (epoch !== this.epoch) return;
      this.loading = false;
      this.controller = null;
      if (controller.signal.aborted) this.error = true;
      this.changed();
      // Only a queued expansion follows automatically, never a failed/stale refresh loop.
      if (!this.error && this.snapshot?.truncated && this.wantedLines > requested) this.ensure(this.wantedLines);
    });
  }
}

/** Accumulate trackpad/touch fractions instead of rounding every small event to a full row. */
export function accumulateHistoryWheel(remainder: number, deltaRows: number, speed: number): { lines: number; remainder: number } {
  if (!Number.isFinite(deltaRows)) return { lines: 0, remainder };
  const total = remainder + deltaRows * (Number.isFinite(speed) ? Math.max(1, speed) : 1);
  const lines = Math.trunc(total);
  return { lines, remainder: total - lines };
}
