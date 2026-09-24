export type UserCardSettings = {
  enabled: boolean;
  text: string;
  style: "primary" | "secondary" | "link";
  url: string;
  revision: number;
};
export const defaultUserCard: UserCardSettings = {
  enabled: false,
  text: "查看主页",
  style: "primary",
  url: "",
  revision: 0,
};
/** Public user ID and internal UUID are encoded as values, never executable markup. */
export function userCardUrl(
  template: string,
  userId: string,
  uid: string,
): string | null {
  const value = template
    .replaceAll("{userId}", encodeURIComponent(userId))
    .replaceAll("{uid}", encodeURIComponent(uid));
  if (!value || /[{}\s\\]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
