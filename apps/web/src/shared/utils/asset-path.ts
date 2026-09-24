/** Only persisted platform IDs and exact same-origin content paths are resolved. */
export function platformAssetId(path: string) {
  const id = /^[a-f0-9-]{36}$/.test(path)
    ? path
    : /^\/api\/v1\/assets\/([a-f0-9-]{36})\/content$/.exec(path)?.[1];
  return id ?? null;
}
