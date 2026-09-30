import { useEffect, useRef, useState } from "react";
import { Package, RefreshCw, Upload, X, Search, Download, Heart, LayoutGrid, Code2, Users, Sparkles, Blocks } from "lucide-react";
import {
  comparePluginVersions,
  satisfiesPluginVersion,
} from "@smartdoca/plugin-contracts";
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
const categoryIcons: Record<string, typeof Package> = {productivity: Sparkles, collaboration: Users, content: Package, integration: Blocks, developer: Code2, other: LayoutGrid};
export function Plugins() {
  const { t, locale } = useI18n();
  const [inventory, setInventory] = useState<PluginInventory | null>(null),
    [catalog, setCatalog] = useState<StoreCatalog | null>(null),
    [categories, setCategories] = useState<{ id: string; name: string; count?: number | null }[]>([]),
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
    [detail, setDetail] = useState<string | null>(null),
    [remoteDetail, setRemoteDetail] = useState<StoreDetail | null>(null),
    [releases, setReleases] = useState<StorePage<StoreRelease> | null>(null),
    [detailError, setDetailError] = useState(""),
    [npmName, setNpmName] = useState(""),
    [npmVersion, setNpmVersion] = useState("");
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
      if (cursor && (e as {status?: number}).status === 410 && generation.current === expectedGeneration) {
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
        if (active) { setCategories(r.items); setCategoryError(false); }
      })
      .catch(() => { if (active) setCategoryError(true); });
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
  const act = async (run: () => Promise<PluginInventory>) => {
    setBusy(true);
    setError("");
    try {
      setInventory(await run());
      setUpdates([]);
      void checkUpdates();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
      satisfiesPluginVersion("0.1.0", u.release.sdkRange) &&
      comparePluginVersions(u.release.version, p.version) > 0
    );
  };
  const available = updates.filter(validUpdate),
    local = installed.find((p) => p.id === detail);
  const compatible = (r: StoreRelease) =>
    r.review === "approved" &&
    satisfiesPluginVersion("0.1.0", r.sdkRange) &&
    (!local ||
      (!local.removing &&
        local.dataVersion === r.dataVersion &&
        comparePluginVersions(r.version, local.version) > 0));
  const change = (id: string, action: string) =>
    void act(() =>
      api<PluginInventory>(`/admin/plugins/${encodeURIComponent(id)}`, "POST", {
        action,
      }),
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
  return (
    <section className="plugin-manager">
      <header className="plugin-store-hero">
        <h2>
          <Package size={24} />
          {t("plugins.title")}
        </h2>
        <p>{t("plugins.intro")}</p>
        {tab !== "settings" && <label className="plugin-hero-search"><Search size={22}/><input aria-label={t("plugins.search")} placeholder={t("plugins.search")} value={query} onChange={(e) => setQuery(e.target.value)}/></label>}
      </header>
      <div className="plugin-manager-tabs">
        {(["all", "installed", "upgrades", "settings"] as const).map((key) => (
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
        ))}
      </div>
      {inventory?.restartRequired && (
        <div className="plugin-restart">
          <strong>{t("plugins.restart")}</strong>
          <p>{t("plugins.restartHelp")}</p>
          <code>docker compose restart doca</code>
          <p>{t("plugins.restartOther")}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="plugin-error">
          {error}
        </p>
      )}
      {tab === "settings" ? (
        <div className="plugin-settings">
          <h3>{t("plugins.store")}</h3>
          <p>{inventory?.storeUrl}</p>
          <p>{t("plugins.storeSettings")}</p>
          <p>{t("plugins.localHelp")}</p>
          <h3>{t("plugins.npmInstall")}</h3>
          <p>{t("plugins.unreviewed")}</p>
          <input
            aria-label={t("plugins.packageName")}
            placeholder="@scope/plugin"
            value={npmName}
            onChange={(e) => setNpmName(e.target.value)}
          />
          <input
            aria-label={t("plugins.version")}
            placeholder="1.0.0"
            value={npmVersion}
            onChange={(e) => setNpmVersion(e.target.value)}
          />
          <button
            disabled={busy || !npmName || !npmVersion}
            onClick={() =>
              void act(() =>
                api<PluginInventory>("/admin/plugins/npm", "POST", {
                  name: npmName,
                  version: npmVersion,
                }),
              )
            }
          >
            {t("plugins.install")}
          </button>
        </div>
      ) : (
        <div className={`plugin-market-layout ${tab === "all" ? "with-categories" : ""}`}>
          {tab === "all" && (
            <div className="plugin-categories">
              <button aria-pressed={!category} onClick={() => setCategory("")}>
                <LayoutGrid size={18}/>{t("plugins.all")}
              </button>
              {categoryError && <small role="alert">{t("plugins.categoriesFailed")}</small>}
              {categories.map((c) => {
                const Icon = categoryIcons[c.id] ?? Package;
                return <button
                  key={c.id}
                  aria-pressed={category === c.id}
                  onClick={() => setCategory(c.id)}
                >
                  <Icon size={18}/><span>{c.name}</span>{c.count != null && <small>{c.count}</small>}
                </button>;
              })}
            </div>
          )}
          <div className="plugin-store-panel">
            <div className="plugin-results-heading"><h3>{category ? categories.find(c => c.id === category)?.name : t(`plugins.${tab}`)} {tab === "all" && catalog?.page.total != null && <span>{catalog.page.total}</span>}</h3></div>
            <div className="plugin-toolbar">
              <button
                disabled={busy || loading}
                onClick={() => {
                  void refresh();
                  void checkUpdates();
                  void loadCatalog();
                }}
              >
                <RefreshCw size={16} />
                {t("plugins.refresh")}
              </button>
              <label className="plugin-upload">
                <Upload size={16} />
                {t("plugins.upload")}
                <input
                  type="file"
                  accept=".zip"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    if (file.size > 32 * 1024 * 1024) {
                      setError(t("plugins.uploadLimit"));
                      return;
                    }
                    void act(async () => {
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
                    });
                  }}
                />
              </label>
              <div className="plugin-filters">
                {tab === "all" && (
                  <>
                    <select
                      aria-label={t("plugins.sort")}
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      {["updated", "downloads", "likes", "name"].map((s) => (
                        <option key={s} value={s}>
                          {t(`plugins.sort.${s}` as Parameters<typeof t>[0])}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t("plugins.platform")}
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      <option value="">{t("plugins.allPlatforms")}</option>
                      <option value="web">Web</option>
                      <option value="mobile">App</option>
                    </select>
                  </>
                )}

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
                const Icon = categoryIcons[remote?.categoryId ?? ""] ?? Package;
                return (
                  <article className="plugin-card" key={p.id}>
                    <div className="plugin-card-top"><div className="plugin-icon">
                      {remote?.icon ? (
                        <img src={remote.icon} alt="" />
                      ) : (
                        <Icon size={34} />
                      )}
                    </div>
                    <span className="plugin-version">{remote?.latestVersion || installedItem?.version ? `v${remote?.latestVersion ?? installedItem?.version}` : "—"}</span></div>
                    <div className="plugin-card-content">
                      <div className="plugin-card-title">
                        <h3>{p.name}</h3>
                        {installedItem && (
                          <span className="plugin-badge">
                            {t(
                              installedItem.pending
                                ? "plugins.pending"
                                : "plugins.installed",
                            )}
                          </span>
                        )}
                      </div>
                      <p className="plugin-description">
                        {remote?.summary ??
                          ("description" in p ? p.description : "")}
                      </p>
                      {remote && <small className="plugin-author">{remote.author.name}</small>}
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
                        {remote && <span className="plugin-stats"><span title={t("plugins.downloads", {count: remote.downloads.count ?? "—"})}><Download size={15}/>{remote.downloads.count ?? "—"}</span><span title={t("plugins.likes", {count: remote.likes.count ?? "—"})}><Heart size={15}/>{remote.likes.count ?? "—"}</span></span>}
                        <button className="plugin-card-open" onClick={() => setDetail(p.id)}>
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
      )}
      {detail && (
        <dialog
          className="plugin-detail"
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onCancel={() => setDetail(null)}
        >
          <button
            className="plugin-detail-close"
            aria-label={t("plugins.close")}
            onClick={() => setDetail(null)}
          >
            <X size={18} />
          </button>
          <h3>{remoteDetail?.plugin.name ?? local?.name ?? detail}</h3>
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
                onClick={() => {
                  if (inventory && confirm(t("plugins.likeExternal")))
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
                    <button
                      disabled={busy}
                      onClick={() =>
                        change(local.id, local.enabled ? "disable" : "enable")
                      }
                    >
                      {t(local.enabled ? "plugins.disable" : "plugins.enable")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            t("plugins.removeConfirm", { name: local.name }),
                          )
                        )
                          change(local.id, "remove");
                      }}
                    >
                      {t("plugins.remove")}
                    </button>
                  </>
                )}
                {local.pending && (
                  <button
                    disabled={busy}
                    onClick={() => change(local.id, "cancel")}
                  >
                    {t("plugins.cancel")}
                  </button>
                )}
              </div>
            </>
          )}
          {releases?.items.map((r) => (
            <div className="plugin-release" key={r.version}>
              <strong>{r.version}</strong>
              <small>
                SDK {r.sdkRange} · {t("plugins.dataVersion")}: {r.dataVersion}
              </small>
              <button
                disabled={busy || !compatible(r)}
                onClick={() => {
                  if (
                    local &&
                    local.source !== "store" &&
                    !confirm(t("plugins.switchSource"))
                  )
                    return;
                  void act(() =>
                    api<PluginInventory>("/admin/plugins/install", "POST", {
                      id: detail,
                      version: r.version,
                    }),
                  );
                }}
              >
                {t(local ? "plugins.upgrade" : "plugins.install")}
              </button>
              {!compatible(r) && <small>{t("plugins.incompatible")}</small>}
            </div>
          ))}
          {releases?.page.nextCursor && (
            <button onClick={() => void moreVersions()}>
              {t("plugins.loadMore")}
            </button>
          )}
        </dialog>
      )}
    </section>
  );
}
