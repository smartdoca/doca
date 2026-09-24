import { useEffect, useState } from "react";
import { api } from "@web/shared/api.js";
import { Select } from "@web/shared/components/select.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { realtime } from "@web/features/documents/realtime.js";
import {
  resourceDistribution,
  type Distribution,
  type ContentDistribution,
} from "@core/modules/deployment/policies.js";
export function DistributionSettings() {
  const [value, setValue] = useState<Distribution | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Distribution>("/admin/distribution")
      .then(setValue)
      .catch((e) => setError(e.message));
  }, []);
  async function save(patch: Partial<Distribution>) {
    if (!value || busy) return;
    setBusy(true);
    try {
      setValue(await api("/admin/distribution", "PUT", { ...value, ...patch }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setValue(await api("/admin/distribution"));
    } finally {
      setBusy(false);
    }
  }
  const contentCard = (kind: "document" | "library", name: string) => {
    const policy = value ? resourceDistribution(value, kind) : null;
    const patch = (v: Partial<ContentDistribution>) =>
      value &&
      void save({
        resourcePolicies: {
          ...value.resourcePolicies,
          [kind]: { ...value.resourcePolicies?.[kind], ...v },
        },
      });
    const toggle = (
      label: string,
      help: string,
      checked: boolean,
      change: (checked: boolean) => void,
    ) => (
      <label className="setting-toggle">
        <span>
          <strong>{label}</strong>
          <small>{help}</small>
        </span>
        <input
          type="checkbox"
          disabled={!value || busy}
          checked={checked}
          onChange={(e) => change(e.target.checked)}
        />
      </label>
    );
    return (
      <section className="admin-card" key={kind}>
        <h3>{name}</h3>
        <label className="policy-row">
          <strong>新建{name}的默认范围</strong>
          <Select
            aria-label={`${name}默认范围`}
            disabled={!value || busy}
            value={policy?.defaultVisibility ?? "invited"}
            onChange={(e) =>
              patch({
                defaultVisibility: e.target
                  .value as ContentDistribution["defaultVisibility"],
              })
            }
          >
            <option value="invited">私有，仅有权限的人可访问</option>
            <option value="requestable">允许申请访问</option>
            <option value="authenticated">站内公开</option>
            <option value="public">全网公开</option>
          </Select>
          <small>只影响新建内容，知识库中的文档仍按继承规则创建。</small>
        </label>
        <label className="policy-row">
          <strong>新协作者授权方式</strong>
          <Select
            aria-label={`${name}授权方式`}
            disabled={!value || busy}
            value={policy?.grantMode ?? "direct"}
            onChange={(e) =>
              patch({
                grantMode: e.target.value as ContentDistribution["grantMode"],
              })
            }
          >
            <option value="direct">直接生效</option>
            <option value="invite">接受邀请后生效</option>
          </Select>
        </label>
        {toggle(
          "展示所有者和管理员",
          "允许无权限或普通协作者查看，方便联系。",
          policy?.managerInfoVisible ?? false,
          (v) => patch({ managerInfoVisible: v }),
        )}
        <h4>列表展示</h4>
        <label className="policy-row">
          <strong>
            {kind === "document" ? "与我共享的文档" : "协作知识库"}
          </strong>
          <Select
            aria-label={`${name}列表展示`}
            disabled={!value || busy}
            value={
              kind === "document"
                ? (value?.sharedDocuments ?? "interacted")
                : (value?.libraryMembers ?? "granted")
            }
            onChange={(e) =>
              void save({
                [kind === "document" ? "sharedDocuments" : "libraryMembers"]:
                  e.target.value,
              })
            }
          >
            <option value="granted">授权生效后展示</option>
            <option value="interacted">接受邀请或主动加入后展示</option>
          </Select>
        </label>
        {kind === "library" &&
          toggle(
            "展示站内公开知识库",
            "关闭后，需用户主动加入才出现在知识库列表。",
            value?.publicLibraries ?? false,
            (v) => void save({ publicLibraries: v }),
          )}
        {toggle(
          "打开后自动加入列表",
          "仅对已有访问权限的内容生效。",
          policy?.autoCollectOpened ?? false,
          (v) => patch({ autoCollectOpened: v }),
        )}
        <h4>工单人员信息</h4>
        {toggle(
          "向申请人展示审批人",
          "仅控制申请人看到的人员信息。",
          policy?.ticketReviewers.access ?? false,
          (v) =>
            patch({
              ticketReviewers: { ...policy!.ticketReviewers, access: v },
            }),
        )}
        {toggle(
          "向受邀人展示邀请处理人员",
          "其他相关人员的查看权限不变。",
          policy?.ticketReviewers.invitation ?? false,
          (v) =>
            patch({
              ticketReviewers: { ...policy!.ticketReviewers, invitation: v },
            }),
        )}
      </section>
    );
  };
  return (
    <>
      <div className="distribution-cards">
        {contentCard("document", "文档")}
        {contentCard("library", "知识库")}
      </div>
      <section className="admin-card admin-form-section">
        <h3>公共发现</h3>
        <label className="setting-toggle">
          <span>
            <strong>开放公共发现入口</strong>
            <small>
              适用于文档和知识库，仅展示允许被发现且用户有权访问的内容。
            </small>
          </span>
          <input
            type="checkbox"
            disabled={!value || busy}
            checked={value?.publicDiscovery ?? false}
            onChange={(e) => void save({ publicDiscovery: e.target.checked })}
          />
        </label>
      </section>
      <Feedback message={error} tone="error" />
    </>
  );
}

export function Invitations({ changed }: { changed: () => void }) {
  const [items, setItems] = useState<
      {
        id: string;
        title: string;
        kind: string;
        state: string;
        role: string;
        version: number;
      }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<{ items: typeof items }>("/me/invitations").then((d) =>
      setItems(d.items),
    );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    return realtime.subscribe((m) => {
      if (["notifications.changed", "connected"].includes(m.type))
        void load().catch(() => {});
    });
  }, []);
  return (
    <details className="invitation-inbox">
      <summary>待处理分享{items.length ? ` · ${items.length}` : ""}</summary>
      <div>
        {!items.length && <p className="subtle">暂无待处理分享</p>}
        {items.map((i) => (
          <div className="invitation-row" key={i.id}>
            <span>
              <strong>{i.title}</strong>
              <small>
                {i.kind === "library" ? "知识库" : "文档"} ·{" "}
                {i.state === "pending"
                  ? "接受后获得权限"
                  : "已授权，可加入列表"}
              </small>
            </span>
            {[true, false].map((accept) => (
              <button
                key={String(accept)}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/me/invitations/${i.id}`, "POST", {
                      accept,
                      version: i.version,
                    });
                    await load();
                    changed();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {accept ? "接受" : "拒绝"}
              </button>
            ))}
          </div>
        ))}
        <Feedback message={error} tone="error" />
      </div>
    </details>
  );
}
