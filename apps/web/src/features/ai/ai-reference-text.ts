export type ReferenceTextPart =
  | { text: string }
  | { referenceIndex: number }
  | { noteIndex: number };

/** Replace only serialized Sender tags backed by this message's references. */
export function referenceTextParts(
  text: string,
  labels: string[],
  noteMarkers: { label: string; id?: string }[] = [],
): ReferenceTextPart[] {
  const parts: ReferenceTextPart[] = [];
  const used = new Set<number>();
  const usedNotes = new Set<number>();
  let cursor = 0;
  while (cursor < text.length) {
    let next = -1,
      index = -1,
      note = -1,
      marker = "";
    labels.forEach((label, i) => {
      const candidate = `@【${label}】`;
      const at = text.indexOf(candidate, cursor);
      if (
        at !== -1 &&
        (next === -1 ||
          at < next ||
          (at === next && note === -1 && used.has(index) && !used.has(i)))
      ) {
        next = at;
        index = i;
        note = -1;
        marker = candidate;
      }
    });
    noteMarkers.forEach((m, i) => {
      const candidate = `@【${m.label}${m.id ? `#${m.id}` : ""}】`;
      const at = text.indexOf(candidate, cursor);
      if (
        at !== -1 &&
        (next === -1 ||
          at < next ||
          (at === next && note !== -1 && usedNotes.has(note) && !usedNotes.has(i)))
      ) {
        next = at;
        note = i;
        index = -1;
        marker = candidate;
      }
    });
    if (next === -1) {
      parts.push({ text: text.slice(cursor) });
      break;
    }
    if (next > cursor) parts.push({ text: text.slice(cursor, next) });
    if (note !== -1) {
      parts.push({ noteIndex: note });
      usedNotes.add(note);
    } else {
      parts.push({ referenceIndex: index });
      used.add(index);
    }
    cursor = next + marker.length;
  }
  return parts;
}
