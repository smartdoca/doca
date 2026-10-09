import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "@web/shared/clipboard.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";

export function QrLogin({ logged }: { logged: () => Promise<void> }) {
  const { t } = useI18n();
  const loggedRef = useRef(logged);
  loggedRef.current = logged;
  const [svg, setSvg] = useState("");
  const [payload, setPayload] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    async function issue() {
      const response = await fetch("/api/v1/auth/qr", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "二维码生成失败");
      if (stop) return;
      if (typeof data.svg !== "string" || !data.svg.includes("<svg") || data.svg.includes("<script"))
        throw new Error("二维码生成失败");
      setSvg(data.svg);
      setPayload(typeof data.payload === "string" ? data.payload : "");
      setError("");
      const wait = async () => {
        if (stop) return;
        try {
          const status = await fetch(`/api/v1/auth/qr/${data.code}`, {
            headers: {
              accept: "application/json",
              "x-doca-qr-secret": data.secret,
            },
          });
          const body = await status.json().catch(() => ({}));
          if (stop) return;
          if (body.status === "active") {
            await loggedRef.current();
            return;
          }
          if (status.status === 410) {
            void issue().catch((reason: Error) => setError(reason.message));
            return;
          }
          if (!status.ok) {
            setError(body.message ?? "登录状态查询失败");
            return;
          }
        } catch (reason) {
          if (!stop) setError(reason instanceof Error ? reason.message : "登录状态查询失败");
        }
        if (!stop) timer = window.setTimeout(() => void wait(), 2000);
      };
      timer = window.setTimeout(() => void wait(), 1500);
    }
    void issue().catch((reason: Error) => setError(reason.message));
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="qr-login">
      {svg ? (
        <div role="img" aria-label="登录二维码" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p>正在生成二维码…</p>
      )}
      <p>打开 Doca App，在设置里选择「扫码登录网页」。</p>
      {payload ? (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            void writeClipboardText(payload).then(() => {
              setError("");
              setCopied(true);
            }).catch(() => {
              setError(t("fileManager.copyFailed"));
            });
          }}
        >
          {copied ? "已复制" : "复制二维码内容"}
        </button>
      ) : null}
      <Feedback message={error} tone="error" />
    </div>
  );
}
