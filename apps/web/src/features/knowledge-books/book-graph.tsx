import { Graph } from "@antv/x6";
import type { Edge, Node } from "@antv/x6";
import { useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import {
  Maximize2,
  Minimize2,
  Scan,
  Plus,
  Minus,
  Workflow,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTopClose,
  PanelTopOpen,
} from "lucide-react";
import type {
  BookWorkflow,
  BookNodeType,
  ProvenanceNode,
  ProvenanceEdge,
} from "@core/modules/knowledge-books/protocol.js";
import { useI18n } from "@web/shared/i18n.js";
import { fromMarkdown } from "mdast-util-from-markdown";

function plainLabel(markdown: string) {
  const text = (node: { value?: string; children?: unknown[] }): string =>
    node.value ??
    (node.children ?? [])
      .map((child) => text(child as Parameters<typeof text>[0]))
      .join(" ");
  return text(fromMarkdown(markdown)).replace(/\s+/g, " ").trim();
}

const nodeAppearance: Record<
  BookNodeType,
  {
    icon: string;
    color: string;
    fill: string;
    group: "inputs" | "models" | "checks";
  }
> = {
  sources: { icon: "KB", color: "#2563eb", fill: "#eef4ff", group: "inputs" },
  feedback: { icon: "Hi", color: "#08918e", fill: "#e9faf7", group: "inputs" },
  extract: { icon: "AI", color: "#6654d9", fill: "#f2efff", group: "models" },
  synthesize: {
    icon: "AI",
    color: "#6654d9",
    fill: "#f2efff",
    group: "models",
  },
  organize: { icon: "≡", color: "#2563eb", fill: "#eef4ff", group: "models" },
  acceptance: { icon: "✓", color: "#d38718", fill: "#fff7e7", group: "checks" },
  human_review: {
    icon: "Hi",
    color: "#d38718",
    fill: "#fff7e7",
    group: "checks",
  },
  publish: { icon: "↗", color: "#19926a", fill: "#eaf8f1", group: "checks" },
};

/** X6 is also the diagram engine used by the installed slatetsx editor. */
export function BookGraph({
  workflow,
  provenance,
  editable = false,
  changed,
  selected,
  added,
  execution,
}: {
  execution?: { states: Readonly<Record<string, string>>; summaries: Readonly<Record<string, string>>; selectedId?: string };
  workflow?: BookWorkflow;
  provenance?: { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] };
  editable?: boolean;
  changed?: (value: BookWorkflow) => void;
  selected?: (id: string) => void;
  added?: (type: BookNodeType, position: { x: number; y: number }) => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null),
    graph = useRef<Graph | null>(null);
  const callbacks = useRef({ changed, selected, workflow });
  callbacks.current = { changed, selected, workflow };
  const syncing = useRef(false),
    fitted = useRef(false),
    selectedId = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false),
    [zoom, setZoom] = useState(100),
    [paletteVisible, setPaletteVisible] = useState(true),
    [toolbarVisible, setToolbarVisible] = useState(true);
  const isProvenance = !!provenance;
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);
  useEffect(() => {
    if (!host.current) return;
    const canvas: Graph = new Graph({
      container: host.current,
      autoResize: true,
      grid: {
        visible: true,
        size: 16,
        type: "dot",
        args: { color: "#cbd4e1", thickness: 1 },
      },
      virtual: isProvenance,
      panning: true,
      scaling: { min: 0.08, max: 2 },
      mousewheel: { enabled: true, modifiers: ["ctrl", "meta"] },
      interacting: editable ? { edgeLabelMovable: false } : false,
      connecting: {
        allowBlank: false,
        allowLoop: false,
        allowMulti: false,
        allowEdge: false,
        snap: true,
        highlight: true,
        connector: { name: "smooth", args: { direction: "H" } },
        createEdge(): Edge {
          return canvas.createEdge({
            attrs: {
              line: {
                stroke: "#6d97ef",
                strokeWidth: 2,
                targetMarker: "classic",
              },
            },
          });
        },
      },
      background: { color: "#fafcff" },
    });
    graph.current = canvas;
    fitted.current = false;
    const update = () => {
      const current = callbacks.current.workflow;
      if (syncing.current || !editable || !current) return;
      callbacks.current.changed?.({
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          position:
            canvas.getCellById(node.id)?.getBBox().getTopLeft().toJSON() ??
            node.position,
        })),
        edges: canvas.getEdges().map((edge) => ({
          source: edge.getSourceCellId(),
          target: edge.getTargetCellId(),
        })),
      });
    };
    canvas.on("node:moved", update);
    canvas.on("edge:connected", update);
    canvas.on("edge:removed", update);
    canvas.on("scale", ({ sx }) => setZoom(Math.round(sx * 100)));
    canvas.on("node:click", ({ node }) => {
      if (!isProvenance && !execution) {
        const previous = selectedId.current
          ? canvas.getCellById(selectedId.current)
          : null;
        if (previous?.isNode()) previous.attr("body/stroke", "#c4d4ef");
        node.attr("body/stroke", "#5588f5");
        selectedId.current = node.id;
      }
      callbacks.current.selected?.(node.id);
    });
    canvas.on("edge:dblclick", ({ edge }) => {
      if (editable) edge.remove();
    });
    return () => {
      graph.current = null;
      canvas.dispose();
    };
  }, [editable, isProvenance, !!execution]);

  useEffect(() => {
    const canvas = graph.current;
    if (!canvas) return;
    const nodes = workflow?.nodes ?? provenance?.nodes ?? [],
      edges = workflow?.edges ?? provenance?.edges ?? [];
    const layers = new Map(nodes.map((node) => [node.id, 0]));
    for (let i = 0; i < nodes.length; i++) {
      let moved = false;
      for (const edge of edges) {
        const depth = Math.min(12, (layers.get(edge.source) ?? 0) + 1);
        if (depth > (layers.get(edge.target) ?? 0)) {
          layers.set(edge.target, depth);
          moved = true;
        }
      }
      if (!moved) break;
    }
    const rows = new Map<number, number>();
    syncing.current = true;
    try {
      canvas.fromJSON({
        nodes: nodes.map((node): Node.Metadata => {
          const depth = layers.get(node.id) ?? 0,
            row = rows.get(depth) ?? 0;
          rows.set(depth, row + 1);
          const position =
            "position" in node
              ? node.position
              : { x: 30 + depth * 220, y: 30 + row * 85 };
          const rawLabel =
            "type" in node
              ? node.label || t(`books.node.${node.type}`)
              : node.label ||
                (node.kind === "execution"
                  ? t(
                      `books.node.${node.detail.type}` as Parameters<
                        typeof t
                      >[0],
                    )
                  : t(`books.provenance.${node.kind}`));
          const label = plainLabel(rawLabel);
          if (!("type" in node))
            return {
              id: node.id,
              shape: "rect",
              ...position,
              width: 180,
              height: 56,
              label,
              attrs: {
                body: { rx: 9, ry: 9, stroke: "#c4d4ef", fill: "#fff" },
                label: {
                  fill: "#243449",
                  fontSize: 12,
                  textWrap: { width: 160, height: 45, ellipsis: true },
                },
              },
            };
          const state = execution?.states[node.id];
          const stateColor = state === "completed" ? "#19926a" : state === "failed" ? "#d43838" : state === "running" ? "#2563eb" : state === "awaiting_input" || state === "awaiting_publication" ? "#b67c0d" : "#8491a6";
          const style = nodeAppearance[node.type];
          const summary =
            execution?.summaries[node.id] ||
            plainLabel(node.parameters.instructions) ||
            t(`books.nodeHint.${node.type}`);
          const scope = execution ? t(state === "pending" ? "books.pipelinePending" : `books.status.${state}` as Parameters<typeof t>[0]) :
            node.type === "sources"
              ? node.parameters.sourceIds.length
                ? t("books.graphSourceCount", {
                    count: node.parameters.sourceIds.length,
                  })
                : t("books.graphAllSources")
              : node.type === "acceptance"
                ? node.parameters.criterionIds.length
                  ? t("books.graphCriterionCount", {
                      count: node.parameters.criterionIds.length,
                    })
                  : t("books.graphAllCriteria")
                : t(`books.palette.${style.group}`);
          return {
            id: node.id,
            shape: "rect",
            ...position,
            width: 210,
            height: 120,
            markup: [
              "body",
              "iconBody",
              "icon",
              "title",
              "summary",
              "divider",
              "scope",
            ].map((selector) => ({
              tagName:
                selector === "body" || selector === "iconBody"
                  ? "rect"
                  : selector === "divider"
                    ? "path"
                    : "text",
              selector,
            })),
            attrs: {
              body: {
                ...(execution ? { role: "button", tabindex: 0, "aria-label": t("books.pipelineNodeLogs", { node: label, state: scope }) } : {}),
                rx: 12,
                ry: 12,
                stroke: execution?.selectedId === node.id || selectedId.current === node.id ? "#5588f5" : execution ? stateColor : "#c4d4ef",
                strokeWidth: 1.5,
                fill: "#fff",
              },
              iconBody: {
                x: 12,
                y: 12,
                width: 30,
                height: 30,
                rx: 8,
                fill: execution ? `${stateColor}12` : style.fill,
                stroke: "none",
              },
              icon: {
                refX: 0,
                refY: 0,
                x: 27,
                y: 27,
                text: execution ? state === "completed" ? "✓" : state === "failed" ? "!" : state === "running" ? "▶" : state?.startsWith("awaiting") ? "Ⅱ" : "·" : style.icon,
                textAnchor: "middle",
                textVerticalAnchor: "middle",
                fontSize: 12,
                fontWeight: 700,
                fill: execution ? stateColor : style.color,
              },
              title: {
                refX: 0,
                refY: 0,
                x: 51,
                y: 27,
                text: label,
                textAnchor: "start",
                textVerticalAnchor: "middle",
                fontSize: 13,
                fontWeight: 600,
                fill: "#20304a",
                textWrap: { width: 147, height: 20, ellipsis: true },
              },
              summary: {
                refX: 0,
                refY: 0,
                x: 13,
                y: 55,
                text: summary,
                textAnchor: "start",
                textVerticalAnchor: "top",
                fontSize: 11,
                lineHeight: 15,
                fill: "#758198",
                textWrap: { width: 184, height: 31, ellipsis: true },
              },
              divider: { d: "M 13 95 L 197 95", stroke: "#edf0f6" },
              scope: {
                refX: 0,
                refY: 0,
                x: 13,
                y: 108,
                text: scope,
                textAnchor: "start",
                textVerticalAnchor: "middle",
                fontSize: 10,
                fill: execution ? stateColor : style.color,
                textWrap: { width: 184, height: 14, ellipsis: true },
              },
            },
            ports: {
              groups: {
                in: {
                  position: "left",
                  attrs: {
                    circle: {
                      r: 4,
                      magnet: editable ? "passive" : false,
                      stroke: "#6d97ef",
                      strokeWidth: 1.5,
                      fill: "#fff",
                    },
                  },
                },
                out: {
                  position: "right",
                  attrs: {
                    circle: {
                      r: 4,
                      magnet: editable,
                      stroke: "#6d97ef",
                      strokeWidth: 1.5,
                      fill: "#fff",
                    },
                  },
                },
              },
              items: [
                ...(node.type !== "sources" && node.type !== "feedback"
                  ? [{ id: "in", group: "in" }]
                  : []),
                ...(node.type !== "publish"
                  ? [{ id: "out", group: "out" }]
                  : []),
              ],
            },
          };
        }),
        edges: edges.map((edge, index) => ({
          id: `edge-${index}`,
          source: workflow ? { cell: edge.source, port: "out" } : edge.source,
          target: workflow ? { cell: edge.target, port: "in" } : edge.target,
          connector: { name: "rounded" },
          ...(execution ? { router: { name: "manhattan", args: { padding: 16 } } } : { connector: { name: "smooth", args: { direction: "H" } } }),
          attrs: {
            line: {
              stroke: execution ? execution.states[edge.source] === "completed" ? "#73bca3" : "#cbd4e1" : "#6d97ef",
              strokeWidth: workflow ? 2 : 1.5,
              targetMarker: { name: "classic", width: 8, height: 7 },
            },
          },
          zIndex: 0,
        })),
      });
    } finally {
      syncing.current = false;
    }
    // Redrawing edited rules or positions must preserve the reader's current view.
    if (!fitted.current) {
      canvas.zoomToFit({
        padding: 32,
        maxScale: 1,
        minScale: execution ? 0.08 : workflow ? 0.75 : 0.08,
      });
      if (workflow && !execution) {
        const bounds = canvas.getContentBBox();
        const scale = canvas.zoom();
        canvas.translate(24 - bounds.x * scale, 24 - bounds.y * scale);
      }
      fitted.current = true;
    }
  }, [workflow, provenance, editable, t, execution]);

  function add(type: BookNodeType) {
    const rect = host.current?.getBoundingClientRect(),
      canvas = graph.current;
    if (!rect || !canvas) return;
    const center = canvas.clientToLocal(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    added?.(type, { x: center.x - 105, y: center.y - 60 });
  }
  return (
    <section
      className={`book-graph${expanded ? " book-graph-expanded" : ""}${workflow ? " book-workflow-graph" : ""}`}
    >
      {toolbarVisible && (
        <div className="book-graph-toolbar">
          <div className="book-graph-title">
            <Workflow size={16} />
            <strong>
              {t(execution ? "books.pipeline" : workflow ? "books.workflow" : "books.provenance")}
            </strong>
            {workflow && (
              <span>
                {t("books.graphNodeCount", { count: workflow.nodes.length })}
              </span>
            )}
          </div>
          <div className="book-graph-controls">
            {workflow && editable && added && (
              <Tooltip
                title={t(
                  paletteVisible
                    ? "books.hideNodePanel"
                    : "books.showNodePanel",
                )}
              >
                <Button
                  type="text"
                  aria-label={t(
                    paletteVisible
                      ? "books.hideNodePanel"
                      : "books.showNodePanel",
                  )}
                  aria-expanded={paletteVisible}
                  icon={
                    paletteVisible ? (
                      <PanelLeftClose size={16} />
                    ) : (
                      <PanelLeftOpen size={16} />
                    )
                  }
                  onClick={() => setPaletteVisible(!paletteVisible)}
                />
              </Tooltip>
            )}
            <Tooltip title={t("books.fit")}>
              <Button
                type="text"
                aria-label={t("books.fit")}
                icon={<Scan size={16} />}
                onClick={() =>
                  graph.current?.zoomToFit({ padding: 32, maxScale: 1 })
                }
              />
            </Tooltip>
            <Button
              type="text"
              aria-label={t("books.zoomOut")}
              icon={<Minus size={16} />}
              onClick={() => graph.current?.zoom(-0.1)}
            />
            <span className="book-graph-zoom" aria-live="polite">
              {zoom}%
            </span>
            <Button
              type="text"
              aria-label={t("books.zoomIn")}
              icon={<Plus size={16} />}
              onClick={() => graph.current?.zoom(0.1)}
            />
            <Tooltip
              title={t(expanded ? "books.graphCollapse" : "books.graphExpand")}
            >
              <Button
                type="text"
                aria-label={t(
                  expanded ? "books.graphCollapse" : "books.graphExpand",
                )}
                icon={
                  expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />
                }
                onClick={() => setExpanded(!expanded)}
              />
            </Tooltip>
            <Tooltip title={t("books.hideGraphToolbar")}>
              <Button
                type="text"
                aria-label={t("books.hideGraphToolbar")}
                icon={<PanelTopClose size={16} />}
                onClick={() => {
                  setToolbarVisible(false);
                }}
              />
            </Tooltip>
          </div>
        </div>
      )}
      <div className="book-graph-workspace">
        {workflow && editable && added && paletteVisible && toolbarVisible && (
          <aside className="book-node-palette" aria-label={t("books.addNode")}>
            <div className="book-palette-heading">
              {t("books.addNode")}
              <span>{t("books.paletteHelp")}</span>
            </div>
            {(["inputs", "models", "checks"] as const).map((group) => (
              <div className="book-palette-group" key={group}>
                <h4>{t(`books.palette.${group}`)}</h4>
                {(
                  Object.entries(nodeAppearance) as [
                    BookNodeType,
                    (typeof nodeAppearance)[BookNodeType],
                  ][]
                )
                  .filter(([, style]) => style.group === group)
                  .map(([type, style]) => (
                    <button
                      type="button"
                      className="book-palette-node"
                      key={type}
                      disabled={
                        workflow.nodes.length >= 40 ||
                        (type === "publish" &&
                          workflow.nodes.some(
                            (node) => node.type === "publish",
                          ))
                      }
                      aria-label={t("books.addTypedNode", {
                        type: t(`books.node.${type}`),
                      })}
                      onClick={() => add(type)}
                    >
                      <span
                        className="book-palette-icon"
                        style={{ color: style.color, background: style.fill }}
                      >
                        {style.icon}
                      </span>
                      <span>
                        <strong>{t(`books.node.${type}`)}</strong>
                        <small>{t(`books.nodeHint.${type}`)}</small>
                      </span>
                    </button>
                  ))}
              </div>
            ))}
          </aside>
        )}
        <div className="book-graph-stage">
          {!toolbarVisible && (
            <Tooltip title={t("books.showGraphToolbar")}>
              <Button
                className="book-graph-restore"
                aria-label={t("books.showGraphToolbar")}
                icon={<PanelTopOpen size={16} />}
                onClick={() => {
                  setToolbarVisible(true);
                }}
              />
            </Tooltip>
          )}
          <div
            ref={host}
            onKeyDown={event => {
              if (!execution || !["Enter", " "].includes(event.key)) return;
              const id = (event.target as Element).closest("[data-cell-id]")?.getAttribute("data-cell-id");
              if (id && workflow?.nodes.some(node => node.id === id)) { event.preventDefault(); callbacks.current.selected?.(id); }
            }}
            className="book-graph-canvas"
            aria-label={t(execution ? "books.pipeline" : workflow ? "books.workflow" : "books.provenance")}
          />
          <div className="book-graph-hint">
            <MousePointer2 size={13} />
            {t(
              workflow
                ? editable
                  ? "books.graphHelp"
                  : execution ? "books.pipelineGraphHelp" : "books.workflowGraphHelp"
                : "books.provenanceHelp",
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
