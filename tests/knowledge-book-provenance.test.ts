import { expect, it } from "vitest";
import { aggregateBookProvenance } from "../apps/web/src/features/knowledge-books/book-provenance-model.js";
import type {
  ProvenanceNode,
  ProvenanceEdge,
} from "@core/modules/knowledge-books/protocol.js";
it("bundles repeated relations without losing source records or their connection count", () => {
  const nodes: ProvenanceNode[] = [
    { id: "source", kind: "source", label: "RFC", detail: {} },
    { id: "paragraph", kind: "paragraph", label: "Mechanism", detail: {} },
  ];
  const edges: ProvenanceEdge[] = [];
  for (let index = 0; index < 600; index++) {
    nodes.push(
      {
        id: `e${index}`,
        kind: "evidence",
        label: `Passage ${index}`,
        detail: { sourceId: "source" },
      },
      { id: `c${index}`, kind: "claim", label: `Fact ${index}`, detail: {} },
    );
    edges.push(
      { source: "source", target: `e${index}`, relation: "used" },
      { source: `e${index}`, target: `c${index}`, relation: "supported" },
      { source: `c${index}`, target: "paragraph", relation: "adopted" },
    );
  }
  const snapshot = JSON.stringify({ nodes, edges });
  const result = aggregateBookProvenance(
    { nodes, edges },
    (kind, count) => `${kind} ${count}`,
  );
  expect(result.nodes).toHaveLength(4);
  expect(result.edges).toHaveLength(3);
  expect(result.edges.every((edge) => edge.count === 600)).toBe(true);
  expect(result.members.get("aggregate:claim")).toHaveLength(600);
  expect(result.members.get("aggregate:evidence:source")).toHaveLength(600);
  expect(JSON.stringify({ nodes, edges })).toBe(snapshot);
});
