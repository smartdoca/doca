import { z } from "zod";

export const bookNodeTypes = [
  "sources",
  "feedback",
  "extract",
  "synthesize",
  "organize",
  "acceptance",
  "human_review",
  "publish",
] as const;
export type BookNodeType = (typeof bookNodeTypes)[number];
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
export const bookNodeSchema = z
  .object({
    id: identifier,
    type: z.enum(bookNodeTypes),
    label: z.string().max(100),
    position: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict(),
    parameters: z
      .object({
        instructions: z.string().max(40000),
        sourceIds: z.array(z.string().uuid()).max(500),
        criterionIds: z.array(identifier).max(100),
        sourceWeight: z.number().min(0).max(100),
        feedbackWeight: z.number().min(0).max(100),
      })
      .strict(),
  })
  .strict();
const allowedInputs: Record<BookNodeType, readonly BookNodeType[]> = {
  sources: [],
  feedback: [],
  extract: ["sources", "feedback", "human_review"],
  synthesize: ["extract", "feedback", "human_review"],
  organize: ["synthesize", "human_review"],
  acceptance: ["synthesize", "organize", "human_review"],
  human_review: [
    "sources",
    "feedback",
    "extract",
    "synthesize",
    "organize",
    "acceptance",
  ],
  publish: ["acceptance", "human_review"],
};
export const bookWorkflowSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(bookNodeSchema).min(6).max(40),
    edges: z
      .array(z.object({ source: identifier, target: identifier }).strict())
      .min(5)
      .max(100),
  })
  .strict()
  .superRefine((graph, context) => {
    const error = (message: string) =>
      context.addIssue({ code: "custom", message });
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    if (nodes.size !== graph.nodes.length) error("Duplicate workflow node IDs");
    const unique = new Set<string>();
    const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
    for (const edge of graph.edges) {
      const from = nodes.get(edge.source),
        to = nodes.get(edge.target);
      const key = `${edge.source}:${edge.target}`;
      if (!from || !to || from === to || unique.has(key)) {
        error("Invalid or duplicate workflow edge");
        continue;
      }
      unique.add(key);
      if (!allowedInputs[to.type].includes(from.type))
        error("Workflow node input type mismatch");
      incoming.set(to.id, incoming.get(to.id)! + 1);
    }
    for (const node of graph.nodes) {
      if (allowedInputs[node.type].length && !incoming.get(node.id))
        error("Workflow node is missing input");
    }
    const order = graph.nodes
      .filter((node) => !incoming.get(node.id))
      .map((node) => node.id);
    for (let i = 0; i < order.length; i++)
      for (const edge of graph.edges) {
        if (edge.source !== order[i]) continue;
        incoming.set(edge.target, incoming.get(edge.target)! - 1);
        if (incoming.get(edge.target) === 0) order.push(edge.target);
      }
    if (order.length !== nodes.size) error("Workflow contains a cycle");
    const publishers = graph.nodes.filter((node) => node.type === "publish");
    if (publishers.length !== 1)
      error("Workflow requires exactly one publish node");
    const used = new Set(publishers.map((node) => node.id));
    for (let i = 0; i < graph.nodes.length; i++)
      for (const edge of graph.edges) {
        if (used.has(edge.target)) used.add(edge.source);
      }
    if (used.size !== nodes.size)
      error("Every workflow node must contribute to publication");
    if (!graph.nodes.some((node) => node.type === "sources"))
      error("Workflow requires a source node");
  });
export type BookWorkflow = z.infer<typeof bookWorkflowSchema>;

export const bookCriterionSchema = z
  .object({
    id: identifier,
    description: z.string().trim().min(1).max(4000),
    required: z.boolean(),
  })
  .strict();
export const bookConfigurationSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().max(40000),
    modelId: z.string().max(100),
    workflow: bookWorkflowSchema,
    criteria: z.array(bookCriterionSchema).max(100),
    maxDocumentDepth: z.number().int().min(1).max(8),
    schedule: z.enum(["off", "daily", "weekly"]),
    autoPublish: z.boolean(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (
      new Set(configuration.criteria.map((c) => c.id)).size !==
      configuration.criteria.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate acceptance criterion IDs",
      });
  });
export type BookConfiguration = z.infer<typeof bookConfigurationSchema>;
export function defaultBookConfiguration(): BookConfiguration {
  const types: BookNodeType[] = [
    "sources",
    "feedback",
    "extract",
    "synthesize",
    "organize",
    "acceptance",
    "publish",
  ];
  return {
    version: 1,
    goal: "",
    modelId: "",
    maxDocumentDepth: 4,
    schedule: "off",
    autoPublish: false,
    criteria: [
      {
        id: "grounded",
        description:
          "Every factual paragraph is supported by supplied evidence, with applicable conditions and uncertainty preserved.",
        required: true,
      },
    ],
    workflow: {
      version: 1,
      nodes: types.map((type, index) => ({
        id: type,
        type,
        label: "",
        position: { x: 70 + index * 280, y: type === "feedback" ? 230 : 70 },
        parameters: {
          instructions: "",
          sourceIds: [],
          criterionIds: [],
          sourceWeight: 1,
          feedbackWeight: 1,
        },
      })),
      edges: [
        { source: "sources", target: "extract" },
        { source: "feedback", target: "extract" },
        { source: "extract", target: "synthesize" },
        { source: "synthesize", target: "organize" },
        { source: "organize", target: "acceptance" },
        { source: "acceptance", target: "publish" },
      ],
    },
  };
}
export const bookSourceBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: identifier,
      kind: z.literal("document"),
      resourceId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("library"),
      resourceId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("file"),
      resourceId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("folder"),
      resourceId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("url"),
      url: z.string().url().max(4000),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("manual"),
      markdown: z
        .string()
        .min(1)
        .max(60000)
        .refine((value) => !!value.trim()),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("content"),
      sourceId: z.string().min(1).max(200),
      config: z.record(z.string(), z.json()),
    })
    .strict(),
]);
export type BookSourceBinding = z.infer<typeof bookSourceBindingSchema>;
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type BookSourceReference = WithoutId<BookSourceBinding>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
/** IDs stay stable on edits; duplicate scopes are detected independently of IDs. */
export function bookSourceBindingKey(binding: BookSourceBinding) {
  const { id: _id, ...scope } = binding;
  if (scope.kind === "url") scope.url = new URL(scope.url).href;
  return JSON.stringify(canonical(scope));
}
export const bookSourceInputSchema = z
  .object({
    version: z.literal(1),
    items: z.array(bookSourceBindingSchema).min(1).max(50),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = new Set<string>(),
      scopes = new Set<string>();
    input.items.forEach((binding, index) => {
      const key = bookSourceBindingKey(binding);
      if (ids.has(binding.id) || scopes.has(key))
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Duplicate source binding ID or scope",
        });
      ids.add(binding.id);
      scopes.add(key);
    });
  });
export type BookSourceInput = z.infer<typeof bookSourceInputSchema>;
export const bookFeedbackInputSchema = z
  .object({
    kind: z.enum(["comment", "correction", "supplement", "question"]),
    content: z.string().trim().min(1).max(20000),
    releaseId: z.string().uuid().nullable(),
    pageId: identifier.nullable(),
    paragraphId: identifier.nullable(),
  })
  .strict();
export type BookFeedbackInput = z.infer<typeof bookFeedbackInputSchema>;

export type Evidence = {
  id: string;
  sourceId: string;
  sourceRevision: number;
  sourceVersion: string;
  title: string;
  text: string;
  contentHash: string;
  reference:
    | Exclude<BookSourceReference, { kind: "manual" } | { kind: "content" }>
    | { kind: "manual" }
    | { kind: "content"; sourceId: string }
    | { kind: "feedback"; feedbackId: string; revision: number };
  blockId: string;
  contentRef?: { sourceId: string; resourceId: string; blockId: string };
};
export const claimOutputSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            id: identifier,
            statement: z.string().min(1).max(12000),
            evidenceIds: z.array(z.string().min(1)).min(1).max(100),
            evidenceQuotes: z
              .array(
                z
                  .object({
                    evidenceId: z.string().min(1),
                    quote: z.string().min(1).max(800),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
            reason: z.string().min(1).max(4000),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type BookClaim = z.infer<typeof claimOutputSchema>["claims"][number];
export const pageOutputSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: identifier,
            title: z.string().trim().min(1).max(200),
            path: z.array(z.string().trim().min(1).max(100)).max(7),
            paragraphs: z
              .array(
                z
                  .object({
                    id: identifier,
                    markdown: z.string().trim().min(1).max(12000),
                    claimIds: z.array(identifier).min(1).max(100),
                    reason: z.string().min(1).max(4000),
                  })
                  .strict(),
              )
              .min(1)
              .max(200),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type BookPage = z.infer<typeof pageOutputSchema>["pages"][number];
export const acceptanceOutputSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            criterionId: identifier,
            passed: z.boolean(),
            reason: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type BookCheck = z.infer<
  typeof acceptanceOutputSchema
>["checks"][number];
export type ProvenanceNode = {
  id: string;
  kind:
    | "source"
    | "evidence"
    | "claim"
    | "decision"
    | "paragraph"
    | "page"
    | "release"
    | "execution";
  label: string;
  detail: Record<string, unknown>;
};
export type ProvenanceEdge = {
  source: string;
  target: string;
  relation: "used" | "supported" | "adopted" | "composed" | "generated";
};
export type BookArtifact = {
  version: 1;
  evidence: Evidence[];
  claims: BookClaim[];
  pages: BookPage[];
  checks: BookCheck[];
  provenance: { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] };
};
