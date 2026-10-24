import { Tree, type TreeDataNode } from "antd";
import { Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, roleRank, type Page, type Resource } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import { splitTitleIcon } from "@web/shared/utils/resource-title.js";
import { FileIcon } from "./document-controls.js";

export type MoveDestination = Resource | "__personal__" | null;
export interface DestinationNode extends TreeDataNode {
  resource?: Resource;
  children?: DestinationNode[];
}

/** Keep non-selectable ancestors so a manageable child retains its location. */
export function moveDestinationChildren(
  libraryId: string,
  items: Resource[],
  sourceId: string,
  moving: boolean,
): DestinationNode[] {
  return destinationChildren(libraryId, items, sourceId, moving, 4);
}

/** Creating below a document needs edit permission; moving still needs management. */
export function createDestinationChildren(
  libraryId: string,
  items: Resource[],
): DestinationNode[] {
  return destinationChildren(libraryId, items, null, false, 3);
}

function destinationChildren(
  libraryId: string,
  items: Resource[],
  sourceId: string | null,
  moving: boolean,
  minimumRole: number,
): DestinationNode[] {
  const documents = items.filter(
    (item) =>
      item.kind === "document" &&
      item.library_id === libraryId &&
      !item.deleted_at,
  );
  const available = new Set(documents.map((item) => item.id));
  const children = new Map<string, Resource[]>();
  for (const item of documents) {
    const parent =
      item.parent_id && available.has(item.parent_id)
        ? item.parent_id
        : libraryId;
    const siblings = children.get(parent) ?? [];
    siblings.push(item);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        (a.tree_order ?? 0) - (b.tree_order ?? 0) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
  function nodes(parent: string, insideSource = false): DestinationNode[] {
    return (children.get(parent) ?? []).map((item) => {
      const blocked = item.id === sourceId || (moving && insideSource);
      const nested = nodes(item.id, insideSource || item.id === sourceId);
      return {
        key: item.id,
        title: splitTitleIcon(item.title).text,
        icon: <FileIcon r={item} size="compact" />,
        resource: item,
        disabled: blocked || roleRank(item.role) < minimumRole,
        isLeaf: !nested.length,
        children: nested,
      };
    });
  }
  return nodes(libraryId);
}

export function MoveDestinationTree({
  libraries,
  resource,
  moving,
  value,
  onChange,
  disabled,
}: {
  libraries: Resource[];
  resource: Resource;
  moving: boolean;
  value: MoveDestination;
  onChange: (value: MoveDestination) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [pages, setPages] = useState<Record<string, Page>>({});
  const [error, setError] = useState("");
  const controllers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
    },
    [],
  );

  const treeData = useMemo<DestinationNode[]>(
    () => [
      {
        key: "__personal__",
        title: t("dialog.personalDirectory"),
        icon: <Folder size={17} />,
        disabled: moving && resource.library_id === null,
        isLeaf: true,
      },
      ...libraries
        .filter((library) => library.kind === "library" && !library.deleted_at)
        .map((library) => ({
          key: library.id,
          title: splitTitleIcon(library.title).text,
          icon: <FileIcon r={library} size="compact" />,
          resource: library,
          disabled: roleRank(library.role) < 4,
          isLeaf: pages[library.id]
            ? pages[library.id]!.items.length === 0
            : false,
          children: moveDestinationChildren(
            library.id,
            pages[library.id]?.items ?? [],
            resource.id,
            moving,
          ),
        })),
    ],
    [libraries, pages, resource.id, resource.library_id, moving, t],
  );

  // Switching from copying to moving can invalidate a selected descendant.
  useEffect(() => {
    if (!value) return;
    const key = typeof value === "string" ? value : value.id;
    function find(nodes: DestinationNode[]): DestinationNode | undefined {
      for (const node of nodes) {
        if (node.key === key) return node;
        const found = find(node.children ?? []);
        if (found) return found;
      }
    }
    if (find(treeData)?.disabled) onChange(null);
  }, [treeData, value, onChange]);

  async function loadLibrary(node: DestinationNode) {
    if (pages[String(node.key)] || node.resource?.kind !== "library") return;
    const controller = new AbortController();
    controllers.current.add(controller);
    setError("");
    try {
      const page = await api<Page>(
        `/resources?scope=all&libraryId=${encodeURIComponent(node.resource.id)}&tree=true`,
        "GET",
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted)
        setPages((current) => ({ ...current, [node.resource!.id]: page }));
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : t("dialog.failed"));
      // A rejected load stays retryable when the branch is expanded again.
      throw error;
    } finally {
      controllers.current.delete(controller);
    }
  }

  return (
    <div className="document-move-destination">
      <span>{t("dialog.destination")}</span>
      <div className="document-move-tree">
        <Tree<DestinationNode>
          aria-label={t("dialog.destination")}
          blockNode
          showIcon
          height={260}
          treeData={treeData}
          loadData={loadLibrary}
          selectedKeys={
            value ? [typeof value === "string" ? value : value.id] : []
          }
          disabled={disabled}
          onSelect={(_, { node, selected }) => {
            if (selected) onChange(node.resource ?? "__personal__");
          }}
        />
      </div>
      {error && <Feedback message={error} tone="error" />}
      {Object.values(pages).some((page) => page.truncated) && (
        <Feedback message={t("tree.tooLarge")} tone="warning" />
      )}
    </div>
  );
}
