import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { SourceProfileSettings } from "@web/features/account/account-settings.js";
import { Feedback } from "@web/shared/components/feedback.js";
export function SourceLevelSettings() {
  const [items, setItems] = useState<
      { id: string; name: string; version: number; levelMapping: unknown }[]
    >([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<{ items: typeof items }>("/admin/entitlements/sources").then((r) =>
      setItems(r.items),
    );
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, []);
  return (
    <>
      <p className="admin-field-help">
        SSO
        仅映射永久基础等级和身份分类。等级独立于基础资料字段管理，定时会员由管理员或外部会员回调调整。
      </p>
      {!items.length && (
        <section className="admin-card">请先在登录方式中添加身份源。</section>
      )}
      {items.map((item) => (
        <form
          className="admin-card admin-settings-form"
          key={item.id}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api(`/admin/entitlements/sources/${item.id}`, "PUT", {
                version: item.version,
                levelMapping: item.levelMapping,
              });
              await load();
              setMessage("等级映射已保存");
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>{item.name}</h3>
          <SourceProfileSettings
            section="levels"
            value={JSON.stringify({ levelMapping: item.levelMapping })}
            onChange={(v) =>
              setItems(
                items.map((i) =>
                  i.id === item.id
                    ? { ...i, levelMapping: JSON.parse(v).levelMapping }
                    : i,
                ),
              )
            }
          />
          <button className="primary" disabled={busy}>
            保存等级映射
          </button>
        </form>
      ))}
      <Feedback message={message} tone="info" />
    </>
  );
}
