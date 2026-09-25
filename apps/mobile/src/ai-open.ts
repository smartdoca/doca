type Nav = {
  push: (path: string | { pathname: string; params?: Record<string, string> }) => void;
};

type TrailItem = { type?: string; id?: string; name?: string };

function normalizeHref(href: string) {
  let raw = href.trim();
  if (/^https?:/i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = `${url.hash.replace(/^#/, "") || url.pathname}${url.search}`;
    } catch {
      return "";
    }
  }
  raw = raw.replace(/^#/, "").replace(/^\/m(?=\/)/, "");
  return raw;
}

export function openAiHref(router: Nav, href: string) {
  const raw = normalizeHref(href);
  if (!raw) return false;
  const split = raw.indexOf("?");
  const path = (split === -1 ? raw : raw.slice(0, split)).replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(split === -1 ? "" : raw.slice(split + 1));
  const document = /^\/r\/([a-f0-9-]{36})$/i.exec(path);
  if (document?.[1]) {
    router.push({ pathname: "/document/[id]", params: { id: document[1] } });
    return true;
  }
  const shared = /^\/shared-files\/([^/]+)$/.exec(path);
  if (shared?.[1] && shared[1] !== "join") {
    router.push({
      pathname: "/folder/[id]",
      params: {
        id: decodeURIComponent(shared[1]),
        title: query.get("name") || "共享文件夹",
        parentType: "folder",
      },
    });
    return true;
  }
  if (path === "/files") {
    const encoded = query.get("path");
    if (encoded) {
      try {
        const trail = JSON.parse(encoded) as TrailItem[];
        const last = [...trail].reverse().find((item) => item.id && item.id !== "root");
        if (last?.id) {
          router.push({
            pathname: "/folder/[id]",
            params: {
              id: last.id,
              title: last.name || "文件夹",
              parentType: last.type === "system" || last.type === "document" ? last.type : "folder",
            },
          });
          return true;
        }
      } catch {
        // Fall through to the files tab.
      }
    }
    router.push("/files");
    return true;
  }
  return false;
}

export function openDocument(router: Nav, id: string | undefined) {
  if (!id) return;
  router.push({ pathname: "/document/[id]", params: { id } });
}
