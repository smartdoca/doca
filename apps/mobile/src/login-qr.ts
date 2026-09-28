export function parseLoginQr(value: string) {
  const match = value.trim().match(/^doca-login:(https?:\/\/[^/\s]+):([a-f0-9]{64})$/);
  if (!match?.[1] || !match[2]) return null;
  return { origin: match[1].replace(/\/+$/, ""), code: match[2] };
}
