export const SEMANTIC_WHEEL_MIN_INTERVAL_MS = 40;

/** Browser pixel wheels use about 100-120 px for one physical notch on Windows.
 * Treating 40 px as one terminal row gives the familiar ~3-row terminal scroll
 * while still letting high-resolution trackpads accumulate fractional rows. */
const PIXELS_PER_LINE = 40;

export function semanticWheelDeltaLines(deltaY: number, deltaMode: number, rows: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY;
  if (deltaMode === 2) return deltaY * Math.max(1, rows);
  return deltaY / PIXELS_PER_LINE;
}

export function semanticWheelIntent(
  signedLines: number,
  speed: number,
): { direction: "up" | "down"; lines: number } | null {
  if (!Number.isFinite(signedLines) || Math.abs(signedLines) < 0.01) return null;
  const multiplier = Number.isFinite(speed) ? Math.max(1, speed) : 1;
  return {
    direction: signedLines < 0 ? "up" : "down",
    lines: Math.min(1000, Math.max(1, Math.round(Math.abs(signedLines) * multiplier))),
  };
}
