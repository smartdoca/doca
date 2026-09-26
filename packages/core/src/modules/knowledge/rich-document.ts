import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { Schema } from "@db/index.js";
import { b64 } from "../collaboration/documents.js";
import { validateRichNode } from "../ai/edit-schema.js";
import { DocaYjsDocument } from "../documents/codecs/rich-runtime.js";
import { indexDocumentReferences } from "../documents/references.js";

export type KnowledgeFigure = {
  type: "flowchart" | "mindmap";
  nodes: { id: string; label: string; shape?: string }[];
  edges: { source: string; target: string }[];
};

const shapes = new Set(
  "process decision terminator database document data subprocess".split(" "),
);

/** Turns a knowledge entry into editor blocks. Invalid figures are left out. */
export function knowledgeDocumentChildren(
  markdown: string,
  figures: KnowledgeFigure[] = [],
) {
  const children: Record<string, unknown>[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("```")) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      children.push({
        id: randomUUID(),
        type: "paragraph",
        title: level === 1 ? "h1" : level === 2 ? "h2" : "h3",
        children: [{ text: heading[2] }],
      });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    children.push({
      id: randomUUID(),
      type: "paragraph",
      children: [{ text: bullet ? `• ${bullet[1]}` : line }],
    });
  }
  if (!children.length)
    children.push({
      id: randomUUID(),
      type: "paragraph",
      children: [{ text: "" }],
    });
  for (const figure of figures) {
    const block = figureBlock(figure);
    if (block) children.push(block);
  }
  const seen = new Set<string>();
  const accepted: Record<string, unknown>[] = [];
  for (const node of children) {
    try {
      validateRichNode(node, seen);
      accepted.push(node);
    } catch {
      /* a bad figure must not block the rest of the page */
    }
  }
  return accepted.length ? accepted : children.slice(0, 1);
}

function figureBlock(figure: KnowledgeFigure) {
  const nodes = (figure.nodes ?? []).filter(
    (node) => node && node.id && node.label,
  );
  if (nodes.length < 2) return null;
  if (figure.type === "mindmap") {
    const [root, ...rest] = nodes;
    return {
      id: randomUUID(),
      type: "mindmap",
      width: 680,
      children: [{ text: "" }],
      mindData: {
        nodeData: {
          id: root!.id,
          topic: root!.label,
          children: rest.map((node) => ({ id: node.id, topic: node.label })),
        },
        direction: 1,
      },
    };
  }
  if (figure.type !== "flowchart") return null;
  const laid = nodes.map((node, index) => ({
    id: node.id,
    label: node.label,
    shape:
      node.shape && shapes.has(node.shape)
        ? node.shape
        : index === 0 || index === nodes.length - 1
          ? "terminator"
          : "process",
    x: 40 + (index % 3) * 220,
    y: 40 + Math.floor(index / 3) * 140,
    width: 160,
    height: 56,
  }));
  const ids = new Set(laid.map((node) => node.id));
  const edges = (figure.edges ?? [])
    .filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        edge.source !== edge.target,
    )
    .map((edge, index) => ({
      id: `e${index + 1}`,
      source: edge.source,
      target: edge.target,
      arrow: "end" as const,
      lineType: "smoothstep" as const,
    }));
  return {
    id: randomUUID(),
    type: "flowchart",
    width: 680,
    children: [{ text: "" }],
    nodes: laid,
    edges,
  };
}

export function knowledgePlainText(children: Record<string, unknown>[]) {
  const lines: string[] = [];
  const walk = (node: {
    topic?: string;
    children?: { topic?: string; children?: never[] }[];
  }) => {
    if (node.topic) lines.push(node.topic);
    node.children?.forEach(walk);
  };
  for (const block of children) {
    const leaves = block.children as { text?: string }[] | undefined;
    for (const leaf of leaves ?? []) if (leaf.text) lines.push(leaf.text);
    const nodes = block.nodes as { label?: string }[] | undefined;
    for (const node of nodes ?? []) if (node.label) lines.push(node.label);
    const mind = block.mindData as
      | { nodeData?: { topic?: string; children?: [] } }
      | undefined;
    if (mind?.nodeData) walk(mind.nodeData);
  }
  return lines.join("\n");
}

export async function writeKnowledgeRichDocument(
  tx: Transaction<Schema>,
  id: string,
  markdown: string,
  figures: KnowledgeFigure[] = [],
) {
  const children = knowledgeDocumentChildren(markdown, figures);
  const text = knowledgePlainText(children);
  const now = new Date().toISOString();
  const doc = new Y.Doc();
  const runtime = new DocaYjsDocument(doc);
  try {
    runtime.initialize(children);
    await tx
      .deleteFrom("document_updates")
      .where("resource_id", "=", id)
      .execute();
    await tx
      .deleteFrom("markdown_receipts")
      .where("resource_id", "=", id)
      .execute();
    await tx
      .deleteFrom("markdown_epochs")
      .where("resource_id", "=", id)
      .execute();
    await tx
      .deleteFrom("editor_receipts")
      .where("resource_id", "=", id)
      .execute();
    await tx.deleteFrom("editor_epochs").where("resource_id", "=", id).execute();
    await tx
      .deleteFrom("document_states")
      .where("resource_id", "=", id)
      .execute();
    await tx
      .insertInto("document_states")
      .values({
        resource_id: id,
        codec: "slate-kit",
        checkpoint: b64(Y.encodeStateAsUpdate(doc)),
        checkpoint_seq: 0,
        seq: 0,
        text,
        updated_at: now,
      })
      .execute();
    await tx
      .updateTable("resources")
      .set({
        format: "rich_text",
        content_bytes: Buffer.byteLength(text),
        updated_at: now,
      })
      .where("id", "=", id)
      .execute();
    await indexDocumentReferences(tx, id, runtime.getValue(), 0);
  } finally {
    doc.destroy();
  }
}
