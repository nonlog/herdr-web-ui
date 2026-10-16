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
