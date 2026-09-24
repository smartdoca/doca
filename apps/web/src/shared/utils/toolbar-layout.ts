/** Widths include each item's fixed footprint; keep overflow reachable at any size. */
export function visibleToolbarCount(width: number, widths: number[], gap = 2) {
  const total =
    widths.reduce((sum, value) => sum + value, 0) +
    Math.max(0, widths.length - 1) * gap;
  if (total <= width) return widths.length;
  let used = 32; // More button plus preceding gap.
  let count = 0;
  for (const value of widths) {
    if (used + value + gap > width) break;
    used += value + gap;
    count++;
  }
  return count;
}
