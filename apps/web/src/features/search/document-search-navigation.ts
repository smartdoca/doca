/** Navigation intent only: never stored in document content or collaboration state. */
export function searchDocumentHash(
  resource: { id: string; kind: string },
  query: string,
): string {
  const path = `#/r/${resource.id}`;
  return resource.kind === "document" && query.trim()
    ? `${path}?${new URLSearchParams({ find: query.trim() })}`
    : path;
}

export function documentSearchQuery(
  hash: string,
  documentId: string,
): string | null {
  const split = hash.indexOf("?");
  const path = split < 0 ? hash : hash.slice(0, split);
  if (path !== `#/r/${documentId}` && path !== `#/m/r/${documentId}`)
    return null;
  const query = new URLSearchParams(split < 0 ? "" : hash.slice(split + 1)).get(
    "find",
  );
  return query?.trim() || null;
}

export function openSearchDocument(
  resource: { id: string; kind: string },
  query: string,
): void {
  const hash = searchDocumentHash(resource, query);
  if (window.location.hash === hash) {
    // A second click on the same result must reopen find even after it was closed.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else window.location.hash = hash;
}
