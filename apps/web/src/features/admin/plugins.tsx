import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Drawer, Select, Button, Modal } from "antd";
import {
  Package,
  RefreshCw,
  Upload,
  ArrowLeft,
  Search,
  Download,
  Heart,
  LayoutGrid,
  Code2,
  Users,
  Sparkles,
  Blocks,
  X,
  CircleCheck,
  CircleAlert,
  Power,
  Trash2,
  Play,
} from "lucide-react";
import {
  comparePluginVersions,
  satisfiesPluginVersion,
} from "@smartdoca/plugin-contracts";
import { PLUGIN_SDK_VERSION } from "@smartdoca/plugin-sdk/version";
import type {
  PluginInventory,
  StoreCatalog,
  StorePlugin,
  StoreRelease,
  StoreDetail,
  StorePage,
  StoreUpdate,
} from "@core/shared/plugin-store.js";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { PluginDescription } from "./plugin-description.js";
import "./plugins.css";
const categoryIcons: Record<string, typeof Package> = {
  productivity: Sparkles,
  collaboration: Users,
  content: Package,
  integration: Blocks,
  developer: Code2,
  other: LayoutGrid,
};
export function Plugins() {
  const { t, locale } = useI18n();
  const [modal, modalContext] = Modal.useModal();
  const confirmAction = (content: string, destructive = false) =>
    modal.confirm({
      title: t(destructive ? "plugins.remove" : "common.confirm"),
      content,
      okText: t(destructive ? "plugins.remove" : "common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: destructive },
      centered: true,
      autoFocusButton: "cancel",
      closable: true,
    });
  const [inventory, setInventory] = useState<PluginInventory | null>(null),
    [catalog, setCatalog] = useState<StoreCatalog | null>(null),
    [categories, setCategories] = useState<
      { id: string; name: string; count?: number | null }[]
    >([]),
    [tab, setTab] = useState<"all" | "installed" | "upgrades" | "settings">(
      "all",
    ),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [sort, setSort] = useState("updated"),
    [target, setTarget] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [storeError, setStoreError] = useState(""),
    [categoryError, setCategoryError] = useState(false),
    [updatesError, setUpdatesError] = useState(""),
    [updates, setUpdates] = useState<StoreUpdate[]>([]),
    [detail, setDetail] = useState<string | null>(() =>
      new URLSearchParams(location.hash.split("?")[1]).get("plugin"),
    ),
    [remoteDetail, setRemoteDetail] = useState<StoreDetail | null>(null),
    [releases, setReleases] = useState<StorePage<StoreRelease> | null>(null),
    [detailError, setDetailError] = useState(""),
    [npmName, setNpmName] = useState(""),
    [npmVersion, setNpmVersion] = useState("");
  const openDetail = (id: string | null) => {
    const params = new URLSearchParams(location.hash.split("?")[1]);
    if (id) params.set("plugin", id);
    else params.delete("plugin");
    location.hash = `/admin?${params}`;
    setDetail(id);
  };
  useEffect(() => {
    const sync = () =>
      setDetail(new URLSearchParams(location.hash.split("?")[1]).get("plugin"));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const [operations, setOperations] = useState<
    {
      id: string;
      operation: string;
      stage: "requested" | "staged" | "failed";
      operationId: string;
      created_at: string;
      pluginId: string | null;
      packageName: string | null;
      version: string | null;
      error: string | null;
      active: boolean;
    }[]
  >([]);
  const [historyError, setHistoryError] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [activeAction, setActiveAction] = useState("");
  const acting = useRef(false);
  const seenActive = useRef<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPlugin, setHistoryPlugin] = useState("");
  const openHistory = () => {
    setHistoryPlugin(detail ?? "");
    setHistoryOpen(true);
    void loadOperations();
  };
  const loadOperations = async () => {
    try {
      setOperations(
        (await api<{ items: typeof operations }>("/admin/plugins/operations"))
          .items,
      );
      setHistoryError(false);
    } catch {
      setHistoryError(true);
    }
  };
  useEffect(() => {
    void loadOperations();
  }, []);
  const generation = useRef(0),
    detailGeneration = useRef(0);
  const refresh = async () => {
    try {
      setInventory(await api<PluginInventory>("/admin/plugins"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const checkUpdates = async () => {
    setUpdatesError("");
    try {
      setUpdates(
        (await api<{ items: StoreUpdate[] }>("/admin/plugins/updates")).items,
      );
    } catch (e) {
      setUpdatesError((e as Error).message);
    }
  };
  const stageRank = { requested: 0, staged: 1, failed: 1 };
  const latestOperations = new Map<string, (typeof operations)[number]>();
  for (const item of operations) {
    const current = latestOperations.get(item.operationId);
    if (
      !current ||
      item.created_at > current.created_at ||
      (item.created_at === current.created_at &&
        stageRank[item.stage] > stageRank[current.stage])
    )
      latestOperations.set(item.operationId, item);
  }
  const activeOperation = [...latestOperations.values()].find(
    (item) => item.active && item.stage === "requested",
  );
  const operationLocked = busy || Boolean(activeOperation);
  const operationPending = (
    operation: string,
    pluginId?: string | null,
    version?: string | null,
  ) =>
    Boolean(
      (activeOperation?.operation === operation &&
        (pluginId == null || activeOperation.pluginId === pluginId) &&
        (version == null || activeOperation.version === version)) ||
      (busy &&
        activeAction ===
          (operation === "install" && version != null
            ? `release:${version}`
            : operation)),
    );
  useEffect(() => {
    if (!busy && !activeOperation) return;
    const origin =
      busy || !activeOperation
        ? Date.now()
        : new Date(activeOperation.created_at).getTime();
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    const poll = setInterval(() => void loadOperations(), 3000);
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [busy, activeOperation?.operationId, activeOperation?.created_at]);
  useEffect(() => {
    if (activeOperation) {
      seenActive.current = activeOperation.operationId;
      return;
    }
    const id = seenActive.current;
    if (!id) return;
    const latest = latestOperations.get(id);
    if (!latest || latest.stage === "requested") return;
    seenActive.current = null;
    if (busy) return;
    if (latest.stage === "failed")
      setOperationError(latest.error || t("plugins.failed"));
    else {
      setCompleted(true);
      setUpdates([]);
      void refresh();
      void checkUpdates();
    }
  }, [operations, busy, activeOperation, t]);
  const loadCatalog = async (
    cursor?: string,
    expectedGeneration = generation.current,
  ) => {
    setLoading(true);
    setStoreError("");
    try {
      const params = new URLSearchParams({
        locale,
        sort,
        limit: "24",
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(category ? { category } : {}),
        ...(target ? { target } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const result = await api<StoreCatalog>(
        `/admin/plugins/catalog?${params}`,
      );
      if (generation.current !== expectedGeneration) return;
      setCatalog((old) =>
        cursor && old
          ? {
              ...result,
              items: [
                ...old.items,
                ...result.items.filter(
                  (p) => !old.items.some((x) => x.id === p.id),
                ),
              ],
            }
          : result,
      );
    } catch (e) {
      if (
        cursor &&
        (e as { status?: number }).status === 410 &&
        generation.current === expectedGeneration
      ) {
        setCatalog(null);
        await loadCatalog(undefined, expectedGeneration);
        return;
      }
      if (generation.current === expectedGeneration)
        setStoreError((e as Error).message);
    } finally {
      if (generation.current === expectedGeneration) setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    void checkUpdates();
  }, []);
  useEffect(() => {
    const version = ++generation.current;
    setCatalog(null);
    setLoading(true);
    const timer = setTimeout(() => void loadCatalog(undefined, version), 250);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [query, category, sort, target, locale]);
  useEffect(() => {
    let active = true;
    void api<{ items: { id: string; name: string; count?: number | null }[] }>(
      `/admin/plugins/categories?locale=${locale}`,
    )
      .then((r) => {
        if (active) {
          setCategories(r.items);
          setCategoryError(false);
        }
      })
      .catch(() => {
        if (active) setCategoryError(true);
      });
    return () => {
      active = false;
    };
  }, [locale]);
  useEffect(() => {
    if (tab === "installed" || tab === "upgrades") void checkUpdates();
  }, [tab]);
  useEffect(() => {
    const generation = ++detailGeneration.current;
    setRemoteDetail(null);
    setReleases(null);
    setDetailError("");
    if (!detail) return;
    void Promise.all([
      api<StoreDetail>(
        `/admin/plugins/detail/${encodeURIComponent(detail)}?locale=${locale}`,
      ),
      api<StorePage<StoreRelease>>(
        `/admin/plugins/releases/${encodeURIComponent(detail)}`,
      ),
    ])
      .then(([d, r]) => {
        if (detailGeneration.current === generation) {
          setRemoteDetail(d);
          setReleases(r);
        }
      })
      .catch((e) => {
        if (detailGeneration.current === generation) setDetailError(e.message);
      });
    return () => {
      detailGeneration.current++;
    };
  }, [detail, locale]);
  const act = async (
    run: () => Promise<PluginInventory>,
    confirmation?: string,
    actionKey = "",
  ) => {
    if (acting.current || activeOperation) return;
    if (confirmation && !(await confirmAction(confirmation))) return;
    acting.current = true;
    setActiveAction(actionKey);
    setCompleted(false);
    setOperationError("");
    setElapsed(0);
    setBusy(true);
    setError("");
    try {
      setInventory(await run());
      setCompleted(true);
      setUpdates([]);
      void checkUpdates();
    } catch (e) {
      setOperationError((e as Error).message);
    } finally {
      setBusy(false);
      acting.current = false;
      void loadOperations();
    }
  };
  const installed = inventory?.plugins ?? [];
  const validUpdate = (u: StoreUpdate) => {
    const p = installed.find((p) => p.id === u.id);
    return (
      p &&
      !p.removing &&
      p.version === u.installedVersion &&
      u.status === "update_available" &&
      u.release &&
      u.release.review === "approved" &&
      u.release.dataVersion === p.dataVersion &&
      satisfiesPluginVersion(PLUGIN_SDK_VERSION, u.release.sdkRange) &&
      comparePluginVersions(u.release.version, p.version) > 0
    );
  };
  const available = updates.filter(validUpdate),
    local = installed.find((p) => p.id === detail);
  const compatible = (r: StoreRelease) =>
    r.review === "approved" &&
    satisfiesPluginVersion(PLUGIN_SDK_VERSION, r.sdkRange) &&
    (!local ||
      (!local.removing &&
        local.dataVersion === r.dataVersion &&
        comparePluginVersions(r.version, local.version) > 0));
  const change = (id: string, action: string) =>
    void act(
      () =>
        api<PluginInventory>(
          `/admin/plugins/${encodeURIComponent(id)}`,
          "POST",
          {
            action,
          },
        ),
      action === "remove"
        ? undefined
        : t("plugins.confirmOperation", {
            action: t(`plugins.${action}` as Parameters<typeof t>[0]),
            name: installed.find((p) => p.id === id)?.name ?? id,
          }),
      action,
    );
  const visible =
    tab === "all"
      ? (catalog?.items ?? [])
      : installed
          .filter(
            (p) => tab !== "upgrades" || available.some((u) => u.id === p.id),
          )
          .filter((p) =>
            `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase()),
          );
  const moreVersions = async () => {
    if (!detail || !releases?.page.nextCursor) return;
    const current = detailGeneration.current;
    try {
      const next = await api<StorePage<StoreRelease>>(
        `/admin/plugins/releases/${encodeURIComponent(detail)}?cursor=${encodeURIComponent(releases.page.nextCursor)}`,
      );
      if (current === detailGeneration.current)
        setReleases((old) => ({
          ...next,
          items: [...(old?.items ?? []), ...next.items],
        }));
    } catch (e) {
      setDetailError((e as Error).message);
    }
  };
  const historyName = (id: string) =>
    installed.find((p) => p.id === id)?.name ??
    catalog?.items.find((p) => p.id === id)?.name ??
    (id === "unidentified" ? t("plugins.historyUnidentified") : id);
  const historyGroups = [
    ...operations.reduce((groups, item) => {
      const id = item.pluginId || item.packageName || "unidentified";
      const records = groups.get(id) ?? [];
      records.push(item);
      groups.set(id, records);
      return groups;
    }, new Map<string, typeof operations>()),
  ];
  return (
    <section className="plugin-manager">
      {modalContext}
      {!detail && (
        <>
          <header className="plugin-store-hero">
            <h2>
              <Package size={24} />
              {t("plugins.title")}
            </h2>
            <p>{t("plugins.intro")}</p>
          </header>
          <div className="plugin-manager-tabs">
            {(["all", "installed", "upgrades", "settings"] as const).map(
              (key) => (
                <button
                  key={key}
                  aria-pressed={tab === key}
                  onClick={() => setTab(key)}
                >
                  {t(`plugins.${key}`)}
                  {key === "upgrades" && available.length > 0 && (
                    <span className="plugin-count">{available.length}</span>
                  )}
                </button>
              ),
            )}
          </div>
          {tab !== "settings" && (
            <label className="plugin-hero-search">
              <Search size={22} />
              <input
                aria-label={t("plugins.search")}
                placeholder={t("plugins.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          )}
        </>
      )}
      {inventory?.restartRequired && (
        <div className="plugin-restart">
          <strong>{t("plugins.restart")}</strong>
          <p>{t("plugins.restartHelp")}</p>
          <code>docker compose restart doca</code>
          <p>{t("plugins.restartOther")}</p>
        </div>
      )}
      {(operationLocked || completed || operationError) &&
        createPortal(
          <aside
            className="plugin-progress-toast"
            data-status={
              operationLocked
                ? "running"
                : operationError
                  ? "failed"
                  : "completed"
            }
            role={operationError ? "alert" : "status"}
            aria-live={operationError ? "assertive" : "polite"}
          >
            {operationLocked ? (
              <RefreshCw className="plugin-spinner" size={20} />
            ) : operationError ? (
              <CircleAlert size={20} />
            ) : (
              <CircleCheck size={20} />
            )}
            <div>
              <strong>
                {t(
                  operationLocked
                    ? "plugins.working"
                    : operationError
                      ? "plugins.failed"
                      : "plugins.completed",
                )}
              </strong>
              {(operationLocked || operationError) && (
                <p>
                  {operationLocked
                    ? t("plugins.elapsed", { seconds: elapsed })
                    : operationError}
                </p>
              )}
              <button className="plugin-progress-history" onClick={openHistory}>
                {t("plugins.history")}
              </button>
            </div>
            {!operationLocked && (
              <button
                aria-label={t("plugins.close")}
                onClick={async () => {
                  setCompleted(false);
                  setOperationError("");
                }}
              >
                <X size={16} />
              </button>
            )}
          </aside>,
          document.body,
        )}
      {error && (
        <p role="alert" className="plugin-error">
          {error}
        </p>
      )}
      {!detail &&
        (tab === "settings" ? (
          <div className="plugin-settings">
            <div className="plugin-results-heading">
              <h3>{t("plugins.settings")}</h3>
              <button disabled={operationLocked} onClick={() => void refresh()}>
                <RefreshCw size={16} />
                {t("plugins.refresh")}
              </button>
            </div>
            <section className="plugin-settings-section">
              <h3>{t("plugins.store")}</h3>
              <p>{inventory?.storeUrl}</p>
              <p>{t("plugins.storeSettings")}</p>
            </section>
            <section className="plugin-settings-section">
              <h3>{t("plugins.upload")}</h3>
              <p>{t("plugins.localHelp")}</p>
              <label className="plugin-upload">
                {operationPending("upload") ? (
                  <RefreshCw className="plugin-spinner" size={16} />
                ) : (
                  <Upload size={16} />
                )}
                {t("plugins.upload")}
                <input
                  type="file"
                  accept=".zip"
                  disabled={operationLocked}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    if (file.size > 32 * 1024 * 1024) {
                      setError(t("plugins.uploadLimit"));
                      return;
                    }
                    if (
                      !(await confirmAction(
                        t("plugins.confirmOperation", {
                          action: t("plugins.install"),
                          name: file.name,
                        }),
                      ))
                    )
                      return;
                    void act(
                      async () => {
                        const response = await fetch(
                          "/api/v1/admin/plugins/upload",
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/zip" },
                            body: file,
                          },
                        );
                        const data = await response.json();
                        if (!response.ok) throw new Error(data.message);
                        return data;
                      },
                      undefined,
                      "upload",
                    );
                  }}
                />
              </label>
            </section>
            <section className="plugin-settings-section">
              <h3>{t("plugins.npmInstall")}</h3>
              <p>{t("plugins.unreviewed")}</p>
              <div className="plugin-npm-form">
                <label>
                  <span>{t("plugins.packageName")}</span>
                  <input
                    aria-label={t("plugins.packageName")}
                    placeholder="@scope/plugin"
                    value={npmName}
                    onChange={(e) => setNpmName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t("plugins.version")}</span>
                  <input
                    aria-label={t("plugins.version")}
                    placeholder="1.0.0"
                    value={npmVersion}
                    onChange={(e) => setNpmVersion(e.target.value)}
                  />
                </label>
                <Button
                  loading={operationPending("npm")}
                  disabled={operationLocked || !npmName || !npmVersion}
                  onClick={async () => {
                    if (
                      !(await confirmAction(
                        t("plugins.confirmOperation", {
                          action: t("plugins.install"),
                          name: `${npmName}@${npmVersion}`,
                        }),
                      ))
                    )
                      return;
                    void act(
                      () =>
                        api<PluginInventory>("/admin/plugins/npm", "POST", {
                          name: npmName,
                          version: npmVersion,
                        }),
                      undefined,
                      "npm",
                    );
                  }}
                >
                  {t("plugins.install")}
                </Button>
              </div>
            </section>
          </div>
        ) : (
          <div
            className={`plugin-market-layout ${tab === "all" ? "with-categories" : ""}`}
          >
            {tab === "all" && (
              <div className="plugin-categories">
                <button
                  aria-pressed={!category}
                  onClick={() => setCategory("")}
                >
                  <LayoutGrid size={18} />
                  {t("plugins.all")}
                </button>
                {categoryError && (
                  <small role="alert">{t("plugins.categoriesFailed")}</small>
                )}
                {categories.map((c) => {
                  const Icon = categoryIcons[c.id] ?? Package;
                  return (
                    <button
                      key={c.id}
                      aria-pressed={category === c.id}
                      onClick={() => setCategory(c.id)}
                    >
                      <Icon size={18} />
                      <span>{c.name}</span>
                      {c.count != null && <small>{c.count}</small>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="plugin-store-panel">
              <div className="plugin-results-heading">
                <h3>
                  {category
                    ? categories.find((c) => c.id === category)?.name
                    : t(`plugins.${tab}`)}{" "}
                  {tab === "all" && catalog?.page.total != null && (
                    <span>{catalog.page.total}</span>
                  )}
                </h3>{" "}
                <div className="plugin-results-controls">
                  {tab === "all" && (
                    <>
                      <Select
                        aria-label={t("plugins.sort")}
                        value={sort}
                        onChange={setSort}
                        options={["updated", "downloads", "likes", "name"].map(
                          (value) => ({
                            value,
                            label: t(
                              `plugins.sort.${value}` as Parameters<
                                typeof t
                              >[0],
                            ),
                          }),
                        )}
                      />
                      <Select
                        aria-label={t("plugins.platform")}
                        value={target}
                        onChange={setTarget}
                        options={[
                          { value: "", label: t("plugins.allPlatforms") },
                          { value: "web", label: "Web" },
                          { value: "mobile", label: "App" },
                        ]}
                      />
                    </>
                  )}
                  <button
                    disabled={operationLocked || loading}
                    onClick={async () => {
                      void refresh();
                      void checkUpdates();
                      void loadCatalog();
                    }}
                  >
                    <RefreshCw
                      size={16}
                      className={loading ? "plugin-spinner" : undefined}
                    />
                    {t("plugins.refresh")}
                  </button>
                </div>
              </div>
              {tab === "all" && storeError && (
                <p role="alert" className="plugin-error">
                  {t("plugins.unavailable")} {storeError}
                </p>
              )}
              {tab !== "all" && updatesError && (
                <p role="alert" className="plugin-error">
                  {t("plugins.updateFailed")}
                </p>
              )}
              <p className="plugin-notice">{t("plugins.storeHint")}</p>
              <div className="plugin-grid">
                {visible.map((p) => {
                  const remote = "summary" in p ? (p as StorePlugin) : null,
                    installedItem = installed.find((x) => x.id === p.id);
                  const Icon =
                    categoryIcons[remote?.categoryId ?? ""] ?? Package;
                  return (
                    <article className="plugin-card" key={p.id}>
                      <div className="plugin-card-top">
                        <div className="plugin-icon">
                          {remote?.icon ? (
                            <img src={remote.icon} alt="" />
                          ) : (
                            <Icon size={34} />
                          )}
                        </div>
                        <span className="plugin-version">
                          {remote?.latestVersion || installedItem?.version
                            ? `v${remote?.latestVersion ?? installedItem?.version}`
                            : "—"}
                        </span>
                      </div>
                      <div className="plugin-card-content">
                        <div className="plugin-card-title">
                          <h3>{p.name}</h3>
                          {remote?.official === true && (
                            <span className="plugin-badge plugin-official-badge">
                              {t("plugins.officialBadge")}
                            </span>
                          )}
                          {installedItem && (
                            <span className="plugin-badge">
                              {t(
                                installedItem.pending &&
                                  installedItem.runningVersion &&
                                  installedItem.version !==
                                    installedItem.runningVersion
                                  ? "plugins.pendingUpgrade"
                                  : available.some(
                                        (update) => update.id === p.id,
                                      )
                                    ? "plugins.pendingUpgrade"
                                    : "plugins.installed",
                              )}
                            </span>
                          )}
                          {installedItem?.pending &&
                            !installedItem.runningVersion && (
                              <span className="plugin-badge">
                                {t("plugins.pending")}
                              </span>
                            )}
                          {activeOperation?.pluginId === p.id && (
                            <span className="plugin-badge">
                              {t("plugins.installing")}
                            </span>
                          )}
                        </div>
                        <p className="plugin-description">
                          {remote?.summary ??
                            ("description" in p ? p.description : "")}
                        </p>
                        {remote && (
                          <small className="plugin-author">
                            {remote.author.name}
                          </small>
                        )}
                        <div className="plugin-card-footer">
                          <span className="plugin-category">
                            {remote
                              ? (categories.find(
                                  (c) => c.id === remote.categoryId,
                                )?.name ?? remote.categoryId)
                              : installedItem?.source === "store"
                                ? t("plugins.official")
                                : installedItem?.source === "npm"
                                  ? "npm"
                                  : t("plugins.local")}
                          </span>
                          {remote && (
                            <span className="plugin-stats">
                              <span
                                title={t("plugins.downloads", {
                                  count: remote.downloads.count ?? "—",
                                })}
                              >
                                <Download size={15} />
                                {remote.downloads.count ?? "—"}
                              </span>
                              <span
                                title={t("plugins.likes", {
                                  count: remote.likes.count ?? "—",
                                })}
                              >
                                <Heart size={15} />
                                {remote.likes.count ?? "—"}
                              </span>
                            </span>
                          )}
                          <button
                            className="plugin-card-open"
                            onClick={() => openDetail(p.id)}
                          >
                            {t(
                              available.some((x) => x.id === p.id)
                                ? "plugins.upgrade"
                                : installedItem
                                  ? "plugins.manage"
                                  : "plugins.details",
                            )}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {loading && <p role="status">{t("plugins.loading")}</p>}
              {!loading && !visible.length && (
                <p className="plugin-empty">{t("plugins.noResults")}</p>
              )}
              {tab === "all" && catalog?.page.nextCursor && (
                <button
                  disabled={loading}
                  onClick={() => void loadCatalog(catalog.page.nextCursor!)}
                >
                  {t("plugins.loadMore")}
                </button>
              )}
            </div>
          </div>
        ))}
      {detail && (
        <section className="plugin-detail">
          <button
            className="plugin-detail-back"
            onClick={() => openDetail(null)}
          >
            <ArrowLeft size={18} />
            {t("plugins.title")}
          </button>
          <div className="plugin-info-card">
            <div className="plugin-detail-title">
              <h3>{remoteDetail?.plugin.name ?? local?.name ?? detail}</h3>
              {remoteDetail?.plugin.official === true && (
                <span className="plugin-badge plugin-official-badge">
                  {t("plugins.officialBadge")}
                </span>
              )}
              {activeOperation?.pluginId === detail && (
                <span className="plugin-badge">{t("plugins.installing")}</span>
              )}
            </div>
            {error && <p role="alert">{error}</p>}
            {detailError && <p role="alert">{t("plugins.unavailable")}</p>}
            {remoteDetail && (
              <>
                <p>
                  {remoteDetail.plugin.author.name} ·{" "}
                  {t("plugins.downloads", {
                    count: remoteDetail.plugin.downloads.count ?? "—",
                  })}{" "}
                  ·{" "}
                  {t("plugins.likes", {
                    count: remoteDetail.plugin.likes.count ?? "—",
                  })}
                </p>
                <p>{remoteDetail.plugin.targets.join(" / ")}</p>
                <button
                  onClick={async () => {
                    if (
                      inventory &&
                      (await confirmAction(t("plugins.likeExternal")))
                    )
                      window.open(
                        new URL(
                          remoteDetail.plugin.detailPath,
                          inventory.storeUrl,
                        ).href,
                        "_blank",
                        "noopener,noreferrer",
                      );
                  }}
                >
                  {t("plugins.visitStore")}
                </button>
                <PluginDescription description={remoteDetail.description} />
              </>
            )}
            {local && (
              <>
                <dl>
                  <dt>{t("plugins.version")}</dt>
                  <dd>{local.version}</dd>
                  <dt>{t("plugins.running")}</dt>
                  <dd>{local.runningVersion ?? t("plugins.inactive")}</dd>
                </dl>
                {local.source !== "store" && <p>{t("plugins.unreviewed")}</p>}
                <div className="plugin-actions">
                  {!local.removing && (
                    <>
                      <Button
                        className={
                          local.enabled
                            ? "plugin-disable-button"
                            : "plugin-enable-button"
                        }
                        icon={
                          local.enabled ? (
                            <Power size={16} />
                          ) : (
                            <Play size={16} />
                          )
                        }
                        loading={operationPending(
                          local.enabled ? "disable" : "enable",
                          local.id,
                        )}
                        disabled={operationLocked}
                        onClick={() =>
                          change(local.id, local.enabled ? "disable" : "enable")
                        }
                      >
                        {t(
                          local.enabled ? "plugins.disable" : "plugins.enable",
                        )}
                      </Button>
                      <Button
                        danger
                        className="plugin-remove-button"
                        icon={<Trash2 size={16} />}
                        loading={operationPending("remove", local.id)}
                        disabled={operationLocked}
                        onClick={async () => {
                          if (
                            await confirmAction(
                              t("plugins.removeConfirm", { name: local.name }),
                              true,
                            )
                          )
                            change(local.id, "remove");
                        }}
                      >
                        {t("plugins.remove")}
                      </Button>
                    </>
                  )}
                  {local.canCancel && (
                    <Button
                      loading={operationPending("cancel", local.id)}
                      disabled={operationLocked}
                      onClick={() => change(local.id, "cancel")}
                    >
                      {t("plugins.cancel")}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
          {releases?.items.map((r) => (
            <div className="plugin-release" key={r.version}>
              <strong>{r.version}</strong>
              <div className="plugin-release-notes">
                <h4>{t("plugins.changelog")}</h4>
                <p>{r.changelog?.trim() || t("plugins.noChangelog")}</p>
              </div>
              <small>
                SDK {r.sdkRange} · {t("plugins.dataVersion")}: {r.dataVersion}
              </small>
              <Button
                loading={operationPending("install", detail, r.version)}
                disabled={operationLocked || !compatible(r)}
                onClick={async () => {
                  if (
                    local &&
                    local.source !== "store" &&
                    !(await confirmAction(t("plugins.switchSource")))
                  )
                    return;
                  if (
                    !(await confirmAction(
                      t("plugins.confirmOperation", {
                        action: t(
                          local ? "plugins.upgrade" : "plugins.install",
                        ),
                        name: `${remoteDetail?.plugin.name ?? detail}@${r.version}`,
                      }),
                    ))
                  )
                    return;
                  void act(
                    () =>
                      api<PluginInventory>("/admin/plugins/install", "POST", {
                        id: detail,
                        version: r.version,
                      }),
                    undefined,
                    `release:${r.version}`,
                  );
                }}
              >
                {t(local ? "plugins.upgrade" : "plugins.install")}
              </Button>
              {!compatible(r) && <small>{t("plugins.incompatible")}</small>}
            </div>
          ))}
          {releases?.page.nextCursor && (
            <button onClick={() => void moreVersions()}>
              {t("plugins.loadMore")}
            </button>
          )}
        </section>
      )}
      <button className="plugin-history-entry" onClick={openHistory}>
        {t("plugins.history")}
      </button>
      <Drawer
        title={t("plugins.history")}
        placement="right"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        size={520}
      >
        <div className="plugin-history-toolbar">
          <Select
            aria-label={t("plugins.history")}
            value={historyPlugin}
            onChange={setHistoryPlugin}
            options={[
              { value: "", label: t("plugins.all") },
              ...historyGroups.map(([id]) => ({
                value: id,
                label: historyName(id),
              })),
            ]}
          />
          <button onClick={() => void loadOperations()}>
            <RefreshCw size={16} />
            {t("plugins.refresh")}
          </button>
        </div>
        {historyError && <p role="alert">{t("plugins.historyFailed")}</p>}
        {historyGroups.filter(([id]) => !historyPlugin || id === historyPlugin)
          .length === 0 && <p>{t("plugins.historyEmpty")}</p>}
        {historyGroups
          .filter(([id]) => !historyPlugin || id === historyPlugin)
          .map(([id, records]) => (
            <section className="plugin-history-group" key={id}>
              <h3>{historyName(id)}</h3>
              <ol>
                {records.map((item) => {
                  const { stage, operation } = item;
                  const actionKey =
                    operation === "npm"
                      ? "plugins.npmInstall"
                      : operation === "upload"
                        ? "plugins.upload"
                        : `plugins.${operation}`;
                  return (
                    <li key={item.id}>
                      <time dateTime={item.created_at}>
                        {new Date(item.created_at).toLocaleString(
                          locale === "zh" ? "zh-CN" : "en-US",
                        )}
                      </time>
                      <span>
                        {t(actionKey as Parameters<typeof t>[0])}{" "}
                        {[item.pluginId ?? item.packageName, item.version]
                          .filter(Boolean)
                          .join(" ")}
                      </span>
                      <strong data-status={stage}>
                        {["requested", "staged", "failed"].includes(stage)
                          ? t(`plugins.${stage}` as Parameters<typeof t>[0])
                          : stage}
                      </strong>
                      {stage === "failed" && item.error && (
                        <p className="plugin-history-error">{item.error}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
      </Drawer>
    </section>
  );
}
