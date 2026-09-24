import { MembershipIconPicker } from "@web/features/settings/membership-icon-picker.js";
import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Dialog } from "@web/features/documents/dialogs.js";
import { MembershipIcon } from "@web/features/settings/membership-icon.js";
import { Feedback } from "@web/shared/components/feedback.js";
export type Level = {
  id: string;
  name: string;
  rank: number;
  color?: string;
  icon?: string;
  limits: Record<string, number | null>;
};
export function MembershipLevels({
  levels,
  defaultLevel,
  busy,
  save,
}: {
  levels: Level[];
  defaultLevel: string;
  busy: boolean;
  save: (levels: Level[], defaultLevel: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Level | null>(null),
    [editing, setEditing] = useState(false),
    [isDefault, setIsDefault] = useState(false),
    [error, setError] = useState("");
  function open(level?: Level) {
    setEditing(!!level);
    setDraft(
      level
        ? { ...level }
        : {
            id: "",
            name: "",
            rank: Math.max(...levels.map((l) => l.rank)) + 1,
            limits: {
              ...levels.reduce((a, b) => (a.rank > b.rank ? a : b)).limits,
            },
            icon: "",
          },
    );
    setIsDefault(level?.id === defaultLevel);
    setError("");
  }
  return (
    <>
      <div className="membership-table-heading">
        <h3>等级模板</h3>
        <button
          className="primary"
          type="button"
          disabled={busy || levels.length >= 30}
          onClick={() => open()}
        >
          <Plus size={16} />
          新增等级
        </button>
      </div>
      <div className="account-table-scroll">
        <table className="membership-level-table">
          <thead>
            <tr>
              <th>等级名称</th>
              <th>等级 ID</th>
              <th>顺序</th>
              <th>默认等级</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {[...levels]
              .sort((a, b) => a.rank - b.rank)
              .map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="membership-label">
                      <MembershipIcon icon={l.icon} />
                      <strong style={{ color: l.color }}>{l.name}</strong>
                    </span>
                  </td>
                  <td className="subtle">{l.id}</td>
                  <td>{l.rank}</td>
                  <td>
                    <input
                      role="switch"
                      type="checkbox"
                      aria-label={`将${l.name}设为默认等级`}
                      checked={l.id === defaultLevel}
                      disabled={busy || l.id === defaultLevel}
                      onChange={() => void save(levels, l.id)}
                    />
                  </td>
                  <td>
                    <div className="membership-row-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => open(l)}
                        aria-label={`修改${l.name}`}
                      >
                        <Pencil size={15} />
                        修改
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy || l.id === defaultLevel || levels.length === 1
                        }
                        onClick={() =>
                          void save(
                            levels.filter((x) => x.id !== l.id),
                            defaultLevel,
                          )
                        }
                        aria-label={`删除${l.name}`}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="admin-field-help">
        新用户使用默认等级。开启另一个等级的默认开关，会自动替换当前默认等级。
      </p>
      {draft && (
        <Dialog
          title={editing ? "修改等级" : "新增等级"}
          close={() => {
            if (!busy) setDraft(null);
          }}
          className="membership-level-dialog"
        >
          <form
            className="admin-account-form"
            onSubmit={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              setError("");
              const value = {
                ...draft,
                id: draft.id.trim(),
                name: draft.name.trim(),
              };
              if (!editing && levels.some((l) => l.id === value.id)) {
                setError("等级 ID 已存在");
                return;
              }
              if (
                levels.some((l) => l.id !== value.id && l.rank === value.rank)
              ) {
                setError("顺序不能与其他等级重复");
                return;
              }
              const next = editing
                ? levels.map((l) => (l.id === value.id ? value : l))
                : [...levels, value];
              if (await save(next, isDefault ? value.id : defaultLevel))
                setDraft(null);
              else setError("未能保存，请检查页面提示后重试。");
            }}
          >
            <div className="membership-editor-fields">
              <label>
                等级 ID
                <input
                  required
                  maxLength={64}
                  pattern="[a-z][a-z0-9_-]{0,63}"
                  disabled={editing}
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder="例如 vip"
                />
              </label>
              <label>
                等级名称
                <input
                  required
                  maxLength={64}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="例如 黄金会员"
                />
              </label>
              <label>
                等级顺序
                <input
                  type="number"
                  required
                  min={0}
                  step={1}
                  value={draft.rank}
                  onChange={(e) =>
                    setDraft({ ...draft, rank: Number(e.target.value) })
                  }
                />
              </label>
              <label className="setting-toggle">
                <span>设为默认等级</span>
                <input
                  role="switch"
                  type="checkbox"
                  checked={isDefault}
                  disabled={editing && draft.id === defaultLevel}
                  onChange={(e) => setIsDefault(e.target.checked)}
                />
              </label>
            </div>
            <label className="membership-color-field">
              等级名称颜色
              <div>
                <input
                  type="color"
                  aria-label="选择名称颜色"
                  value={
                    /^#[0-9a-fA-F]{6}$/.test(draft.color || "")
                      ? draft.color!
                      : "#334155"
                  }
                  onChange={(e) =>
                    setDraft({ ...draft, color: e.target.value })
                  }
                />
                <input
                  type="text"
                  aria-label="名称颜色值"
                  value={draft.color || ""}
                  placeholder="跟随主题"
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  onChange={(e) =>
                    setDraft({ ...draft, color: e.target.value })
                  }
                />
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, color: "" })}
                >
                  恢复默认
                </button>
              </div>
            </label>
            <MembershipIconPicker
              label="等级图标"
              value={draft.icon}
              onChange={(icon) => setDraft({ ...draft, icon })}
            />
            <div className="membership-level-preview">
              <small>展示预览</small>
              <span className="membership-label">
                <MembershipIcon icon={draft.icon} />
                <strong style={{ color: draft.color }}>
                  {draft.name || "等级名称"}
                </strong>
              </span>
            </div>
            <Feedback message={error} tone="error" />
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "正在保存…" : "保存等级"}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </>
  );
}
