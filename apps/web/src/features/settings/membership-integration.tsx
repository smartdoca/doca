import { useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";

export function MembershipIntegration({
  ready,
  onReady,
}: {
  ready: boolean;
  onReady: () => void;
}) {
  const [secret, setSecret] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(generate: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ secret?: string }>(
        "/admin/entitlements/secret",
        "POST",
        generate ? { generate: true } : { secret },
      );
      setSecret(result.secret ?? "");
      onReady();
      setMessage(
        generate
          ? "新密钥已生效，请复制保存；关闭页面后不再显示。"
          : "密钥已保存并生效。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const origin = location.origin;
  const sample = `# 支付或续期成功后回写会员状态
curl '${origin}/api/v1/integrations/membership/events' \\
  -H 'Authorization: Bearer YOUR_CALLBACK_SECRET' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "eventId": "payment-001",
    "subscriptionId": "subscription-001",
    "instance": "${origin}",
    "userId": "已关联的本站用户内部 ID（UUID）",
    "planId": "下方配置的套餐 ID",
    "startsAt": "${new Date().toISOString()}",
    "expiresAt": "${new Date(Date.now() + 30 * 86400000).toISOString()}",
    "status": "active",
    "version": 1
  }'`;
  return (
    <div className="admin-form-section membership-integration">
      <label>
        回调密钥 <small>{ready ? "已配置" : "未配置"}</small>
        <input
          type="password"
          autoComplete="new-password"
          aria-label="会员回调密钥"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="输入至少 32 位密钥，或一键生成"
          maxLength={256}
        />
      </label>
      <div className="admin-inline-actions">
        <button
          type="button"
          disabled={busy || secret.length < 32}
          onClick={() => void save(false)}
        >
          保存密钥
        </button>
        <button type="button" disabled={busy} onClick={() => void save(true)}>
          {ready ? "生成并替换密钥" : "一键生成密钥"}
        </button>
        <button
          type="button"
          disabled={!secret}
          onClick={() =>
            void navigator.clipboard
              .writeText(secret)
              .then(() => setMessage("密钥已复制"))
              .catch(() => setMessage("请选中输入框中的密钥手动复制"))
          }
        >
          复制密钥
        </button>
      </div>
      <p className="admin-field-help">
        密钥保存在此处，替换后旧密钥立即失效。仅由会员服务端调用，不能放入会员网页代码。
      </p>
      <Feedback message={message} tone="info" />
      <details>
        <summary>调用样例</summary>
        <pre className="admin-code-example">
          <code>{sample}</code>
        </pre>
        <p className="admin-field-help">
          同一事件重试使用原 eventId；同一订阅更新时递增 version。撤销时将
          status 改为 revoked。userId 使用外部系统已关联的本站用户内部 ID。
        </p>
      </details>
    </div>
  );
}
