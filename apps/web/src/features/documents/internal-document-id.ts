export function internalDocumentId(
  value: string,
  origin: string,
): string | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin) return null;
    return (
      /^#\/r\/([a-f0-9-]{36})(?:\?|$)/i.exec(url.hash)?.[1]?.toLowerCase() ??
      null
    );
  } catch {
    return null;
  }
}
