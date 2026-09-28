/** Resolve pasted Doca links, IDs or exact document titles against the caller's visible list. */
export function resolveDocumentReferences(
  text: string,
  rows: Array<{ id: string; label: string }>,
) {
  const ids: string[] = [],
    unresolved: string[] = [];
  for (const line of text
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const id = line.match(
      /(?:^|(?:#?\/r\/))([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[?#\s])/i,
    )?.[1];
    const matches = rows.filter((row) =>
      id
        ? row.id === id
        : row.label === line || row.label.split(" / ").at(-1) === line,
    );
    if (matches.length === 1) ids.push(matches[0]!.id);
    else unresolved.push(line);
  }
  return { ids: [...new Set(ids)], unresolved };
}
