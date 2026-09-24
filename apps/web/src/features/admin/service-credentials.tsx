import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { SettingsTabs } from "@web/features/settings/settings-tabs.js";
import "@web/features/admin/service-credentials.css";
type Config = {
  identity: {
    credentials: Record<string, string | null>;
    allowedOrigins: string[];
  };
  storage: {
    credentials: Record<
      string,
      {
        accessKeyId: string;
        secretAccessKey: string | null;
        sessionToken: string | null;
      }
    >;
    endpointHosts: string[];
    cdnKeyPairId: string;
    cdnPrivateKey: string | null;
  };
  messaging: { endpoint: string; secret: string | null; channels: string[] };
  search: { apiKey: string | null; allowedOrigins: string[] };
};
function SecretField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  multiline?: boolean;
}) {
  const hint = value === null ? "已配置，留空保留现有密钥" : "尚未配置";
  return (
    <label className="service-secret">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={value ?? ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value || null)}
          rows={5}
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <input
          type="password"
          autoComplete="new-password"
          value={value ?? ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value || null)}
        />
      )}
      {value === null && (
        <button type="button" onClick={() => onChange("")}>
          清除现有密钥
        </button>
      )}
    </label>
  );
}
function Origins({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  return (
    <label>
      {label}
      <textarea
        rows={3}
        value={values.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        placeholder={placeholder}
      />
      <small>每行一个，保存时忽略空行。</small>
    </label>
  );
}
export function ServiceCredentials({
  onlySearch = false,
  onlyIdentity = false,
  onlyMessaging = false,
  onlyStorage = false,
  onlyCdn = false,
  onSearchSaved,
}: {
  onlySearch?: boolean;
  onlyIdentity?: boolean;
  onlyMessaging?: boolean;
  onlyStorage?: boolean;
  onlyCdn?: boolean;
  onSearchSaved?: (config: Config["search"]) => void;
} = {}) {
  const embedded =
      onlySearch || onlyIdentity || onlyMessaging || onlyStorage || onlyCdn,
    [data, setData] = useState<{ revision: number; config: Config } | null>(
      null,
    ),
    [tab, setTab] = useState(
      onlySearch
        ? "search"
        : onlyIdentity
          ? "identity"
          : onlyMessaging
            ? "messaging"
            : onlyStorage
              ? "storage"
              : onlyCdn
                ? "cdn"
                : "identity",
    ),
    [ref, setRef] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const load = () =>
    api<{ revision: number; config: Config }>(
      "/admin/service-credentials",
    ).then((value) => {
      setData(value);
      return value;
    });
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const change = (update: (c: Config) => void) =>
    setData((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous);
      update(next.config);
      return next;
    });
  if (!data)
    return (
      <p className="admin-field-help" role={error ? "alert" : "status"}>
        {error || "正在读取服务凭据…"}
      </p>
    );
  const c = data.config;
  function add() {
    const id = ref.trim();
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      ["__proto__", "prototype", "constructor"].includes(id)
    ) {
      setError("凭据名称只支持字母、数字、下划线和短横线");
      return;
    }
    const entries =
      tab === "identity" ? c.identity.credentials : c.storage.credentials;
    if (Object.hasOwn(entries, id)) {
      setError("该凭据名称已存在");
      return;
    }
    change((v) => {
      if (tab === "identity") v.identity.credentials[id] = "";
      else
        v.storage.credentials[id] = {
          accessKeyId: "",
          secretAccessKey: "",
          sessionToken: "",
        };
    });
    setRef("");
    setError("");
  }
  return (
    <section
      className={
        onlySearch
          ? "service-credentials search-connection-credentials"
          : "admin-card service-credentials"
      }
    >
      {!embedded && (
        <>
          <h3>服务凭据</h3>
          <p className="admin-field-help">
            凭据保存在本站数据库中，保存后生效。已保存的密钥不会回显；修改其他设置时保留原值。
          </p>
        </>
      )}
      {embedded && !onlySearch && (
        <h3>
          {onlyIdentity
            ? "SSO Client Secret"
            : onlyMessaging
              ? "验证码网关"
              : onlyStorage
                ? "对象存储密钥"
                : "CDN 签名密钥"}
        </h3>
      )}
      {!embedded && (
        <SettingsTabs
          label="服务凭据分类"
          value={tab}
          items={[
            ["identity", "SSO 认证"],
            ["messaging", "验证码网关"],
            ["storage", "对象存储"],
            ["cdn", "CDN 签名"],
            ["search", "文档搜索"],
          ]}
          onChange={(v) => {
            setTab(v);
            setRef("");
          }}
        />
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const config = structuredClone(c);
            config.identity.allowedOrigins = config.identity.allowedOrigins
              .map((s) => s.trim())
              .filter(Boolean);
            config.storage.endpointHosts = config.storage.endpointHosts
              .map((s) => s.trim())
              .filter(Boolean);
            config.search.allowedOrigins = config.search.allowedOrigins
              .map((s) => s.trim())
              .filter(Boolean);
            await api("/admin/service-credentials", "PUT", {
              revision: data.revision,
              config,
            });
            const saved = await load();
            onSearchSaved?.(saved.config.search);
            setMessage(
              onlySearch
                ? "搜索凭据已保存并生效"
                : embedded
                  ? "密钥已保存并生效"
                  : "服务凭据已保存并生效",
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="service-credentials-fields">
          {tab === "identity" && (
            <>
              <p className="admin-field-help">
                认证源的“凭据名称”与这里保持一致。
                {!embedded && "Client ID 和字段映射仍在“登录与注册”中设置。"}
              </p>
              {Object.entries(c.identity.credentials).map(([id, value]) => (
                <div className="service-credential-row" key={id}>
                  <header>
                    <strong>{id}</strong>
                    <button
                      type="button"
                      onClick={() =>
                        change((v) => {
                          delete v.identity.credentials[id];
                        })
                      }
                    >
                      移除
                    </button>
                  </header>
                  <SecretField
                    label="Client Secret"
                    value={value}
                    onChange={(value) =>
                      change((v) => {
                        v.identity.credentials[id] = value;
                      })
                    }
                  />
                </div>
              ))}
              <Origins
                label="自定义 SSO 允许的来源"
                values={c.identity.allowedOrigins}
                onChange={(values) =>
                  change((v) => {
                    v.identity.allowedOrigins = values;
                  })
                }
                placeholder="https://sso.example.com"
              />
            </>
          )}
          {tab === "storage" && (
            <>
              <p className="admin-field-help">
                文件存储设置使用这里的凭据名称。旧文件仍依赖其原存储凭据，请使用修改密钥来轮换。
              </p>
              {Object.entries(c.storage.credentials).map(([id, value]) => (
                <div className="service-credential-row" key={id}>
                  <header>
                    <strong>{id}</strong>
                    <button
                      type="button"
                      onClick={() =>
                        change((v) => {
                          delete v.storage.credentials[id];
                        })
                      }
                    >
                      移除
                    </button>
                  </header>
                  <label>
                    Access Key ID
                    <input
                      value={value.accessKeyId}
                      onChange={(e) =>
                        change((v) => {
                          v.storage.credentials[id]!.accessKeyId =
                            e.target.value;
                        })
                      }
                    />
                  </label>
                  <SecretField
                    label="Secret Access Key"
                    value={value.secretAccessKey}
                    onChange={(value) =>
                      change((v) => {
                        v.storage.credentials[id]!.secretAccessKey = value;
                      })
                    }
                  />
                  <SecretField
                    label="Session Token（可选）"
                    value={value.sessionToken}
                    onChange={(value) =>
                      change((v) => {
                        v.storage.credentials[id]!.sessionToken = value;
                      })
                    }
                  />
                </div>
              ))}
              <Origins
                label="允许的存储端点域名"
                values={c.storage.endpointHosts}
                onChange={(values) =>
                  change((v) => {
                    v.storage.endpointHosts = values;
                  })
                }
                placeholder="s3.example.com"
              />
            </>
          )}
          {(tab === "identity" || tab === "storage") && (
            <div className="service-credential-add">
              <input
                aria-label="新凭据名称"
                placeholder="凭据名称，例如 company-sso"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
              <button type="button" onClick={add}>
                添加凭据
              </button>
            </div>
          )}
          {tab === "messaging" && (
            <>
              <label>
                验证码网关地址
                <input
                  type="url"
                  placeholder="https://messages.example.com/send"
                  value={c.messaging.endpoint}
                  onChange={(e) =>
                    change((v) => {
                      v.messaging.endpoint = e.target.value;
                    })
                  }
                />
              </label>
              <SecretField
                label="网关密钥"
                value={c.messaging.secret}
                onChange={(value) =>
                  change((v) => {
                    v.messaging.secret = value;
                  })
                }
              />
              <div className="service-channels">
                {(
                  [
                    ["phone", "发送手机验证码"],
                    ["email", "发送邮箱验证码"],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={c.messaging.channels.includes(id)}
                      onChange={(e) =>
                        change((v) => {
                          v.messaging.channels = e.target.checked
                            ? [...v.messaging.channels, id]
                            : v.messaging.channels.filter((x) => x !== id);
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="admin-field-help">
                网关接收 POST 请求，Authorization 使用 Bearer 密钥；请求包含
                kind、destination、code、purpose、expiresInSeconds。
              </p>
            </>
          )}
          {tab === "cdn" && (
            <>
              <label>
                CloudFront 密钥 ID
                <input
                  value={c.storage.cdnKeyPairId}
                  onChange={(e) =>
                    change((v) => {
                      v.storage.cdnKeyPairId = e.target.value;
                    })
                  }
                />
              </label>
              <SecretField
                label="签名私钥（PEM）"
                multiline
                value={c.storage.cdnPrivateKey}
                onChange={(value) =>
                  change((v) => {
                    v.storage.cdnPrivateKey = value;
                  })
                }
              />
            </>
          )}
          {tab === "search" && (
            <>
              <SecretField
                label="Meilisearch API 密钥"
                value={c.search.apiKey}
                onChange={(value) =>
                  change((v) => {
                    v.search.apiKey = value;
                  })
                }
              />
              {onlySearch && (
                <small>已保存的密钥不会回显，留空保留原值。</small>
              )}
              <details
                open={onlySearch ? undefined : true}
                className={onlySearch ? "search-settings-details" : undefined}
              >
                <summary hidden={!onlySearch}>高级连接设置</summary>
                <Origins
                  label="允许的搜索服务来源"
                  values={c.search.allowedOrigins}
                  onChange={(values) =>
                    change((v) => {
                      v.search.allowedOrigins = values;
                    })
                  }
                  placeholder="http://127.0.0.1:7700"
                />
              </details>
              {!onlySearch && (
                <p className="admin-field-help">
                  搜索地址、索引与启用状态在“文档搜索”中设置。
                </p>
              )}
            </>
          )}
        </fieldset>
        <Feedback
          message={error || message}
          tone={error ? "error" : "success"}
        />
        <footer>
          <button className="primary" disabled={busy}>
            {busy
              ? "正在保存…"
              : onlySearch
                ? "保存密钥与来源"
                : embedded
                  ? "保存密钥"
                  : "保存服务凭据"}
          </button>
        </footer>
      </form>
    </section>
  );
}
