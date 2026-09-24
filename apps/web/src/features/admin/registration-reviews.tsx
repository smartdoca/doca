import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
type Review = {
  user_id: string;
  public_id: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
  reviewerName: string | null;
  message: string;
};
const labels: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
};
export function RegistrationReviews() {
  const [status, setStatus] = useState("pending"),
    [items, setItems] = useState<Review[]>([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<Review | null>(null),
    [message, setMessage] = useState("");
  async function load(offset = 0) {
    const result = await api<{ items: Review[]; nextOffset: number | null }>(
      `/admin/registration-reviews?${new URLSearchParams({ offset: String(offset), ...(status ? { status } : {}) })}`,
    );
    setItems((old) => (offset ? [...old, ...result.items] : result.items));
    setNext(result.nextOffset);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [status]);
  async function decide(decision: "approved" | "rejected") {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/registration-reviews/${target.user_id}`, "POST", {
        decision,
        message: message.trim(),
      });
      setTarget(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="admin-section-heading">
        <div>
          <h2>注册审核</h2>
          <p>审核新用户的加入申请，通过后用户可重新登录。</p>
        </div>
        <button onClick={() => void load().catch((e) => setError(e.message))}>
          刷新
        </button>
      </div>
      <div className="admin-card">
        <Select
          aria-label="注册审核状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
        <div className="account-table-scroll">
          <table className="membership-level-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>申请时间</th>
                <th>状态</th>
                <th>审核人</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.user_id}>
                  <td>
                    <strong>{r.display_name || r.public_id}</strong>
                    <div className="subtle">@{r.public_id}</div>
                  </td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                  <td>{labels[r.status] ?? r.status}</td>
                  <td>{r.reviewerName || "—"}</td>
                  <td>
                    <button
                      onClick={() => {
                        setTarget(r);
                        setMessage("");
                        setError("");
                      }}
                    >
                      {r.status === "pending" ? "审核" : "查看"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length && <p className="empty">暂无注册申请</p>}
        {next !== null && (
          <button
            onClick={() => void load(next).catch((e) => setError(e.message))}
          >
            加载更多
          </button>
        )}
      </div>
      <Feedback message={error} tone="error" />
      {target && (
        <Dialog
          title={target.status === "pending" ? "审核注册申请" : "注册审核记录"}
          close={() => {
            if (!busy) setTarget(null);
          }}
        >
          <p>
            {target.display_name || target.public_id} · @{target.public_id}
          </p>
          {target.status === "pending" ? (
            <>
              <label>
                审核备注（选填）
                <textarea
                  aria-label="审核备注"
                  value={message}
                  maxLength={1000}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <div className="admin-inline-actions">
                <button disabled={busy} onClick={() => void decide("rejected")}>
                  拒绝申请
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void decide("approved")}
                >
                  通过审核
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {labels[target.status]} ·{" "}
                {new Date(target.updated_at).toLocaleString()}
              </p>
              <p>审核人：{target.reviewerName || "—"}</p>
              <p>{target.message || "未填写备注"}</p>
            </>
          )}
          <Feedback message={error} tone="error" />
        </Dialog>
      )}
    </section>
  );
}
