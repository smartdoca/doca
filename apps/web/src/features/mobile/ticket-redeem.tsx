import { useEffect, useState } from "react";

const documentPath = /^\/m\/r\/[a-f0-9-]{36}$/;

export function MobileTicketRedeem() {
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    const ticket = params.get("ticket") ?? "";
    const to = params.get("to") ?? "";
    const find = params.get("find")?.trim();
    if (!/^[a-f0-9]{64}$/.test(ticket) || !(documentPath.test(to) || /^\/m\/plugins\/[a-z][a-z0-9.-]*\/[a-zA-Z0-9/_-]*$/.test(to))) {
      setError("打开链接无效");
      return;
    }
    let active = true;
    void fetch(to.startsWith("/m/plugins/") ? "/api/v1/plugins-mobile/redeem" : "/api/v1/auth/webview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.message ?? "无法打开文档");
        }
        if (!active) return;
        const target = documentPath.test(to) && find
          ? `${to}?${new URLSearchParams({ find })}`
          : to;
        location.replace(`${location.pathname}${location.search}#${target}`);
        location.reload();
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "无法打开文档");
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <main className="auth">
      <section className="auth-card">
        <h1>正在打开文档</h1>
        <p>{error || "正在连接编辑器…"}</p>
      </section>
    </main>
  );
}

export function postMobileEditor(message: { type: string; title?: string; format?: string }) {
  const bridge = (window as Window & { ReactNativeWebView?: { postMessage: (value: string) => void } }).ReactNativeWebView;
  bridge?.postMessage(JSON.stringify(message));
}
