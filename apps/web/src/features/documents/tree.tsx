import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { TreeDocumentMenu } from "@web/features/documents/tree-document-menu.js";
import { ResourceActionDialog } from "@web/features/documents/uploads.js";
import { FileIcon } from "@web/features/documents/document-controls.js";
import { api, roleRank, type Page, type Resource } from "@web/shared/api.js";
import { treePlacement, type TreePlacement } from "@web/features/documents/tree-order.js";

export function DocumentTree({
  refresh,
  userId,
  selected,
  create,
  libraryId,
  knowledgeEnabled,
  changed,
}: {
  refresh: number;
  userId: string;
  libraryId?: string;
  knowledgeEnabled?: boolean;
  selected?: string;
  create: (parent: Resource) => void;
  changed?: () => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Resource[]>([]),
    [truncated, setTruncated] = useState(false),
    [menu, setMenu] = useState<{ resource: Resource; trigger: HTMLElement } | null>(null),
    [trash, setTrash] = useState<Resource | null>(null),
    [localRefresh, setLocalRefresh] = useState(0),
    [dragged, setDragged] = useState<Resource | null>(null),
    [drop, setDrop] = useState<{
      id: string;
      placement: TreePlacement;
      left: number;
      top: number;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState<Set<string>>(() => {
      try {
        return new Set(
          JSON.parse(
            sessionStorage.getItem(
              `doca-tree:${userId}:${libraryId ?? "personal"}`,
            ) ?? "[]",
          ),
        );
      } catch {
        return new Set();
      }
    }),
    [error, setError] = useState("");
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `doca-tree:${userId}:${libraryId ?? "personal"}`,
        JSON.stringify([...expanded]),
      );
    } catch {}
  }, [expanded, userId, libraryId]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const all: Resource[] = [];
      let wasTruncated = false;
      let cursor: string | undefined;
      do {
        const p: Page = await api<Page>(
          `/resources?scope=${libraryId ? "all" : "mine"}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${libraryId ? "&libraryId=" + libraryId + "&tree=true" : ""}`,
          "GET",
          undefined,
          controller.signal,
        );
        all.push(...p.items);
        wasTruncated ||= !!p.truncated;
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      if (!controller.signal.aborted) {
        setItems(all);
        setTruncated(wasTruncated);
        setError("");
      }
    })().catch((e) => {
      if (e.name !== "AbortError") setError(e.message);
    });
    return () => controller.abort();
  }, [refresh, localRefresh, userId, libraryId]);
  useEffect(() => {
    setItems([]);
    setTruncated(false);
    setDragged(null);
    setDrop(null);
  }, [libraryId, userId]);
  useEffect(() => {
    if (!selected) return;
    setExpanded((old) => {
      const next = new Set(old),
        seen = new Set<string>();
      let r = items.find((x) => x.id === selected);
      next.add(selected);
      while (r && !seen.has(r.id)) {
        seen.add(r.id);
        const parent = r.parent_id ?? r.library_id;
        if (!parent) break;
        next.add(parent);
        r = items.find((x) => x.id === parent);
      }
      return next;
    });
  }, [selected, items]);
  const available = new Set(items.map((r) => r.id));
  const parentId = (r: Resource) =>
    available.has(r.parent_id ?? "")
      ? r.parent_id
      : available.has(r.library_id ?? "")
        ? r.library_id
        : null;
  const children = new Map<string | null, Resource[]>();
  for (const r of items) {
    const p = parentId(r);
    children.set(p, [...(children.get(p) ?? []), r]);
  }
  for (const list of children.values())
    list.sort(
      (a, b) =>
        (a.tree_order ?? 0) - (b.tree_order ?? 0) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
  function node(r: Resource, depth = 0): React.ReactNode {
    const nested = children.get(r.id) ?? [],
      open = expanded.has(r.id);
    return (
      <div key={r.id}>
        <div
          className={`tree-row ${r.id === selected ? "selected" : ""} ${roleRank(r.role) === 0 ? "inaccessible" : ""} ${drop?.id === r.id ? "drop-" + drop.placement : ""} ${dragged?.id === r.id ? "dragging" : ""}`}
          data-resource-id={r.id}
          draggable={!busy && r.kind === "document" && roleRank(r.role) >= 4}
          onDragStart={(e) => {
            if ((e.target as HTMLElement).closest(".tree-more,.hover-add")) { e.preventDefault(); return; }
            setMenu(null);
            setDragged(r);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-doca-resource", r.id);
            const ghost = document.createElement("div");
            ghost.className = "tree-drag-preview";
            ghost.textContent = r.title;
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, -18, -12);
            setTimeout(() => ghost.remove(), 0);
          }}
          onDragEnd={() => {
            setDragged(null);
            setDrop(null);
          }}
          onDragOver={(e) => {
            if (!dragged || dragged.id === r.id || r.kind !== "document")
              return;
            let ancestor: Resource | undefined = r;
            const seen = new Set<string>();
            while (ancestor && !seen.has(ancestor.id)) {
              if (ancestor.id === dragged.id) return;
              seen.add(ancestor.id);
              ancestor = items.find((x) => x.id === ancestor?.parent_id);
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const placement = treePlacement(e.clientY, rect.top, rect.height);
            if (placement === "inside" && roleRank(r.role) < 3) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDrop({
              id: r.id,
              placement,
              left: Math.min(rect.right + 12, window.innerWidth - 252),
              top: Math.max(8, Math.min(rect.top, window.innerHeight - 70)),
            });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setDrop(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!dragged || !drop || drop.id !== r.id || busy) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const source = dragged,
              destination = {
                id: drop.id,
                placement: treePlacement(e.clientY, rect.top, rect.height),
              };
            setDragged(null);
            setDrop(null);
            setBusy(true);
            setError("");
            void api(`/resources/${source.id}/arrange`, "POST", {
              version: source.version,
              targetId: destination.id,
              placement: destination.placement,
            })
              .then(() => {
                if (destination.placement === "inside")
                  setExpanded((old) => new Set([...old, r.id]));
                setLocalRefresh((n) => n + 1);
              })
              .catch((e) => {
                setError(e.message);
                setLocalRefresh((n) => n + 1);
              })
              .finally(() => setBusy(false));
          }}
          style={{ paddingLeft: 2 + Math.min(depth, 6) * 18 }}
        >
          {drop?.id === r.id &&
            createPortal(
              <span
                className="tree-drop-hint"
                style={{ left: drop.left, top: drop.top }}
              >
                {drop.placement === "inside"
                  ? `放入此文档末尾 · ${dragged?.access_mode === "inherit" ? "跟随新父级权限" : "保留独立权限"}`
                  : drop.placement === "after"
                    ? "放在此文档后面"
                    : "放在此文档前面"}
              </span>,
              document.body,
            )}
          {nested.length ? (
            <button
              className="tree-toggle icon"
              aria-label={open ? "折叠" + r.title : "展开" + r.title}
              aria-expanded={open}
              onClick={() =>
                setExpanded((old) => {
                  const next = new Set(old);
                  if (open) next.delete(r.id);
                  else next.add(r.id);
                  return next;
                })
              }
            >
              <ChevronRight
                size={13}
                style={{ transform: open ? "rotate(90deg)" : undefined }}
              />
            </button>
          ) : (
            <span className="tree-spacer" />
          )}
          <button
            className="tree-link"
            title={r.title}
            aria-disabled={roleRank(r.role) === 0}
            aria-current={r.id === selected ? "page" : undefined}
            onClick={() => {
              if (roleRank(r.role) === 0) return;
              setExpanded((old) => new Set([...old, r.id]));
              location.hash = "/r/" + r.id;
            }}
          >
            <FileIcon r={r} size="compact" />
            <span>{r.title}</span>
          </button>
          {roleRank(r.role) >= 3 && (
            <button
              className="hover-add icon"
              aria-label={"在" + r.title + "中创建"}
              onClick={() => create(r)}
            >
              <Plus size={14} />
            </button>
          )}
          {r.kind === "document" && (
            <button
              className="tree-more icon"
              aria-label={r.title + "的更多操作"}
              aria-haspopup="menu"
              aria-expanded={menu?.resource.id === r.id}
              onClick={(e) => setMenu(menu?.resource.id === r.id ? null : { resource: r, trigger: e.currentTarget })}
            ><MoreHorizontal size={15} /></button>
          )}
        </div>
        {open && nested.map((c) => node(c, depth + 1))}
      </div>
    );
  }
  const roots = children.get(null) ?? [];
  return (
    <div className="document-tree">
      {menu && <TreeDocumentMenu key={menu.resource.id} {...menu} close={() => setMenu(null)} changed={() => { setLocalRefresh(n => n + 1); changed?.(); }} remove={() => setTrash(menu.resource)} />}
      {trash && <ResourceActionDialog resource={trash} action="trash" close={() => setTrash(null)} saved={() => { setLocalRefresh(n => n + 1); changed?.(); if (selected === trash.id) location.hash = "/home"; }} />}
      {error && <Feedback message={error} tone="error" />}
      {truncated && (
        <Feedback message={t("tree.tooLarge")} tone="warning" />
      )}
      {roots.map((r) => node(r))}
      {!items.length && !error && !knowledgeEnabled && (
        <p className="subtle">暂无目录，创建第一篇文档吧</p>
      )}
    </div>
  );
}
