import { Tree } from "antd";
import { Folder } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Key,
  type ComponentRef,
} from "react";
import { api, roleRank, type Page, type Resource } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import { splitTitleIcon } from "@web/shared/utils/resource-title.js";
import { FileIcon } from "@web/features/documents/document-controls.js";
import {
  createDestinationChildren,
  type DestinationNode,
} from "@web/features/documents/move-destination-tree.js";

type Location = { libraryId: string | null; parentId: string | null };
export function ClipperDestinationTree({
  value,
  onChange,
  onReadyChange,
  disabled,
}: {
  value: Location;
  onChange: (value: Location) => void;
  onReadyChange: (ready: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [libraries, setLibraries] = useState<Resource[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState<Record<string, Page>>({});
  const [expanded, setExpanded] = useState<Key[]>([]);
  const [failure, setFailure] = useState<{
    message: string;
    library: Resource | null;
  } | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const tree = useRef<ComponentRef<typeof Tree>>(null);
  const pending = useRef(new Map<string, Promise<void>>());
  const loaded = useRef(new Set<string>());
  const selected = value.parentId ?? value.libraryId ?? "__personal__";
  const restoreSelection = useRef<string | null>(selected);

  async function loadLibraries(more = false, signal?: AbortSignal) {
    setLoading(true);
    setFailure(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const params = new URLSearchParams({ scope: "all", kind: "library" });
      if (more && cursor) params.set("cursor", cursor);
      const page = await api<Page>(
        `/resources?${params}`,
        "GET",
        undefined,
        controller.signal,
      );
      const items = page.items.filter((item) => roleRank(item.role) >= 3);
      // Keep a saved selection visible even when it is beyond the first library page.
      if (
        value.libraryId &&
        !more &&
        !page.items.some((item) => item.id === value.libraryId)
      ) {
        const detail = await api<{ resource: Resource }>(
          `/resources/${value.libraryId}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (
          detail.resource.kind === "library" &&
          detail.resource.knowledgeBook === false &&
          !detail.resource.deleted_at &&
          roleRank(detail.resource.role) >= 3
        )
          items.push(detail.resource);
      }
      if (!controller.signal.aborted) {
        setLibraries((previous) => [
          ...new Map(
            [...(more ? previous : []), ...items].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ]);
        setCursor(page.nextCursor ?? null);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure({
          message: error instanceof Error ? error.message : t("dialog.failed"),
          library: null,
        });
    } finally {
      signal?.removeEventListener("abort", abort);
      controllers.current.delete(controller);
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function loadLibrary(library: Resource): Promise<void> {
    if (loaded.current.has(library.id)) return Promise.resolve();
    const running = pending.current.get(library.id);
    if (running) return running;
    const controller = new AbortController();
    controllers.current.add(controller);
    setFailure(null);
    const work = api<Page>(
      `/resources?scope=all&libraryId=${encodeURIComponent(library.id)}&tree=true`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        loaded.current.add(library.id);
        setPages((previous) => ({ ...previous, [library.id]: page }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFailure({
          message: error instanceof Error ? error.message : t("dialog.failed"),
          library,
        });
        // The retry button owns recovery; an expanded Tree must not retry in a loop.
      })
      .finally(() => {
        pending.current.delete(library.id);
        controllers.current.delete(controller);
      });
    pending.current.set(library.id, work);
    return work;
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadLibraries(false, controller.signal);
    return () => {
      controller.abort();
      for (const current of controllers.current) current.abort();
    };
  }, []);

  useEffect(() => {
    const library = libraries.find((item) => item.id === value.libraryId);
    if (library) void loadLibrary(library).catch(() => {});
  }, [value.libraryId, libraries]);

  useEffect(() => {
    if (!value.libraryId) return;
    const ids: Key[] = [value.libraryId];
    const items = new Map(
      (pages[value.libraryId]?.items ?? []).map((item) => [item.id, item]),
    );
    let parent = value.parentId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      ids.push(parent);
      parent = items.get(parent)?.parent_id ?? null;
    }
    setExpanded((previous) =>
      ids.every((id) => previous.includes(id))
        ? previous
        : [...new Set([...previous, ...ids])],
    );
  }, [value.libraryId, value.parentId, pages]);

  const nodes = useMemo<DestinationNode[]>(
    () => [
      {
        key: "__personal__",
        title: t("clipper.personal"),
        icon: <Folder size={17} />,
        isLeaf: true,
      },
      ...libraries.map((library) => ({
        key: library.id,
        title: splitTitleIcon(library.title).text,
        resource: library,
        icon: <FileIcon r={library} size="compact" />,
        isLeaf: pages[library.id]
          ? pages[library.id]!.items.length === 0
          : false,
        children: createDestinationChildren(
          library.id,
          pages[library.id]?.items ?? [],
        ),
      })),
    ],
    [libraries, pages, t],
  );
  function find(items: DestinationNode[]): DestinationNode | undefined {
    for (const node of items) {
      if (node.key === selected) return node;
      const nested = find(node.children ?? []);
      if (nested) return nested;
    }
  }
  const current = find(nodes);
  const ready = !!current && !current.disabled;
  useEffect(() => onReadyChange(ready), [ready, onReadyChange]);
  const selectedPage = value.libraryId ? pages[value.libraryId] : undefined;
  useEffect(() => {
    if (!ready || restoreSelection.current !== selected) return;
    const frame = requestAnimationFrame(() => {
      tree.current?.scrollTo({ key: selected });
      restoreSelection.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, ready, selectedPage]);

  return (
    <div className="document-move-destination clipper-destination">
      <span>{t("clipper.destination")}</span>
      <div className="document-move-tree">
        <Tree<DestinationNode>
          ref={tree}
          aria-label={t("clipper.destination")}
          blockNode
          showIcon
          height={260}
          treeData={nodes}
          selectedKeys={[selected]}
          expandedKeys={expanded}
          onExpand={setExpanded}
          loadData={(node) =>
            node.resource?.kind === "library"
              ? loadLibrary(node.resource)
              : Promise.resolve()
          }
          disabled={disabled}
          onSelect={(_, { node, selected: chosen }) => {
            if (!chosen) return;
            restoreSelection.current = null;
            const item = node.resource;
            onChange({
              libraryId:
                item?.kind === "library" ? item.id : (item?.library_id ?? null),
              parentId: item?.kind === "document" ? item.id : null,
            });
          }}
        />
      </div>
      {loading && (
        <small role="status">{t("clipper.loadingDestinations")}</small>
      )}
      {failure && (
        <>
          <p className="clipper-destination-error" role="alert">
            {failure.message}
          </p>
          <button
            type="button"
            className="soft"
            disabled={disabled || loading}
            onClick={() =>
              void (failure.library
                ? loadLibrary(failure.library).catch(() => {})
                : loadLibraries())
            }
          >
            {t("clipper.retryDestinations")}
          </button>
        </>
      )}
      {!loading &&
        !failure &&
        !ready &&
        value.libraryId &&
        (!libraries.some((item) => item.id === value.libraryId) ||
          pages[value.libraryId]) && (
          <p className="clipper-destination-error" role="alert">
            {t("clipper.unavailable")}
          </p>
        )}
      {cursor && (
        <button
          type="button"
          className="soft"
          disabled={disabled || loading}
          onClick={() => void loadLibraries(true)}
        >
          {t("clipper.moreLibraries")}
        </button>
      )}
      {Object.values(pages).some((page) => page.truncated) && (
        <Feedback message={t("tree.tooLarge")} tone="warning" />
      )}
    </div>
  );
}
