import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
type Event = {
  id: string;
  seq: number;
  type: string;
  created_at: string;
  payload: Record<string, unknown>;
};
export function HookEvents() {
  const [items, setItems] = useState<Event[]>([]),
    [cursor, setCursor] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load(after: number) {
    setBusy(true);
    try {
      const p = await api<{ items: Event[]; cursor: number }>(
        `/admin/integration-events?after=${after}`,
      );
      setItems((old) => (after ? [...old, ...p.items] : p.items));
      setCursor(p.cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(0);
  }, []);
  return (
    <>
      <div className="admin-section-heading">
        <div>
          <h2>Hook 事件同步</h2>
          <p>通知、权限申请与文档核心事件，随业务事务一起持久保存。</p>
        </div>
        <span className="status-badge">事件流已接入</span>
      </div>
      <section className="admin-card">
        <h3>增量同步接口</h3>
        <code>GET /api/v1/admin/integration-events?after=0</code>
        <p>
          仅管理员可访问。保存返回的 cursor，下次从该位置继续；消费方按事件 id
          去重。事件包含类型、资源/用户标识与通知跳转路径，不包含正文和密钥。
        </p>
        <p className="subtle">
          当前提供拉取式事件同步；外部 Webhook
          的签名推送、自动重试与密钥管理尚未接入。
        </p>
      </section>
      {error && <Feedback tone="error" message={error} />}
      <section className="admin-card">
        <h3>事件记录</h3>
        {items.map((item) => (
          <div className="service-row" key={item.id}>
            <strong>
              #{item.seq} {item.type}
            </strong>
            <small>{new Date(item.created_at).toLocaleString()}</small>
          </div>
        ))}
        {!items.length && <p className="subtle">尚无事件</p>}
        <button disabled={busy} onClick={() => void load(cursor)}>
          加载后续事件
        </button>
      </section>
    </>
  );
}
