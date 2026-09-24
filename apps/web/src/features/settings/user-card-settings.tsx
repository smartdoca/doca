import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import {
  defaultUserCard,
  type UserCardSettings as Config,
} from "@core/modules/deployment/user-card.js";
export function UserCardSettings() {
  const [value, setValue] = useState<Config>(defaultUserCard),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Config>("/user-card-settings")
      .then((v) => {
        setValue(v);
        setReady(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function save(next: Config) {
    if (busy || !ready) return;
    setBusy(true);
    setError("");
    try {
      setValue(await api<Config>("/admin/user-card-settings", "PUT", next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <h3>用户卡片跳转</h3>
      <p className="subtle">
        全站用户卡片统一生效。{"{userId}"} 为用户唯一标识，{"{uid}"} 为内部
        UUID；变量会自动编码。
      </p>
      <label className="field">
        跳转地址
        <input
          disabled={!ready || busy}
          value={value.url}
          placeholder="https://example.com/users/{userId}"
          onChange={(e) => setValue({ ...value, url: e.target.value })}
          onBlur={() => void save(value)}
        />
      </label>
      <label className="field">
        按钮文字
        <input
          disabled={!ready || busy}
          maxLength={40}
          value={value.text}
          onChange={(e) => setValue({ ...value, text: e.target.value })}
          onBlur={() => void save(value)}
        />
      </label>
      <label className="field">
        按钮样式
        <Select
          disabled={!ready || busy}
          value={value.style}
          onChange={(e) =>
            void save({ ...value, style: e.target.value as Config["style"] })
          }
        >
          <option value="primary">蓝色按钮</option>
          <option value="secondary">描边按钮</option>
          <option value="link">文字链接</option>
        </Select>
      </label>
      <label>
        <input
          type="checkbox"
          disabled={!ready || busy}
          checked={value.enabled}
          onChange={(e) => void save({ ...value, enabled: e.target.checked })}
        />{" "}
        显示跳转按钮
      </label>
      {error && <Feedback tone="error" message={error} />}
    </section>
  );
}
