import { lazy, Suspense, useEffect, useState } from "react";
import { Flag, Search } from "lucide-react";
import { api } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import "@web/features/admin/moderation.css";
export function ReportDocument({ id, close }: { id: string; close(): void }) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog title="投诉 / 举报" close={close} className="modal-compact">
      {done ? (
        <>
          <p>举报已提交，平台管理员会审核处理。举报人信息仅管理员可见。</p>
          <button className="primary" onClick={close}>
            知道了
          </button>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api(`/resources/${id}/reports`, "POST", { reason });
              setDone(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="subtle">请说明文档存在的问题，并尽量指出具体位置。</p>
          <label>
            举报说明
            <textarea
              aria-label="举报说明"
              required
              maxLength={2000}
              rows={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <Feedback message={error} tone="error" />
          <div className="modal-actions">
            <button type="button" onClick={close}>
              取消
            </button>
            <button className="primary" disabled={busy || !reason.trim()}>
              <Flag size={15} />
              提交举报
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
const RichPreview = lazy(() => import("@web/features/documents/version-preview.js"));
const MarkdownPreview = lazy(() => import("@web/features/documents/markdown-preview.js"));
const SurfacePreview = lazy(() => import("@web/features/documents/surface-preview.js"));
const statusNames: Record<string, string> = {
  archived: "已存证",
  pending: "待人工复核",
  passed: "审核通过",
  blocked: "已拦截",
  error: "待重试",
  resolved: "已处理",
  active: "正常",
  none: "未启用审核",
  pass: "通过",
  review: "待人工复核",
};
const kindNames: Record<string, string> = {
  archive: "封禁存证",
  text: "文档内容",
  image: "图片",
  report: "用户举报",
};
export function ModerationAdmin() {
  const [tab, setTab] = useState("cases"),
    [status, setStatus] = useState(""),
    [kind, setKind] = useState(""),
    [query, setQuery] = useState(""),
    [blocked, setBlocked] = useState(false);
  const [items, setItems] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [config, setConfig] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [document, setDocument] = useState<any>(null),
    [reason, setReason] = useState(""),
    [decision, setDecision] = useState("dismiss"),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    if (tab === "settings") {
      void api("/admin/moderation/settings", "GET", undefined, abort.signal)
        .then(setConfig)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
      return () => abort.abort();
    }
    const q = new URLSearchParams({
      offset: String(offset),
      ...(tab === "cases"
        ? { ...(status ? { status } : {}), ...(kind ? { kind } : {}) }
        : {
            ...(query ? { q: query } : {}),
            ...(blocked ? { blocked: "1" } : {}),
          }),
    });
    void api<any>(
      `/admin/moderation/${tab}?${q}`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((p) => {
        setItems(p.items);
        setNext(p.nextOffset);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [tab, status, kind, query, blocked, offset, refresh]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    await run(async () => {
      setPreview(null);
      setDocument(await api(`/admin/moderation/documents/${id}`));
      setDetail(null);
      setReason("");
    });
  }
  function changeTab(value: string) {
    setTab(value);
    setOffset(0);
    setItems([]);
    setNotice("");
  }
  return (
    <section className="moderation-admin">
      <div className="admin-page-heading">
        <div>
          <h2>内容审核</h2>
          <p className="subtle">审核内容、处理举报，保留处置记录。</p>
        </div>
      </div>
      <nav className="moderation-tabs" aria-label="内容审核分类">
        {(
          [
            ["cases", "审核与举报"],
            ["documents", "文档管理"],
            ["settings", "云审核设置"],
          ] as const
        ).map(([id, name]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => changeTab(id)}
          >
            {name}
          </button>
        ))}
      </nav>
      {!detail && !document && <Feedback message={error} tone="error" />}
      <Feedback message={notice} tone="success" />
      {tab !== "settings" && (
        <div className="settings-card">
          <div className="moderation-filters">
            {tab === "cases" ? (
              <>
                <Select
                  aria-label="审核来源"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">全部来源</option>
                  {Object.entries(kindNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="审核状态"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">全部状态</option>
                  {[
                    "pending",
                    "blocked",
                    "error",
                    "passed",
                    "resolved",
                    "archived",
                  ].map((k) => (
                    <option key={k} value={k}>
                      {statusNames[k]}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <>
                <label className="moderation-search">
                  <Search size={16} />
                  <input
                    aria-label="搜索文档"
                    placeholder="搜索文档标题"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                    }}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={blocked}
                    onChange={(e) => {
                      setBlocked(e.target.checked);
                      setOffset(0);
                    }}
                  />
                  仅封禁文档
                </label>
              </>
            )}
          </div>
          <div className="moderation-table">
            <table>
              <thead>
                <tr>
                  <th>内容</th>
                  <th>{tab === "cases" ? "来源" : "保留状态"}</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.title}</td>
                    <td>
                      {tab === "cases"
                        ? kindNames[row.kind]
                        : row.moderation_hold
                          ? "审计保留"
                          : "—"}
                    </td>
                    <td>{statusNames[row.status ?? row.moderation_status]}</td>
                    <td>
                      {new Date(
                        row.created_at ?? row.updated_at,
                      ).toLocaleString()}
                    </td>
                    <td>
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() =>
                          tab === "documents"
                            ? void inspect(row.id)
                            : void run(async () => {
                                setDetail(
                                  await api(
                                    `/admin/moderation/cases/${row.id}`,
                                  ),
                                );
                                setReason("");
                                setDecision("dismiss");
                              })
                        }
                      >
                        查看{tab === "cases" ? " / 处理" : "文档"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && <p className="subtle">暂无记录</p>}
          </div>
          <div className="moderation-pagination">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              上一页
            </button>
            <span>第 {Math.floor(offset / 50) + 1} 页</span>
            <button disabled={next === null} onClick={() => setOffset(next!)}>
              下一页
            </button>
          </div>
        </div>
      )}
      {tab === "settings" && config && (
        <form
          className="settings-card moderation-config"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const { secretKeyConfigured, provider, ...body } = config;
              await api("/admin/moderation/settings", "PUT", body);
              setNotice("审核设置已保存");
            });
          }}
        >
          <h3>腾讯云内容安全</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) =>
                setConfig({ ...config, enabled: e.target.checked })
              }
            />
            启用图片与文档审核
          </label>
          <p className="subtle">
            启用后，新上传图片审核通过才可读取；文档修改合并后延迟审核。云端建议复核或调用失败时保留记录，失败任务自动重试。已有文档会在后续修改时触发审核。
          </p>
          <div className="moderation-config-grid">
            {(
              [
                ["region", "地域"],
                ["secretId", "SecretId"],
                ["secretKey", "SecretKey"],
                ["textBizType", "文本策略编号（选填）"],
                ["imageBizType", "图片策略编号（选填）"],
              ] as const
            ).map(([key, name]) => (
              <label key={key}>
                {name}
                <input
                  aria-label={name}
                  type={key === "secretKey" ? "password" : "text"}
                  autoComplete="off"
                  value={config[key]}
                  placeholder={
                    key === "secretKey" && config.secretKeyConfigured
                      ? "已配置，留空保留"
                      : ""
                  }
                  onChange={(e) =>
                    setConfig({ ...config, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label>
              文档修改后延迟（秒）
              <input
                aria-label="审核延迟秒数"
                type="number"
                min={10}
                max={3600}
                value={config.delaySeconds}
                onChange={(e) =>
                  setConfig({ ...config, delaySeconds: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <p className="subtle">
            调用腾讯云 TMS /
            IMS，请先开通服务并配置策略。凭据存储在本系统数据库，保存后不会返回密钥明文。
          </p>
          <button className="primary" disabled={busy}>
            保存审核设置
          </button>
        </form>
      )}
      {detail && (
        <Dialog title="审核记录" close={() => setDetail(null)}>
          <div className="moderation-detail">
            <h3>{detail.title}</h3>
            <p>
              {kindNames[detail.kind]} · {statusNames[detail.status]}
            </p>
            <p>{detail.reason || "无补充说明"}</p>
            {detail.reporter_id && (
              <p className="subtle">
                举报人：
                {detail.reporter?.display_name ||
                  detail.reporter?.public_id ||
                  detail.reporter_id}
                （仅管理员可见）
              </p>
            )}
            {detail.subject && (
              <p className="subtle">
                相关用户：{detail.subject.display_name}（@
                {detail.subject.public_id}）
              </p>
            )}
            {detail.asset_id && (
              <img
                className="moderation-image"
                alt="待审核图片"
                src={`/api/v1/assets/${detail.asset_id}/content?audit=1`}
              />
            )}
            <pre className="moderation-evidence">
              {detail.evidence || "图片内容见上方"}
            </pre>
            {detail.resource_id && (
              <button onClick={() => void inspect(detail.resource_id)}>
                查看关联文档
              </button>
            )}
            {detail.actions?.length > 0 && (
              <details>
                <summary>处理与查看记录</summary>
                {detail.actions.map((a: any) => (
                  <p key={a.id}>
                    {new Date(a.created_at).toLocaleString()} · {a.action} ·{" "}
                    {a.reason}
                  </p>
                ))}
              </details>
            )}
            {["pending", "blocked", "error"].includes(detail.status) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api(
                      `/admin/moderation/cases/${detail.id}/decide`,
                      "POST",
                      { decision, reason },
                    );
                    setDetail(null);
                    setNotice("处理结果已保存");
                  });
                }}
              >
                <label>
                  处理方式
                  <Select
                    aria-label="审核处理方式"
                    value={decision}
                    onChange={(e) => setDecision(e.target.value)}
                  >
                    <option value="dismiss">
                      结束此记录（不改变封禁状态）
                    </option>
                    {detail.resource_id && (
                      <option value="block_document">封禁文档</option>
                    )}
                    {detail.asset_id && (
                      <option value="approve_image">图片审核通过</option>
                    )}
                    <option value="block_user">封禁问题用户</option>
                  </Select>
                </label>
                <label>
                  处理说明
                  <textarea
                    aria-label="审核处理说明"
                    rows={3}
                    required
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button className="primary" disabled={busy || !reason.trim()}>
                  确认处理
                </button>
              </form>
            )}
            <Feedback message={error} tone="error" />
          </div>
        </Dialog>
      )}
      {document && (
        <Dialog
          title="文档审计"
          className="moderation-preview-dialog"
          close={() => setDocument(null)}
        >
          <div className="moderation-detail">
            <h3>{document.resource.title}</h3>
            <p>
              {document.resource.moderation_status === "blocked"
                ? "已封禁，仅管理员可审计查看"
                : "正常"}
              {document.resource.moderation_hold ? " · 审计保留，不可删除" : ""}
            </p>
            <div>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setPreview(
                      await api(
                        `/admin/moderation/documents/${document.resource.id}/preview`,
                      ),
                    ),
                  )
                }
              >
                按原格式预览
              </button>
            </div>
            {preview ? (
              <Suspense fallback={<p>正在加载预览…</p>}>
                {preview.empty ? (
                  <p>该文档尚未写入正文，已保留标题及附件。</p>
                ) : preview.surface ? (
                  <SurfacePreview
                    id={document.resource.id}
                    surface={preview.surface}
                    audit
                  />
                ) : preview.markdown !== undefined ? (
                  <MarkdownPreview value={preview.markdown} audit />
                ) : (
                  <RichPreview value={preview.value} audit />
                )}
              </Suspense>
            ) : (
              <pre className="moderation-evidence">{document.text}</pre>
            )}
            <div className="moderation-images">
              {document.assets.map((a: any) =>
                a.mime.startsWith("image/") ? (
                  <figure key={a.id}>
                    <img
                      alt={a.filename}
                      src={`/api/v1/assets/${a.id}/content?audit=1`}
                    />
                    <figcaption>
                      {a.filename} · {statusNames[a.moderation_status]}
                    </figcaption>
                  </figure>
                ) : (
                  <a
                    key={a.id}
                    href={`/api/v1/assets/${a.id}/content?audit=1&download=1`}
                  >
                    {a.filename}
                  </a>
                ),
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(
                    `/admin/moderation/documents/${document.resource.id}/block`,
                    "POST",
                    {
                      blocked:
                        document.resource.moderation_status !== "blocked",
                      reason,
                      version: document.resource.version,
                    },
                  );
                  setDocument(null);
                  setNotice("文档状态已更新");
                });
              }}
            >
              <label>
                处理说明
                <textarea
                  aria-label="文档处理说明"
                  required
                  rows={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy || !reason.trim()}>
                {document.resource.moderation_status === "blocked"
                  ? "解除封禁"
                  : "封禁文档"}
              </button>
            </form>
            <Feedback message={error} tone="error" />
          </div>
        </Dialog>
      )}
    </section>
  );
}
