export type ReferenceTextPart = { text: string } | { referenceIndex: number };

/** Replace only serialized Sender tags backed by this message's references. */
export function referenceTextParts(text: string, labels: string[]): ReferenceTextPart[] {
  const parts: ReferenceTextPart[] = [];
  const used = new Set<number>();
  let cursor = 0;
  while (cursor < text.length) {
    let next = -1, index = -1, marker = "";
    labels.forEach((label, i) => {
      const candidate = `@【${label}】`;
      const at = text.indexOf(candidate, cursor);
      if (at !== -1 && (next === -1 || at < next || (at === next && used.has(index) && !used.has(i)))) {
        next = at; index = i; marker = candidate;
      }
    });
    if (next === -1) { parts.push({ text: text.slice(cursor) }); break; }
    if (next > cursor) parts.push({ text: text.slice(cursor, next) });
    parts.push({ referenceIndex: index }); used.add(index);
    cursor = next + marker.length;
  }
  return parts;
}
