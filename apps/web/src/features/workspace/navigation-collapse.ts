import { useEffect, useState } from "react";

/** Layout preferences stay local and never alter document data. */
export function useNavigationCollapse(key: string) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch { /* Private browsing. */ }
  }, [key, collapsed]);
  return [collapsed, setCollapsed] as const;
}

export function useDesktopNavigation() {
  const [desktop, setDesktop] = useState(() => matchMedia("(min-width: 1201px)").matches);
  useEffect(() => {
    const media = matchMedia("(min-width: 1201px)");
    const change = () => setDesktop(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return desktop;
}
