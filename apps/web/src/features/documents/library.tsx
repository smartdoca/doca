import { useEntitlements } from "@web/shared/hooks/entitlement-access.js";
import { htmlLang } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState } from "react";
import {
  ImagePlus,
  Pencil,
  Trash2,
  ArrowRightLeft,
  FilePlus2,
} from "lucide-react";
import { api, roleRank, type Detail, type Page, type Resource } from "@web/shared/api.js";
import { PermissionDialog, TransferDialog } from "@web/features/documents/dialogs.js";
import { CoverDialog, ResourceActionDialog } from "@web/features/documents/uploads.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import "./library-system.css";
export { LibraryQaPage, LibrarySystemPage } from "./library-relations.js";
export const librarySettingsUrl = (id: string) => `#/r/${id}?view=settings`;
export const librarySystemUrl = (id: string) => `#/r/${id}?view=system`;
export const libraryQaUrl = (id: string) => `#/r/${id}?view=qa`;
export function LibraryLanding({
  resource,
  create,
}: {
  resource: Resource;
  create: () => void;
}) {
  const allowed = useEntitlements();
  const { locale } = useI18n();
  const [empty, setEmpty] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      const all: Resource[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: Page = await api<Page>(
          `/resources?scope=all&kind=document&libraryId=${resource.id}&offset=${offset}`,
          "GET",
          undefined,
          c.signal,
        );
        all.push(...page.items);
        offset = page.nextOffset;
      }
      const ids = new Set(all.map((r) => r.id));
      const first = all
        .filter((r) => !r.parent_id || !ids.has(r.parent_id))
        .sort(
          (a, b) =>
            a.title.localeCompare(b.title, htmlLang(locale)) || a.id.localeCompare(b.id),
        )[0];
      if (c.signal.aborted) return;
      if (first) location.replace(`#/r/${first.id}`);
      else setEmpty(true);
    })().catch((e) => {
      if (e.name !== "AbortError") setError(e.message);
    });
    return () => c.abort();
  }, [resource.id]);
  return (
    <div className="empty">
      {error ? (
        <Feedback tone="error" message={error} />
      ) : empty ? (
        <>
          <FilePlus2 size={38} />
          <h2>知识库还没有文档</h2>
          {roleRank(resource.role) >= 3 && (
            <button
              className="primary"
              hidden={!allowed("documents.create")}
              onClick={create}
            >
              创建第一篇文档
            </button>
          )}
        </>
      ) : (
        "正在打开第一篇文档…"
      )}
    </div>
  );
}
export function LibrarySettings({
  detail,
  changed,
}: {
  detail: Detail;
  changed: () => Promise<void>;
}) {
  const [action, setAction] = useState<
    "cover" | "rename" | "trash" | "transfer" | null
  >(null);
  const r = detail.resource,
    manager = roleRank(r.role) >= 4;
  const close = () => setAction(null);
  return (
    <section className="library-settings-page">
      <section className="settings-card">
        <h3>基本信息</h3>
        <div className="library-setting-actions">
          <button disabled={!manager} onClick={() => setAction("cover")}>
            <ImagePlus size={18} />
            设置封面
          </button>
          <button disabled={!manager} onClick={() => setAction("rename")}>
            <Pencil size={18} />
            重命名
          </button>
          <button
            disabled={r.role !== "owner"}
            onClick={() => setAction("transfer")}
          >
            <ArrowRightLeft size={18} />
            移交所有权
          </button>
          <button
            disabled={r.role !== "owner"}
            className="danger"
            onClick={() => setAction("trash")}
          >
            <Trash2 size={18} />
            删除知识库
          </button>
        </div>
      </section>
      <PermissionDialog
        key={r.id}
        embedded
        detail={detail}
        close={() => {}}
        saved={changed}
      />
      {action === "cover" && (
        <CoverDialog resource={r} close={close} saved={() => void changed()} />
      )}
      {(action === "rename" || action === "trash") && (
        <ResourceActionDialog
          resource={r}
          action={action}
          close={close}
          saved={() => {
            if (action === "trash") location.hash = "/libraries";
            void changed();
          }}
        />
      )}
      {action === "transfer" && (
        <TransferDialog resource={r} close={close} saved={changed} />
      )}
    </section>
  );
}
