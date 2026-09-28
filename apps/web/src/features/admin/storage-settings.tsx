import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useState } from "react";
import { HardDrive, Cloud, ShieldCheck, Check } from "lucide-react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { ServiceCredentials } from "@web/features/admin/service-credentials.js";
interface Config {
  provider: "local" | "s3";
  bucket: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  credentialRef: string;
  cdnDomain: string;
}
interface Settings {
  id: string;
  config: Config;
  credentialRefs: string[];
  cdnSigningReady: boolean;
}
export function StorageSettings() {
const { t } = useI18n();

  const [data, setData] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  async function load() {
    setData(await api<Settings>("/admin/storage"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  function field<K extends keyof Config>(key: K, value: Config[K]) {
    setData((old) =>
      old ? { ...old, config: { ...old.config, [key]: value } } : old,
    );
    setMessage("");
  }
  const c = data?.config;
  return (
    <>
      <div className="admin-section-heading">
        <div>
          <h2>{t("admin.storage")}</h2>
          <p>统一管理头像、知识库封面、文档图片和附件。</p>
        </div>
      </div>
      {error && (
        <Feedback message={error} tone="error" />
      )}
      {!data || !c ? (
        <div className="empty">
          {error ? "无法加载设置" : "正在加载…"}
          <button onClick={() => void load().catch((e) => setError(e.message))}>
            重新加载
          </button>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setMessage("");
            try {
              await api("/admin/storage", "PUT", {
                expectedId: data.id,
                config: c,
              });
              await load();
              setMessage("设置已保存，将用于之后上传的文件。");
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="storage-fieldset">
            <legend>存储方式</legend>
            <div className="storage-options">
              {(
                [
                  {
                    value: "local",
                    title: "本地存储",
                    desc: "保存在部署服务器磁盘",
                    Icon: HardDrive,
                  },
                  {
                    value: "s3",
                    title: "云存储",
                    desc: "S3 兼容对象存储与 CDN",
                    Icon: Cloud,
                  },
                ] as const
              ).map(({ value, title, desc, Icon }) => (
                <button
                  type="button"
                  key={value}
                  className={
                    "storage-option " + (c.provider === value ? "selected" : "")
                  }
                  aria-pressed={c.provider === value}
                  onClick={() => field("provider", value)}
                >
                  <span className="setting-icon">
                    <Icon size={23} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{desc}</small>
                  </span>
                  <span className="choice-dot">
                    {c.provider === value && <Check size={12} />}
                  </span>
                </button>
              ))}
            </div>
            <section className="admin-card">
              <div className="card-heading">
                <h3>
                  {c.provider === "local" ? "本地文件目录" : "对象存储连接"}
                </h3>
                <span className="status-badge">
                  {c.provider === "local" ? "无需额外服务" : "S3 兼容"}
                </span>
              </div>
              {c.provider === "local" ? (
                <>
                  <p>
                    文件保存到服务器配置的上传目录，默认是 data/v1/uploads。
                  </p>
                  <p className="subtle">
                    通过 DOCA_UPLOAD_DIR
                    指定持久化目录。备份时，请同时备份数据库与上传目录。
                  </p>
                </>
              ) : (
                <>
                  <div className="form-grid">
                    <label>
                      存储桶名称
                      <input
                        required
                        value={c.bucket}
                        placeholder="doca-files"
                        onChange={(e) => field("bucket", e.target.value)}
                      />
                    </label>
                    <label>
                      区域 Region
                      <input
                        required
                        value={c.region}
                        placeholder="us-east-1"
                        onChange={(e) => field("region", e.target.value)}
                      />
                    </label>
                    <label className="field-wide">
                      自定义端点
                      <input
                        type="url"
                        value={c.endpoint}
                        placeholder="留空使用 AWS S3；其他厂商填写 HTTPS 端点"
                        onChange={(e) => field("endpoint", e.target.value)}
                      />
                      <small>
                        需加入下方“对象存储密钥”中的允许端点域名。
                      </small>
                    </label>
                    <label>
                      服务器凭据
                      <Select
                        value={c.credentialRef}
                        onChange={(e) => field("credentialRef", e.target.value)}
                      >
                        {Array.from(
                          new Set([c.credentialRef, ...data.credentialRefs]),
                        ).map((ref) => (
                          <option key={ref} value={ref}>
                            {ref}
                            {data.credentialRefs.includes(ref)
                              ? ""
                              : "（未配置）"}
                          </option>
                        ))}
                      </Select>
                      <small>
                        在下方“对象存储密钥”中配置对应凭据。
                      </small>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={c.forcePathStyle}
                        onChange={(e) =>
                          field("forcePathStyle", e.target.checked)
                        }
                      />
                      使用 Path-style 路径
                    </label>
                  </div>
                  <div className="section-divider" />
                  <div className="card-heading">
                    <h3>CDN 加速</h3>
                    <span className="status-badge">
                      {data.cdnSigningReady ? "签名密钥已配置" : "可选"}
                    </span>
                  </div>
                  <label>
                    CDN 域名
                    <input
                      type="url"
                      value={c.cdnDomain}
                      placeholder="https://files.example.com"
                      onChange={(e) => field("cdnDomain", e.target.value)}
                    />
                    <small>
                      支持 CloudFront
                      签名协议，需配置私有源站与受信任密钥组，签名密钥在下方“CDN
                      签名密钥”中维护；无 CDN 时由后端鉴权读取。
                    </small>
                  </label>
                </>
              )}
            </section>
            <div className="admin-note">
              <ShieldCheck size={19} />
              <p>
                文件先鉴权再读取。CDN 链接最多有效 60
                秒；切换存储只影响新上传文件，旧文件继续使用原配置。
              </p>
            </div>
            <div className="admin-form-footer">
              <span className="subtle">
                保存不会迁移文件或自动验证云端连接。
              </span>
              <button className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存存储设置"}
              </button>
            </div>
          </fieldset>
          {message && (
            <Feedback message={message} tone="success" />
          )}
        </form>
      )}
      {c?.provider === "s3" && (
        <>
          <ServiceCredentials onlyStorage />
          <ServiceCredentials onlyCdn />
        </>
      )}
    </>
  );
}
