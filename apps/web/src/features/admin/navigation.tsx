import { useEffect, useState } from "react";
import {
  navigationSlots,
  resolveNavigation,
  type NavigationConfig,
  type NavigationEntry,
  type NavigationSlot,
  type NavigationPlacement,
} from "@smartdoca/web-plugin-registry";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { NavigationArea } from "@web/plugins/navigation.js";
type State = {
  revision: number;
  draft: NavigationConfig;
  published: NavigationConfig;
  entries: NavigationEntry[];
};
export function NavigationSettings() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<"web" | "mobile">("web"),
    [ruleIndex, setRuleIndex] = useState(0);
  const load = () =>
    api<State>("/admin/navigation")
      .then(setState)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const config = state?.draft ?? { rules: [] };
  const rule = config.rules[ruleIndex] ?? {
    id: "default",
    priority: 0,
    audience: "all" as const,
    layout: { placements: [] },
  };
  const update = (next: typeof rule) => {
    if (!state) return;
    const rules = [...config.rules];
    rules[ruleIndex] = next;
    setState({ ...state, draft: { rules } });
  };
  const save = async (action: "save" | "publish" | "reset") => {
    if (!state) return;
    setBusy(true);
    setError("");
    try {
      await api("/admin/navigation", "POST", {
        revision: state.revision,
        action,
        config: state.draft,
      });
      await load();
      window.dispatchEvent(new Event("doca-navigation"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!state) return <p>{error || t("plugins.loading")}</p>;
  const resolved = resolveNavigation(
    state.entries,
    { rules: [{ ...rule, audience: "all" }] },
    { id: "preview", admin: true },
  );
  const place = (
    entry: NavigationEntry,
    slot: NavigationSlot,
    checked: boolean,
  ) => {
    const current: NavigationPlacement[] = rule.layout.placements.some(
      (p) => p.entryId === entry.id,
    )
      ? rule.layout.placements.filter((p) => p.entryId === entry.id)
      : entry.defaults.map((s) => ({
          entryId: entry.id,
          slot: s,
          order: entry.order,
        }));
    const next = current.filter((p) => p.slot !== slot);
    if (checked) next.push({ entryId: entry.id, slot, order: entry.order });
    if (!next.length)
      next.push({ entryId: entry.id, slot, order: entry.order, hidden: true });
    update({
      ...rule,
      layout: {
        ...rule.layout,
        placements: [
          ...rule.layout.placements.filter((p) => p.entryId !== entry.id),
          ...next,
        ],
      },
    });
  };
  return (
    <section className="navigation-editor">
      <h2>{t("navigation.title")}</h2>
      <p>{t("navigation.help")}</p>
      <header>
        <button disabled={busy} onClick={() => void save("save")}>
          {t("navigation.save")}
        </button>
        <button disabled={busy} onClick={() => void save("publish")}>
          {t("navigation.publish")}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            if (confirm(t("navigation.resetConfirm"))) void save("reset");
          }}
        >
          {t("navigation.reset")}
        </button>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as "web" | "mobile")}
        >
          <option value="web">Web</option>
          <option value="mobile">App</option>
        </select>
      </header>
      {error && <p role="alert">{error}</p>}
      <fieldset>
        <legend>{t("navigation.rules")}</legend>
        <select
          value={ruleIndex}
          onChange={(e) => setRuleIndex(Number(e.target.value))}
        >
          {(config.rules.length ? config.rules : [rule]).map((r, i) => (
            <option key={r.id} value={i}>
              {r.id}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const rules = config.rules.length ? [...config.rules] : [rule];
            rules.push({
              id: `rule.${Date.now()}`,
              priority: rules.length,
              audience: "member",
              layout: { placements: [] },
            });
            setState({ ...state, draft: { rules } });
            setRuleIndex(rules.length - 1);
          }}
        >
          {t("navigation.addRule")}
        </button>
        <label>
          {t("navigation.audience")}
          <select
            value={rule.audience}
            onChange={(e) =>
              update({
                ...rule,
                audience: e.target.value as typeof rule.audience,
              })
            }
          >
            {(["all", "admin", "member", "users"] as const).map((a) => (
              <option key={a} value={a}>
                {t(`navigation.${a}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("navigation.priority")}
          <input
            type="number"
            value={rule.priority}
            min={0}
            max={10000}
            onChange={(e) =>
              update({ ...rule, priority: Number(e.target.value) })
            }
          />
        </label>
        {rule.audience === "users" && (
          <input
            aria-label={t("navigation.userIds")}
            placeholder={t("navigation.userIds")}
            value={rule.userIds?.join(",") ?? ""}
            onChange={(e) =>
              update({
                ...rule,
                userIds: e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        )}
      </fieldset>
      <label>
        {t("navigation.home")}
        <select
          value={rule.layout.home?.[target] ?? ""}
          onChange={(e) =>
            update({
              ...rule,
              layout: {
                ...rule.layout,
                home: {
                  ...rule.layout.home,
                  [target]: e.target.value || undefined,
                },
              },
            })
          }
        >
          <option value="">{t("navigation.default")}</option>
          {state.entries
            .filter((e) =>
              target === "web"
                ? e.webPath &&
                  !["doca.search", "doca.notifications"].includes(e.id)
                : e.mobilePath || e.mobile,
            )
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.title[locale]}
              </option>
            ))}
        </select>
      </label>
      <table>
        <thead>
          <tr>
            <th>{t("navigation.entry")}</th>
            <th>{t("navigation.positions")}</th>
            <th>{t("navigation.orderGroup")}</th>
          </tr>
        </thead>
        <tbody>
          {state.entries
            .filter((e) =>
              e.allowedSlots.some((s) => s.startsWith(`${target}.`)),
            )
            .map((entry) => {
              const placements = resolved.layout.placements.filter(
                (p) => p.entryId === entry.id,
              );
              return (
                <tr
                  key={entry.id}
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/plain", entry.id)
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const source = e.dataTransfer.getData("text/plain");
                    const moved = state.entries.find((x) => x.id === source);
                    if (!moved) return;
                    const current: NavigationPlacement[] =
                      resolved.layout.placements.filter(
                        (p) => p.entryId === source,
                      );
                    update({
                      ...rule,
                      layout: {
                        ...rule.layout,
                        placements: [
                          ...rule.layout.placements.filter(
                            (p) => p.entryId !== source,
                          ),
                          ...current.map((p) => ({
                            ...p,
                            order: (placements[0]?.order ?? entry.order) - 1,
                          })),
                        ],
                      },
                    });
                  }}
                >
                  <td>
                    {entry.title[locale]}
                    <br />
                    <small>{entry.id}</small>
                  </td>
                  <td>
                    {entry.allowedSlots
                      .filter((s) => s.startsWith(`${target}.`))
                      .map((slot) => (
                        <label
                          key={slot}
                          style={{ display: "inline-flex", margin: 6, gap: 4 }}
                        >
                          <input
                            type="checkbox"
                            checked={placements.some((p) => p.slot === slot)}
                            onChange={(e) =>
                              place(entry, slot, e.target.checked)
                            }
                          />
                          {t(`navigation.slot.${slot}`)}
                        </label>
                      ))}
                  </td>
                  <td>
                    {placements
                      .filter((p) => p.slot.startsWith(`${target}.`))
                      .map((p) => (
                        <div key={p.slot}>
                          <small>{t(`navigation.slot.${p.slot}`)}</small>
                          <input
                            aria-label={t("navigation.icon")}
                            value={p.icon ?? entry.icon}
                            onChange={(e) =>
                              update({
                                ...rule,
                                layout: {
                                  ...rule.layout,
                                  placements: [
                                    ...rule.layout.placements.filter(
                                      (x) => x.entryId !== entry.id,
                                    ),
                                    ...placements.map((x) =>
                                      x.slot === p.slot
                                        ? { ...x, icon: e.target.value }
                                        : x,
                                    ),
                                  ],
                                },
                              })
                            }
                          />
                          <select
                            aria-label={t("navigation.display")}
                            value={p.display ?? "both"}
                            onChange={(e) =>
                              update({
                                ...rule,
                                layout: {
                                  ...rule.layout,
                                  placements: [
                                    ...rule.layout.placements.filter(
                                      (x) => x.entryId !== entry.id,
                                    ),
                                    ...placements.map((x) =>
                                      x.slot === p.slot
                                        ? {
                                            ...x,
                                            display: e.target.value as
                                              "both" | "icon" | "text",
                                          }
                                        : x,
                                    ),
                                  ],
                                },
                              })
                            }
                          >
                            {(["both", "icon", "text"] as const).map((v) => (
                              <option key={v} value={v}>
                                {t(`navigation.${v}`)}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label={t("navigation.label")}
                            value={(p.title ?? entry.title)[locale]}
                            onChange={(e) =>
                              update({
                                ...rule,
                                layout: {
                                  ...rule.layout,
                                  placements: [
                                    ...rule.layout.placements.filter(
                                      (x) => x.entryId !== entry.id,
                                    ),
                                    ...placements.map((x) =>
                                      x.slot === p.slot
                                        ? {
                                            ...x,
                                            title: {
                                              ...(x.title ?? entry.title),
                                              [locale]: e.target.value,
                                            },
                                          }
                                        : x,
                                    ),
                                  ],
                                },
                              })
                            }
                          />
                          <label>
                            <input
                              type="checkbox"
                              checked={p.collapsed ?? false}
                              onChange={(e) =>
                                update({
                                  ...rule,
                                  layout: {
                                    ...rule.layout,
                                    placements: [
                                      ...rule.layout.placements.filter(
                                        (x) => x.entryId !== entry.id,
                                      ),
                                      ...placements.map((x) =>
                                        x.slot === p.slot
                                          ? {
                                              ...x,
                                              collapsed: e.target.checked,
                                            }
                                          : x,
                                      ),
                                    ],
                                  },
                                })
                              }
                            />
                            {t("navigation.collapsed")}
                          </label>
                          <input
                            aria-label={t("navigation.order")}
                            type="number"
                            value={p.order}
                            onChange={(e) => {
                              const others = rule.layout.placements.some(
                                (x) => x.entryId === entry.id,
                              )
                                ? rule.layout.placements
                                : [
                                    ...rule.layout.placements,
                                    ...entry.defaults.map((slot) => ({
                                      entryId: entry.id,
                                      slot,
                                      order: entry.order,
                                    })),
                                  ];
                              update({
                                ...rule,
                                layout: {
                                  ...rule.layout,
                                  placements: others.map((x) =>
                                    x.entryId === entry.id && x.slot === p.slot
                                      ? { ...x, order: Number(e.target.value) }
                                      : x,
                                  ),
                                },
                              });
                            }}
                          />
                          <input
                            aria-label={t("navigation.group")}
                            placeholder={t("navigation.group")}
                            value={p.group ?? ""}
                            onChange={(e) => {
                              const others = rule.layout.placements.filter(
                                (x) => x.entryId !== entry.id,
                              );
                              update({
                                ...rule,
                                layout: {
                                  ...rule.layout,
                                  placements: [
                                    ...others,
                                    ...placements.map((x) =>
                                      x.slot === p.slot
                                        ? { ...x, group: e.target.value }
                                        : x,
                                    ),
                                  ],
                                },
                              });
                            }}
                          />
                        </div>
                      ))}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <h3>{t("navigation.preview")}</h3>
      <div className="navigation-preview">
        {navigationSlots
          .filter((s) => s.startsWith(`${target}.`))
          .map((slot) => (
            <div key={slot}>
              <strong>{t(`navigation.slot.${slot}`)}</strong>
              {target === "web" ? (
                <NavigationArea slot={slot} data={resolved} />
              ) : (
                resolved.layout.placements
                  .filter((p) => p.slot === slot)
                  .map((p) => (
                    <p key={p.entryId}>
                      {
                        state.entries.find((e) => e.id === p.entryId)?.title[
                          locale
                        ]
                      }
                    </p>
                  ))
              )}
            </div>
          ))}
      </div>
    </section>
  );
}
