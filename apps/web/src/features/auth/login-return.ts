const key = "doca.login-document";

export function isDocumentLocation(hash: string): boolean {
  return /^#\/(?:m\/)?r\/[a-f0-9-]{36}(?:\?[^#]*)?$/i.test(hash);
}

export function rememberLoginDocument(hash: string) {
  if (!isDocumentLocation(hash)) return;
  try {
    sessionStorage.setItem(key, hash);
  } catch {}
}

export function takeLoginDocument(): string | null {
  try {
    const hash = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return hash && isDocumentLocation(hash) ? hash : null;
  } catch {
    return null;
  }
}
