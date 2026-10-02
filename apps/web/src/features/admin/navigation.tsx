import { useEffect, useState } from "react";
import { Button, Input, InputNumber, Modal, Select, Tabs, Tag } from "antd";
import { Save, Send, RotateCcw, Settings2 } from "lucide-react";
import {
  navigationSlots,
  allowedNavigationSlots,
  isAdminNavigationEntry,
  resolveNavigation,
  supportedPlacements,
  type NavigationConfig,
  type NavigationEntry,
  type NavigationSlot,
  type NavigationPlacement,
} from "@smartdoca/web-plugin-registry";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { MoreNavigation, NavigationArea } from "@web/plugins/navigation.js";
import "./navigation.css";
type State = {
  revision: number;
  draft: NavigationConfig;
  published: NavigationConfig;
  entries: NavigationEntry[];
};
export function NavigationSettings() {
  const { t, locale } = useI18n();
  const [modal, contextHolder] = Modal.useModal();
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [surface, setSurface] = useState("web"),
    [query, setQuery] = useState("");
  const target = surface === "mobile" ? "mobile" : "web";
  const matchesSlot = (slot: NavigationSlot) =>
    surface === "admin"
      ? slot === "web.admin"
      : slot !== "web.admin" && slot.startsWith(`${target}.`);
  const load = () =>
    api<State>("/admin/navigation")
      .then((next) =>
        setState({
          ...next,
          draft: {
            ...next.draft,
            layout: {
              ...next.draft.layout,
              placements: supportedPlacements(
                next.entries,
                next.draft.layout.placements,
              ),
            },
          },
        }),
      )
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const config: NavigationConfig = state?.draft ?? {
    schemaVersion: 1,
    layout: { placements: [] },
  };
  const update = (next: NavigationConfig) => {
    if (state) setState({ ...state, draft: next });
  };
  const save = async (action: "save" | "publish" | "reset") => {
    if (!state || busy) return;
    const next = {
      ...config,
      layout: {
        ...config.layout,
        placements: supportedPlacements(
          state.entries,
          config.layout.placements,
        ),
      },
    };
    setBusy(action);
    setError("");
    try {
      await api("/admin/navigation", "POST", {
        revision: state.revision,
        action,
        config: next,
      });
      await load();
      window.dispatchEvent(new Event("doca-navigation"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!state) return <p>{error || t("plugins.loading")}</p>;
  const resolved = resolveNavigation(state.entries, config, {
    id: "preview",
    admin: true,
  });
  // Edit the draft, not the overflow-resolved preview, preserving other platforms and hidden placements.
  const placementsFor = (entry: NavigationEntry): NavigationPlacement[] =>
    config.layout.placements.some((p) => p.entryId === entry.id)
      ? config.layout.placements.filter((p) => p.entryId === entry.id)
      : entry.defaults.map((slot) => ({
          entryId: entry.id,
          slot,
          order: entry.order,
        }));
  const replace = (entry: NavigationEntry, placements: NavigationPlacement[]) =>
    update({
      ...config,
      layout: {
        ...config.layout,
        placements: [
          ...config.layout.placements.filter((p) => p.entryId !== entry.id),
          ...placements,
        ],
      },
    });
  const patch = (
    entry: NavigationEntry,
    slot: NavigationSlot,
    values: Partial<NavigationPlacement>,
  ) =>
    replace(
      entry,
      placementsFor(entry).map((p) =>
        p.slot === slot ? { ...p, ...values } : p,
      ),
    );
  const entries = state.entries.filter(
    (e) =>
      allowedNavigationSlots(e).some(matchesSlot) &&
      `${e.title[locale]} ${e.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="navigation-settings">
      {contextHolder}
      <header className="navigation-settings-heading">
        <div>
          <h2>{t("navigation.title")}</h2>
          <p>{t("navigation.globalHelp")}</p>
        </div>
        <div className="navigation-settings-actions">
          <Button
            icon={<RotateCcw size={15} />}
            disabled={!!busy}
            onClick={async () => {
              if (
                await modal.confirm({
                  title: t("navigation.reset"),
                  content: t("navigation.resetConfirm"),
                  okText: t("common.confirm"),
                  cancelText: t("common.cancel"),
                  okButtonProps: { danger: true },
                  autoFocusButton: "cancel",
                })
              )
                void save("reset");
            }}
          >
            {t("navigation.reset")}
          </Button>
          <Button
            icon={<Save size={15} />}
            loading={busy === "save"}
            disabled={!!busy}
            onClick={() => void save("save")}
          >
            {t("navigation.save")}
          </Button>
          <Button
            type="primary"
            icon={<Send size={15} />}
            loading={busy === "publish"}
            disabled={!!busy}
            onClick={() => void save("publish")}
          >
            {t("navigation.publish")}
          </Button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      <Tabs
        activeKey={surface}
        onChange={setSurface}
        items={[
          { key: "web", label: t("navigation.webUser") },
          { key: "mobile", label: t("navigation.appUser") },
          { key: "admin", label: t("navigation.webAdmin") },
        ]}
      />
      {surface !== "admin" && (
        <section className="navigation-settings-card">
          <h3>{t("navigation.platformHome")}</h3>
          <div className="navigation-form-grid">
            <label>
              <span>{t("navigation.home")}</span>
              <Select
                showSearch
                optionFilterProp="label"
                aria-label={t("navigation.home")}
                value={config.layout.home?.[target] ?? ""}
                onChange={(value) =>
                  update({
                    ...config,
                    layout: {
                      ...config.layout,
                      home: {
                        ...config.layout.home,
                        [target]: value || undefined,
                      },
                    },
                  })
                }
                options={[
                  { value: "", label: t("navigation.default") },
                  ...state.entries
                    .filter((e) =>
                      target === "web"
                        ? !isAdminNavigationEntry(e) &&
                          e.webPath &&
                          !["doca.search", "doca.notifications"].includes(e.id)
                        : !isAdminNavigationEntry(e) &&
                          (e.mobilePath || e.mobile),
                    )
                    .map((e) => ({ value: e.id, label: e.title[locale] })),
                ]}
              />
            </label>
          </div>
        </section>
      )}
      <section className="navigation-settings-card">
        <div className="navigation-section-heading">
          <h3>{t("navigation.entry")}</h3>
          <Input.Search
            aria-label={t("navigation.searchEntries")}
            placeholder={t("navigation.searchEntries")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            allowClear
          />
        </div>
        <p className="navigation-hint">{t("navigation.entriesHelp")}</p>
        <div className="navigation-entry-grid">
          {entries.map((entry) => {
            const all = placementsFor(entry),
              current = all.filter((p) => !p.hidden && matchesSlot(p.slot));
            return (
              <article className="navigation-entry-card" key={entry.id}>
                <header>
                  <h4>
                    {entry.title[locale]}{" "}
                    {entry.pluginId && (
                      <Tag color="blue">{t("navigation.pluginEntry")}</Tag>
                    )}
                  </h4>
                  <small>{entry.id}</small>
                </header>
                <label>
                  <span>{t("navigation.positions")}</span>
                  <Select
                    mode="multiple"
                    aria-label={`${entry.title[locale]} · ${t("navigation.positions")}`}
                    value={current.map((p) => p.slot)}
                    options={allowedNavigationSlots(entry)
                      .filter(matchesSlot)
                      .map((value) => ({
                        value,
                        label: t(`navigation.slot.${value}`),
                      }))}
                    onChange={(slots: NavigationSlot[]) => {
                      const next = [
                        ...all.filter((p) => !matchesSlot(p.slot)),
                        ...slots.map(
                          (slot) =>
                            all.find((p) => p.slot === slot && !p.hidden) ?? {
                              entryId: entry.id,
                              slot,
                              order: entry.order,
                            },
                        ),
                      ];
                      if (!slots.length) {
                        const slot = allowedNavigationSlots(entry).find((s) =>
                          matchesSlot(s),
                        )!;
                        next.push({
                          entryId: entry.id,
                          slot,
                          order: entry.order,
                          hidden: true,
                        });
                      }
                      replace(entry, next);
                    }}
                  />
                </label>
                {current.length > 0 && (
                  <details className="navigation-entry-details">
                    <summary>
                      <Settings2 size={15} />
                      {t("navigation.details")}
                    </summary>
                    {current.map((p) => (
                      <section
                        className="navigation-placement-card"
                        key={p.slot}
                      >
                        <h5>{t(`navigation.slot.${p.slot}`)}</h5>
                        <div className="navigation-placement-fields">
                          <label>
                            <span>{t("navigation.display")}</span>
                            <Select
                              aria-label={t("navigation.display")}
                              disabled={[
                                "web.topRight",
                                "web.more",
                                "web.leftMore",
                              ].includes(p.slot)}
                              value={
                                ["web.topRight", "web.more"].includes(p.slot)
                                  ? "icon"
                                  : p.slot === "web.leftMore"
                                    ? "both"
                                    : (p.display ?? "both")
                              }
                              options={(["both", "icon", "text"] as const).map(
                                (value) => ({
                                  value,
                                  label: t(`navigation.${value}`),
                                }),
                              )}
                              onChange={(display) =>
                                patch(entry, p.slot, { display })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("navigation.label")}</span>
                            <Input
                              value={(p.title ?? entry.title)[locale]}
                              onChange={(e) =>
                                patch(entry, p.slot, {
                                  title: {
                                    ...(p.title ?? entry.title),
                                    [locale]: e.target.value,
                                  },
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("navigation.order")}</span>
                            <InputNumber
                              value={p.order}
                              onChange={(order) =>
                                patch(entry, p.slot, { order: order ?? 0 })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("navigation.icon")}</span>
                            <Input
                              value={p.icon ?? entry.icon}
                              onChange={(e) =>
                                patch(entry, p.slot, { icon: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("navigation.group")}</span>
                            <Input
                              value={p.group ?? ""}
                              onChange={(e) =>
                                patch(entry, p.slot, { group: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            <span>{t("navigation.collapsed")}</span>
                            <Select
                              value={p.collapsed ? "collapsed" : "expanded"}
                              aria-label={t("navigation.collapsed")}
                              options={[
                                {
                                  value: "expanded",
                                  label: t("navigation.expanded"),
                                },
                                {
                                  value: "collapsed",
                                  label: t("navigation.collapsed"),
                                },
                              ]}
                              onChange={(value) =>
                                patch(entry, p.slot, {
                                  collapsed: value === "collapsed",
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>
                    ))}
                  </details>
                )}
              </article>
            );
          })}
        </div>
        {!entries.length && <p>{t("plugins.noResults")}</p>}
      </section>
      <section className="navigation-settings-card">
        <h3>{t("navigation.preview")}</h3>
        <p className="navigation-hint">{t("navigation.previewHelp")}</p>
        <div className="navigation-preview navigation-preview-grid">
          {navigationSlots
            .filter(
              (s) =>
                matchesSlot(s) &&
                resolved.layout.placements.some((p) => p.slot === s),
            )
            .map((slot) => (
              <div className="navigation-preview-card" key={slot}>
                <strong>{t(`navigation.slot.${slot}`)}</strong>
                {target === "web" ? (
                  slot === "web.more" || slot === "web.leftMore" ? (
                    <MoreNavigation
                      data={resolved}
                      showExtensions={false}
                      position={slot === "web.leftMore" ? "left" : "topRight"}
                    />
                  ) : (
                    <NavigationArea slot={slot} data={resolved} />
                  )
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
    </section>
  );
}
