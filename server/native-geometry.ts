/** Follow native pane layouts, never browser viewport dimensions. One bounded read for all panes. */
export interface NativeGrid { cols: number; rows: number }
export function validNativeGrid(grid: NativeGrid | undefined): grid is NativeGrid {
  return !!grid && Number.isInteger(grid.cols) && Number.isInteger(grid.rows)
    && grid.cols > 0 && grid.rows > 0 && grid.cols <= 1000 && grid.rows <= 1000;
}
interface Watch { current: NativeGrid; apply: (grid: NativeGrid) => void }

export class NativeGeometryFollower {
  private readonly watches = new Map<string, Watch>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly read: () => Promise<ReadonlyMap<string, NativeGrid>>, private readonly intervalMs = 500) {}

  watch(pane: string, current: NativeGrid, apply: Watch["apply"]): () => void {
    if (this.stopped) return () => {};
    const watch = { current: { ...current }, apply };
    this.watches.set(pane, watch);
    this.schedule();
    return () => {
      if (this.watches.get(pane) !== watch) return;
      this.watches.delete(pane);
      if (!this.watches.size) { clearTimeout(this.timer); this.timer = undefined; }
    };
  }

  private schedule(): void {
    if (this.stopped || !this.watches.size || this.timer || this.pending) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, this.intervalMs);
    this.timer.unref();
  }

  /** Serial, generation-safe reads: late results cannot resize a retired/replaced controller. */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped || !this.watches.size) return Promise.resolve();
    clearTimeout(this.timer); this.timer = undefined;
    const captured = [...this.watches];
    const pass = Promise.resolve().then(this.read).then((grids) => {
      if (this.stopped) return;
      for (const [pane, watch] of captured) {
        if (this.watches.get(pane) !== watch) continue;
        const grid = grids.get(pane);
        if (!validNativeGrid(grid) || (grid.cols === watch.current.cols && grid.rows === watch.current.rows)) continue;
        watch.apply(grid);
        watch.current = { ...grid };
      }
    }).catch(() => {
      // An unavailable native layout never justifies guessing a size or closing the terminal.
    }).finally(() => {
      if (this.pending === pass) this.pending = null;
      this.schedule();
    });
    this.pending = pass;
    return pass;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.watches.clear();
  }
}
