import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "antd";
import { KeyRound } from "lucide-react";
import { api } from "@web/shared/api.js";

type SecretItem = { key: string; value: string };

const emptySecret = { key: "", value: "" };

export function AINoteSettings() {
const { t } = useI18n();

  const area = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [secret, setSecret] = useState(emptySecret);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [note, book] = await Promise.all([
      api<{ content: string }>("/ai/note"),
      api<{ items: SecretItem[] }>("/ai/secrets"),
    ]);
    setContent(note.content);
    setDraft(note.content);
    setSecrets(book.items);
    setEditing(!note.content);
  };
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const insertKey = (key: string) => {
    const token = `{{${key}}}`;
    setEditing(true);
    setDraft((current) => {
      const field = area.current;
      if (!field) {
        if (!current) return token;
        return current.endsWith("\n") ? current + token : `${current}\n${token}`;
      }
      const start = field.selectionStart ?? current.length;
      const end = field.selectionEnd ?? start;
      return current.slice(0, start) + token + current.slice(end);
    });
  };
  return (
    <div className="ai-note-card">
      <div className="ai-note-card-head">
        <p>
          一份给助手长期记住的 Markdown。密码不要写在正文里，用密码本的{" "}
          <code>{"{{KEY}}"}</code>。
        </p>
        <button
          type="button"
          className={vaultOpen ? "active" : ""}
          aria-label="管理密码本"
          aria-expanded={vaultOpen}
          onClick={() => setVaultOpen((value) => !value)}
        >
          <KeyRound size={18} />
          密码本
        </button>
      </div>
      {error && <p className="ai-note-error">{error}</p>}
      {vaultOpen && (
        <div className="ai-secret-book">
          <p>
            密码本按 key 保存值。备忘和需要密钥的工具只写占位符，例如{" "}
            <code>{"{{PASSWORD}}"}</code> 表示密码本里的 key：PASSWORD。助手只能写入，不能读取这些值。点击一条即可把占位符插入备忘。
          </p>
          {secrets.length ? (
            <ul>
              {secrets.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    className="ai-secret-key"
                    onClick={() => insertKey(item.key)}
                  >
                    <strong>{item.key}</strong>
                    <small>{`{{${item.key}}}`}</small>
                  </button>
                  <span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setSecret({ key: item.key, value: item.value })
                      }
                    >
                      修改
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`删除密码本中的 ${item.key}？`))
                          return;
                        void run(async () => {
                          await api(
                            `/ai/secrets/${encodeURIComponent(item.key)}`,
                            "DELETE",
                          );
                          setSecrets((items) =>
                            items.filter((entry) => entry.key !== item.key),
                          );
                        });
                      }}
                    >{t("common.delete")}</button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>密码本还是空的。</p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const entry = secret;
                await api("/ai/secrets", "PUT", entry);
                const book = await api<{ items: SecretItem[] }>("/ai/secrets");
                const note = await api<{ content: string }>("/ai/note");
                const token = `{{${entry.key.trim()}}}`;
                const hide = (text: string) =>
                  entry.value.length >= 4
                    ? text.split(entry.value).join(token)
                    : text;
                setSecrets(book.items);
                setContent(hide(note.content));
                setDraft((current) => hide(current));
                setSecret(emptySecret);
              });
            }}
          >
            <Input
              value={secret.key}
              maxLength={64}
              required
              placeholder="KEY，例如 PASSWORD"
              onChange={(event) =>
                setSecret({ ...secret, key: event.target.value })
              }
            />
            <Input.Password
              value={secret.value}
              maxLength={4000}
              required
              autoComplete="off"
              placeholder="值"
              onChange={(event) =>
                setSecret({ ...secret, value: event.target.value })
              }
            />
            <Button htmlType="submit" type="primary" size="small" disabled={busy}>
              保存到密码本
            </Button>
          </form>
        </div>
      )}
      {editing ? (
        <textarea
          ref={area}
          value={draft}
          maxLength={8000}
          rows={10}
          placeholder={"## 常用\n- 报告用中文，先写结论\n- 工单令牌：{{PASSWORD}}"}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <pre>{content || "还没有备忘。"}</pre>
      )}
      <div className="ai-actions">
        {editing ? (
          <>
            <Button
              type="primary"
              size="small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const saved = await api<{ content: string }>("/ai/note", "PUT", {
                    content: draft,
                  });
                  setContent(saved.content);
                  setDraft(saved.content);
                  setEditing(false);
                })
              }
            >
              保存备忘
            </Button>
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                setDraft(content);
                setEditing(!content);
              }}
            >{t("common.cancel")}</Button>
          </>
        ) : (
          <Button size="small" onClick={() => setEditing(true)}>{t("time.edited")}</Button>
        )}
      </div>
    </div>
  );
}
