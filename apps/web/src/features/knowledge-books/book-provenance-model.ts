import type {
  ProvenanceNode,
  ProvenanceEdge,
} from "@core/modules/knowledge-books/protocol.js";

export type ProvenanceGraph = {
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
};

/** Display-only aggregation. Original nodes/edges remain available for inspection. */
export function aggregateBookProvenance(
  graph: ProvenanceGraph,
  label: (kind: ProvenanceNode["kind"], count: number) => string,
) {
  const groups = new Map<string, ProvenanceNode[]>();
  const ids = new Map<string, string>();
  for (const node of graph.nodes) {
    const key =
      node.kind === "evidence"
        ? `aggregate:evidence:${node.detail.sourceId}`
        : node.kind === "claim"
          ? "aggregate:claim"
          : node.id;
    ids.set(node.id, key);
    const members = groups.get(key) ?? [];
    members.push(node);
    groups.set(key, members);
  }
  const members = new Map<string, ProvenanceNode[]>();
  const nodes = [...groups.entries()].map(([id, items]): ProvenanceNode => {
    if (!id.startsWith("aggregate:")) return items[0]!;
    members.set(id, items);
    return {
      id,
      kind: items[0]!.kind,
      label: label(items[0]!.kind, items.length),
      detail: { count: items.length },
    };
  });
  const edges = new Map<string, ProvenanceEdge & { count: number }>();
  for (const edge of graph.edges) {
    const source = ids.get(edge.source),
      target = ids.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = JSON.stringify([source, target, edge.relation]);
    const current = edges.get(key);
    if (current) current.count++;
    else edges.set(key, { source, target, relation: edge.relation, count: 1 });
  }
  return { nodes, edges: [...edges.values()], members };
}
