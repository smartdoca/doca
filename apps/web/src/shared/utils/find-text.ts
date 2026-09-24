/** Literal matches (not regular expressions), including Chinese and mixed text. */
export function findTextOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const offsets: number[] = [];
  // Keep original UTF-16 offsets: locale case folding can change string length.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "giu");
  for (const match of text.matchAll(pattern)) offsets.push(match.index);
  return offsets;
}
