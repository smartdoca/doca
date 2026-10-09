import { readRetryOrigin, readNodeReuse } from "./retry.js";
import { readFeedbackOrigin } from "./feedback-origin.js";
import { appendBookRunLog, type BookRunReporter } from "./run-logs.js";
import { randomUUID } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { bookFail as fail } from "./errors.js";
import { AppError, systemErrorText } from "../../shared/errors.js";
import {
  bookAccess,
  bookInputSnapshot,
  bookNow,
  bookHash,
} from "./management.js";
import {
  canReadBookFeedback,
  readBookSource,
  validateBookSource,
  validateBookEvidence,
  type BookSourceRuntime,
} from "./sources.js";
import {
  bookConfigurationSchema,
  claimOutputSchema,
  pageOutputSchema,
  acceptanceOutputSchema,
  bookFeedbackInputSchema,
  type BookArtifact,
  type BookClaim,
  type BookPage,
  type Evidence,
  type BookConfiguration,
  type BookCheck,
  type ProvenanceNode,
  type ProvenanceEdge,
} from "./protocol.js";

export interface BookRuntime extends BookSourceRuntime {
  generate(
    stage: "extract" | "synthesize" | "organize" | "acceptance",
    input: Record<string, unknown>,
    signal: AbortSignal,
    report?: BookRunReporter,
  ): Promise<unknown>;
}
type NodeOutput = {
  evidence: Evidence[];
  claims: BookClaim[];
  pages: BookPage[];
  checks: BookCheck[];
};
const unique = <T extends { id: string }>(items: T[]) => [
  ...new Map(items.map((item) => [item.id, item])).values(),
];
export function checkClaims(claims: BookClaim[], evidence: Evidence[]) {
  const known = new Set(evidence.map((item) => item.id));
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length)
    fail(502, "Model returned duplicate claim IDs");
  for (const claim of claims)
    if (claim.evidenceIds.some((id) => !known.has(id)))
      fail(502, `Claim ${claim.id} cited unknown evidence`);
  for (const claim of claims) {
    if (
      claim.evidenceIds.some(
        (id) => !claim.evidenceQuotes.some((quote) => quote.evidenceId === id),
      )
    )
      fail(502, "Every cited evidence requires a verified excerpt");
    for (const quote of claim.evidenceQuotes) {
      if (
        !claim.evidenceIds.includes(quote.evidenceId) ||
        !evidence
          .find((item) => item.id === quote.evidenceId)
          ?.text.includes(quote.quote)
      )
        fail(
          502,
          `Claim ${claim.id}: quotation for ${quote.evidenceId} is absent from that evidence. Copy an exact contiguous excerpt.`,
        );
    }
  }
}
function compactOutput(output: NodeOutput): NodeOutput {
  return {
    ...output,
    evidence: output.evidence.map((evidence) => ({
      ...evidence,
      text: [
        ...new Set(
          output.claims.flatMap((claim) =>
            claim.evidenceQuotes
              .filter((quote) => quote.evidenceId === evidence.id)
              .map((quote) => quote.quote),
          ),
        ),
      ].join("\n\n"),
    })),
  };
}
export function checkPages(
  pages: BookPage[],
  claims: BookClaim[],
  depth: number,
) {
  const known = new Set(claims.map((claim) => claim.id)),
    paragraphIds = new Set<string>(),
    paths = new Set<string>();
  if (new Set(pages.map((page) => page.id)).size !== pages.length)
    fail(502, "Model returned duplicate page IDs");
  for (const page of pages) {
    if (
      page.path.length + 1 > depth ||
      [...page.path, page.title].some(
        (part) => /[\u0000-\u001f]/.test(part) || [".", ".."].includes(part),
      )
    )
      fail(502, "Invalid generated document path");
    const path = JSON.stringify([...page.path, page.title]);
    if (paths.has(path)) fail(502, "Generated document paths collide");
    paths.add(path);
    for (const paragraph of page.paragraphs) {
      if (paragraphIds.has(paragraph.id))
        fail(502, "Generated paragraph IDs must be unique across the release");
      paragraphIds.add(paragraph.id);
      if (paragraph.claimIds.some((id) => !known.has(id)))
        fail(502, "Paragraph cited unknown claims");
    }
  }
}
export function createBookProvenance(
  runId: string,
  configuration: BookConfiguration,
  output: NodeOutput,
  executions: ReadonlyMap<string, NodeOutput> = new Map(),
  reused: ReadonlyMap<string, string> = new Map(),
): BookArtifact["provenance"] {
  const nodes: ProvenanceNode[] = [],
    edges: ProvenanceEdge[] = [];
  const add = (
    id: string,
    kind: ProvenanceNode["kind"],
    label: string,
    detail: Record<string, unknown>,
  ) => {
    nodes.push({ id, kind, label, detail });
    return id;
  };
  const link = (
    source: string,
    target: string,
    relation: ProvenanceEdge["relation"],
  ) => edges.push({ source, target, relation });
  const release = add(`release:${runId}`, "release", "", { runId });
  const sourceNodes = new Set<string>();
  for (const evidence of output.evidence) {
    const source = `source:${evidence.sourceId}:${evidence.sourceRevision}:${bookHash([evidence.sourceVersion, evidence.reference, evidence.contentRef])}`;
    if (!sourceNodes.has(source)) {
      add(source, "source", evidence.title, {
        sourceId: evidence.sourceId,
        revision: evidence.sourceRevision,
        version: evidence.sourceVersion,
        reference: evidence.reference,
        ...(evidence.contentRef ? { contentRef: evidence.contentRef } : {}),
      });
      sourceNodes.add(source);
    }
    add(evidence.id, "evidence", evidence.text || evidence.title, {
      sourceId: evidence.sourceId,
      blockId: evidence.blockId,
      text: evidence.text,
      cited: !!evidence.text,
      contentHash: evidence.contentHash,
    });
    link(source, evidence.id, "used");
  }
  for (const claim of output.claims) {
    add(`claim:${claim.id}`, "claim", claim.statement, {
      reason: claim.reason,
      confidence: claim.confidence,
    });
    for (const id of claim.evidenceIds)
      link(id, `claim:${claim.id}`, "supported");
  }
  const selected = new Set<string>();
  for (const page of output.pages) {
    const pageId = add(`page:${page.id}`, "page", page.title, {
      pageId: page.id,
      path: page.path,
    });
    link(pageId, release, "composed");
    for (const paragraph of page.paragraphs) {
      const decision = add(
        `decision:${paragraph.id}`,
        "decision",
        paragraph.reason,
        {
          claimIds: paragraph.claimIds,
          workflowVersion: configuration.workflow.version,
          parameters: configuration.workflow.nodes
            .filter(
              (n) =>
                ["synthesize", "organize"].includes(n.type) &&
                executions
                  .get(n.id)
                  ?.pages.some((p) =>
                    p.paragraphs.some((q) => q.id === paragraph.id),
                  ),
            )
            .map((n) => ({ id: n.id, parameters: n.parameters })),
        },
      );
      const paragraphId = add(
        `paragraph:${paragraph.id}`,
        "paragraph",
        paragraph.markdown,
        { pageId: page.id },
      );
      for (const id of paragraph.claimIds) {
        selected.add(id);
        link(`claim:${id}`, decision, "adopted");
      }
      link(decision, paragraphId, "generated");
      link(paragraphId, pageId, "composed");
    }
  }
  for (const claim of output.claims)
    if (!selected.has(claim.id)) {
      const id = add(`unselected:${claim.id}`, "decision", "", {
        status: "not_selected_for_release",
        claimId: claim.id,
      });
      link(`claim:${claim.id}`, id, "used");
    }
  for (const node of configuration.workflow.nodes)
    add(`execution:${runId}:${node.id}`, "execution", node.label, {
      nodeId: node.id,
      type: node.type,
      parameters: node.parameters,
    });
  for (const [nodeId, priorRunId] of reused) {
    const priorId = `execution:${priorRunId}:${nodeId}`;
    add(priorId, "execution", "", {
      nodeId,
      runId: priorRunId,
      type: configuration.workflow.nodes.find((node) => node.id === nodeId)!
        .type,
      reuseOrigin: true,
    });
    const execution = nodes.find(
      (node) => node.id === `execution:${runId}:${nodeId}`,
    )!;
    execution.detail.reusedFromRunId = priorRunId;
    link(priorId, execution.id, "used");
  }
  for (const edge of configuration.workflow.edges)
    link(
      `execution:${runId}:${edge.source}`,
      `execution:${runId}:${edge.target}`,
      "used",
    );
  const known = new Set(nodes.map((node) => node.id));
  for (const definition of configuration.workflow.nodes) {
    const trace = executions.get(definition.id);
    if (!trace) continue;
    const execution = `execution:${runId}:${definition.id}`;
    for (const evidence of trace.evidence)
      if (known.has(evidence.id)) link(evidence.id, execution, "used");
    if (definition.type === "extract")
      for (const claim of trace.claims)
        if (known.has(`claim:${claim.id}`))
          link(execution, `claim:${claim.id}`, "generated");
    if (definition.type === "organize" || definition.type === "synthesize")
      for (const page of trace.pages)
        for (const paragraph of page.paragraphs) {
          if (known.has(`paragraph:${paragraph.id}`))
            link(execution, `paragraph:${paragraph.id}`, "generated");
        }
  }
  const publisher = configuration.workflow.nodes.find(
    (node) => node.type === "publish",
  )!;
  link(`execution:${runId}:${publisher.id}`, release, "generated");
  return { nodes, edges };
}
async function actorFor(db: DB, run: Schema["knowledge_book_runs"]) {
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", run.actor_id)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) fail(403, "Run actor is unavailable");
  return actor;
}
async function assertCurrent(
  db: DB,
  run: Schema["knowledge_book_runs"],
  lease: string,
) {
  const current = await db
    .selectFrom("knowledge_book_runs")
    .select(["status", "lease_id"])
    .where("id", "=", run.id)
    .executeTakeFirst();
  if (current?.status !== "running" || current.lease_id !== lease)
    fail(409, "Run was cancelled or its lease changed");
  const actor = await actorFor(db, run),
    { book } = await bookAccess(db, actor, run.book_id, 3);
  if (
    book.revision !== run.configuration_revision ||
    book.configuration !== run.configuration
  )
    fail(409, "Workflow configuration changed; run again");
  if ((await bookInputSnapshot(db, run.book_id)).hash !== run.input_hash)
    fail(409, "Sources or feedback changed; run again");
  return { actor, book };
}
async function publishRun(
  db: DB,
  run: Schema["knowledge_book_runs"],
  lease: string,
  artifact: BookArtifact,
  runtime: BookRuntime,
) {
  await assertCurrent(db, run, lease);
  await validateBookEvidence(db, run.book_id, artifact.evidence, runtime);
  return transact(db, async (tx) => {
    const { actor, book } = await assertCurrent(tx, run, lease);
    const last = await tx
      .selectFrom("knowledge_book_releases")
      .select("revision")
      .where("book_id", "=", run.book_id)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    const id = randomUUID(),
      revision = (last?.revision ?? 0) + 1,
      now = bookNow();
    const updated = await tx
      .updateTable("knowledge_books")
      .set({ published_release_id: id, updated_at: now })
      .where("id", "=", run.book_id)
      .where("revision", "=", run.configuration_revision)
      .where(
        "published_release_id",
        book.published_release_id === null ? "is" : "=",
        book.published_release_id,
      )
      .executeTakeFirst();
    if (!Number(updated.numUpdatedRows))
      fail(409, "Another run published a release; run again");
    await tx
      .insertInto("knowledge_book_releases")
      .values({
        id,
        book_id: run.book_id,
        run_id: run.id,
        revision,
        artifact: JSON.stringify(artifact),
        created_at: now,
      })
      .execute();
    await tx
      .updateTable("knowledge_book_runs")
      .set({
        status: "published",
        artifact: JSON.stringify(artifact),
        lease_id: null,
        updated_at: now,
      })
      .where("id", "=", run.id)
      .where("status", "=", "running")
      .where("lease_id", "=", lease)
      .execute();
    await tx
      .insertInto("audit_events")
      .values({
        id: randomUUID(),
        actor_id: actor.id,
        resource_id: run.book_id,
        action: "knowledge_book.published",
        created_at: now,
      })
      .execute();
    await appendBookRunLog(tx, run, null, { code: "run_published", value: artifact.pages.length });
    return { id, revision };
  });
}
/** The only writer of book releases. Every published artifact comes from validated node outputs. */
export async function executeBookRun(db: DB, id: string, runtime: BookRuntime) {
  const storedRun = await db
    .selectFrom("knowledge_book_runs")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (
    !storedRun ||
    !["queued", "queued_publish", "queued_resume"].includes(storedRun.status)
  )
    return;
  let run: Schema["knowledge_book_runs"] = storedRun;
  const resumeNodes = run.status === "queued_resume";
  const resumePublication = run.status === "queued_publish",
    lease = randomUUID(),
    now = bookNow();
  const claimed = await db
    .updateTable("knowledge_book_runs")
    .set({
      status: "running",
      lease_id: lease,
      started_at: run.started_at ?? now,
      heartbeat_at: now,
      updated_at: now,
    })
    .where("id", "=", id)
    .where("status", "=", run.status)
    .executeTakeFirst();
  if (!Number(claimed.numUpdatedRows)) return;
  run = { ...run, status: "running", lease_id: lease };
  const coordinator = new AbortController();
  const signal = AbortSignal.any([
    coordinator.signal,
    AbortSignal.timeout(120 * 60_000),
  ]);
  const heartbeat = setInterval(() => {
    void db
      .updateTable("knowledge_book_runs")
      .set({ heartbeat_at: bookNow() })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where("lease_id", "=", lease)
      .executeTakeFirst()
      .then((result) => {
        if (!Number(result.numUpdatedRows))
          coordinator.abort(
            new Error("Run was cancelled or its lease changed"),
          );
      })
      .catch((error) => coordinator.abort(error));
  }, 15000);
  heartbeat.unref();
  let activeNode: string | undefined;
  try {
    await appendBookRunLog(db, run, null, { code: "run_started" });
    const configuration = bookConfigurationSchema.parse(
      JSON.parse(run.configuration),
    );
    await assertCurrent(db, run, lease);
    if (resumePublication) {
      if (!run.artifact) fail(409, "Run has no completed artifact");
      const publisher = configuration.workflow.nodes.find(
        (node) => node.type === "publish",
      )!;
      activeNode = publisher.id;
      const artifact = JSON.parse(run.artifact) as BookArtifact;
      const task = await db
        .selectFrom("knowledge_book_human_tasks")
        .select(["id", "resolution"])
        .where("run_id", "=", id)
        .where("kind", "=", "publication")
        .where("status", "=", "resolved")
        .executeTakeFirst();
      if (task?.resolution) {
        const resolution = JSON.parse(task.resolution);
        artifact.provenance.nodes.push({
          id: `human:${task.id}`,
          kind: "decision",
          label: resolution.note,
          detail: resolution,
        });
        artifact.provenance.edges.push(
          {
            source: `execution:${id}:${publisher.id}`,
            target: `human:${task.id}`,
            relation: "used",
          },
          {
            source: `human:${task.id}`,
            target: `release:${id}`,
            relation: "adopted",
          },
        );
      }
      await publishRun(db, run, lease, artifact, runtime);
      await db
        .updateTable("knowledge_book_node_runs")
        .set({ status: "completed", completed_at: bookNow() })
        .where("run_id", "=", id)
        .where("node_id", "=", publisher.id)
        .execute();
      return;
    }
    const priorRunId = await readRetryOrigin(db, id);
    const rejectedReviews = priorRunId
      ? await db
          .selectFrom("knowledge_book_node_runs")
          .select(["node_id", "output"])
          .where("run_id", "=", priorRunId)
          .where("type", "=", "acceptance")
          .where("status", "=", "failed")
          .execute()
      : [];
    const snapshot = await bookInputSnapshot(db, run.book_id),
      outputs = new Map<string, NodeOutput>(),
      pending = new Set(configuration.workflow.nodes.map((node) => node.id));
    const sourceCache = new Map<string, Promise<Evidence[]>>();
    if (resumeNodes)
      for (const node of await db
        .selectFrom("knowledge_book_node_runs")
        .selectAll()
        .where("run_id", "=", id)
        .where("status", "=", "completed")
        .execute()) {
        outputs.set(node.node_id, JSON.parse(node.output));
        pending.delete(node.node_id);
      }
    async function feedbackText(row: Schema["knowledge_book_feedback"]) {
      const detail = bookFeedbackInputSchema.parse(JSON.parse(row.detail));
      const origin = await readFeedbackOrigin(db, row.id, row.revision);

      const contributor = await db
        .selectFrom("users")
        .select(["id", "display_name", "admin"])
        .where("id", "=", row.author_id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!contributor) fail(403, "Feedback contributor is unavailable");
      await bookAccess(db, contributor, run!.book_id, 2);
      if (!detail.releaseId) return JSON.stringify({ ...detail, origin });
      if (!(await canReadBookFeedback(db, contributor, detail)))
        fail(403, "Anchored feedback lost original evidence access");
      const prior = await db
        .selectFrom("knowledge_book_releases")
        .select("artifact")
        .where("id", "=", detail.releaseId)
        .where("book_id", "=", run!.book_id)
        .executeTakeFirstOrThrow();
      const artifact = JSON.parse(prior.artifact) as BookArtifact,
        page = artifact.pages.find((page) => page.id === detail.pageId);
      const paragraphs = detail.paragraphId
        ? page?.paragraphs.filter((p) => p.id === detail.paragraphId)
        : page?.paragraphs;
      return JSON.stringify({
        ...detail,
        origin,
        target: page
          ? { title: page.title, path: page.path, paragraphs }
          : null,
      });
    }
    async function hydrate(items: Evidence[]) {
      const result: Evidence[] = [];
      const checkedSources = new Set<string>();
      for (const item of items) {
        if (item.reference.kind === "feedback") {
          const feedback = snapshot.feedback.find(
            (row) =>
              row.id === item.sourceId && row.revision === item.sourceRevision,
          );
          if (!feedback) fail(409, "Feedback changed during the run");
          result.push({
            ...item,
            text: await feedbackText(feedback),
          });
        } else {
          const source = snapshot.sources.find(
            (source) =>
              source.id === item.sourceId &&
              source.revision === item.sourceRevision,
          );
          if (!source) fail(409, "Source changed during the run");
          if (!checkedSources.has(source.id)) {
            const contributor = await db
              .selectFrom("users")
              .select(["id", "display_name", "admin"])
              .where("id", "=", source.creator_id)
              .where("status", "=", "active")
              .executeTakeFirst();
            if (!contributor) fail(403, "Source contributor is unavailable");
            await bookAccess(db, contributor, run.book_id, 3);
            await validateBookSource(
              db,
              contributor,
              JSON.parse(source.configuration),
            );
            checkedSources.add(source.id);
          }
          if (!sourceCache.has(source.id))
            sourceCache.set(source.id, readBookSource(db, source, runtime));
          const live = (await sourceCache.get(source.id)!).find(
            (evidence) => evidence.id === item.id,
          );
          if (!live || live.contentHash !== item.contentHash)
            fail(409, "Source content changed during the run");
          result.push(live);
        }
      }
      return result;
    }
    async function executeNode(
      node: BookConfiguration["workflow"]["nodes"][number],
    ) {
      const nodeIndex = configuration.workflow.nodes.indexOf(node);
      const report: BookRunReporter = async event => {
        signal.throwIfAborted();
        await assertCurrent(db, run, lease);
        await appendBookRunLog(db, run, nodeIndex, event);
      };
      try {
        await assertCurrent(db, run, lease);
        const upstream = configuration.workflow.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => outputs.get(edge.source)!);
        const input: NodeOutput = {
          evidence: unique(upstream.flatMap((out) => out.evidence)),
          claims: unique(upstream.flatMap((out) => out.claims)),
          pages: unique(upstream.flatMap((out) => out.pages)),
          checks: upstream.flatMap((out) => out.checks),
        };
        const output: NodeOutput = structuredClone(input);
        await db
          .insertInto("knowledge_book_node_runs")
          .values({
            run_id: id,
            node_id: node.id,
            type: node.type,
            status: "running",
            input_refs: JSON.stringify(
              configuration.workflow.edges
                .filter((edge) => edge.target === node.id)
                .map((edge) => edge.source),
            ),
            output: "",
            error: "",
            started_at: bookNow(),
            completed_at: null,
          })
          .execute();
        await report({ code: "node_started" });
        if (node.type === "sources") {
          const selected = node.parameters.sourceIds.length
            ? snapshot.sources.filter((source) =>
                node.parameters.sourceIds.includes(source.id),
              )
            : snapshot.sources;
          if (
            node.parameters.sourceIds.some(
              (sourceId) => !selected.some((source) => source.id === sourceId),
            )
          )
            fail(409, "Workflow selects a missing or inactive source");
          output.evidence = [];
          for (const source of selected) {
            const ordinal = selected.indexOf(source) + 1;
            await report({ code: "source_loading", value: ordinal, total: selected.length });
            if (!sourceCache.has(source.id))
              sourceCache.set(source.id, readBookSource(db, source, runtime));
            const evidence = await sourceCache.get(source.id)!;
            output.evidence.push(...evidence);
            await report({ code: "source_loaded", value: evidence.length, total: ordinal });
          }
        } else if (node.type === "feedback") {
          output.evidence = [];
          for (const row of snapshot.feedback) {
            const detail = bookFeedbackInputSchema.parse(
                JSON.parse(row.detail),
              ),
              text = await feedbackText(row);
            output.evidence.push({
              id: `feedback_${row.id}_${row.revision}`,
              sourceId: row.id,
              sourceRevision: row.revision,
              sourceVersion: String(row.revision),
              title: detail.kind,
              text,
              contentHash: bookHash(text),
              reference: {
                kind: "feedback",
                feedbackId: row.id,
                revision: row.revision,
              },
              blockId: row.id,
            });
          }
        } else if (node.type === "human_review") {
          await db
            .insertInto("knowledge_book_human_tasks")
            .values({
              id: randomUUID(),
              book_id: run.book_id,
              run_id: id,
              node_id: node.id,
              kind: "review",
              title: node.label || "",
              status: "pending",
              revision: 1,
              input_hash: run.input_hash,
              resolution: "",
              created_at: bookNow(),
              updated_at: bookNow(),
            })
            .execute();
          await db
            .updateTable("knowledge_book_node_runs")
            .set({
              status: "awaiting_input",
              output: JSON.stringify(compactOutput(output)),
              completed_at: bookNow(),
            })
            .where("run_id", "=", id)
            .where("node_id", "=", node.id)
            .execute();
          await db
            .updateTable("knowledge_book_runs")
            .set({
              status: "awaiting_input",
              lease_id: null,
              updated_at: bookNow(),
            })
            .where("id", "=", id)
            .where("status", "=", "running")
            .where("lease_id", "=", lease)
            .execute();
          await appendBookRunLog(db, run, nodeIndex, { code: "waiting_input" });
          return;
        } else if (node.type === "publish") {
          if (!output.pages.length)
            fail(422, "Publication requires generated knowledge pages");
          checkPages(
            output.pages,
            output.claims,
            configuration.maxDocumentDepth,
          );
          if (
            configuration.criteria.some(
              (criterion) =>
                !output.checks.some(
                  (check) => check.criterionId === criterion.id,
                ) ||
                (criterion.required &&
                  output.checks.some(
                    (check) =>
                      check.criterionId === criterion.id && !check.passed,
                  )),
            )
          )
            fail(
              422,
              "Publication is missing successful required acceptance checks",
            );
          const compact = compactOutput(output);
          const artifact: BookArtifact = {
            version: 1,
            ...compact,
            provenance: createBookProvenance(
              id,
              configuration,
              compact,
              outputs,
              await readNodeReuse(
                db,
                id,
                configuration.workflow.nodes.map((node) => node.id),
              ),
            ),
          };
          const decisions = await db
            .selectFrom("knowledge_book_human_tasks")
            .select(["id", "node_id", "resolution"])
            .where("run_id", "=", id)
            .where("status", "=", "resolved")
            .execute();
          for (const decision of decisions) {
            const resolution = JSON.parse(decision.resolution);
            artifact.provenance.nodes.push({
              id: `human:${decision.id}`,
              kind: "decision",
              label: resolution.note,
              detail: resolution,
            });
            artifact.provenance.edges.push(
              {
                source: `execution:${id}:${decision.node_id}`,
                target: `human:${decision.id}`,
                relation: "used",
              },
              {
                source: `human:${decision.id}`,
                target: `release:${id}`,
                relation: "adopted",
              },
            );
          }
          if (JSON.stringify(artifact).length > 10_000_000)
            fail(
              413,
              "Book release exceeds limits; split the workflow into smaller books",
            );
          if (configuration.autoPublish)
            await publishRun(db, run, lease, artifact, runtime);
          else {
            await assertCurrent(db, run, lease);
            await db
              .insertInto("knowledge_book_human_tasks")
              .values({
                id: randomUUID(),
                book_id: run.book_id,
                run_id: id,
                node_id: node.id,
                kind: "publication",
                title: node.label || "",
                status: "pending",
                revision: 1,
                input_hash: run.input_hash,
                resolution: "",
                created_at: bookNow(),
                updated_at: bookNow(),
              })
              .execute();
            await db
              .updateTable("knowledge_book_runs")
              .set({
                status: "awaiting_publication",
                artifact: JSON.stringify(artifact),
                lease_id: null,
                updated_at: bookNow(),
              })
              .where("id", "=", id)
              .where("status", "=", "running")
              .where("lease_id", "=", lease)
              .execute();
            await appendBookRunLog(db, run, nodeIndex, { code: "waiting_publication" });
            await db
              .updateTable("knowledge_book_node_runs")
              .set({
                status: "awaiting_publication",
                output: JSON.stringify(compactOutput(output)),
                completed_at: bookNow(),
              })
              .where("run_id", "=", id)
              .where("node_id", "=", node.id)
              .execute();
            return;
          }
        } else {
          input.evidence = await hydrate(input.evidence);
          output.evidence = input.evidence;
          const ancestors = new Set<string>([node.id]);
          for (let pass = 0; pass < configuration.workflow.nodes.length; pass++)
            for (const edge of configuration.workflow.edges)
              if (ancestors.has(edge.target)) ancestors.add(edge.source);
          const originNodes = configuration.workflow.nodes.filter(
            (definition) =>
              ancestors.has(definition.id) &&
              ["sources", "feedback"].includes(definition.type),
          );
          const weightedEvidence = input.evidence.map((item) => {
            const feedback = item.reference.kind === "feedback";
            const roots = originNodes.filter(
              (origin) =>
                (feedback
                  ? origin.type === "feedback"
                  : origin.type === "sources") &&
                outputs
                  .get(origin.id)
                  ?.evidence.some((evidence) => evidence.id === item.id),
            );
            if (!roots.length)
              fail(502, "Evidence has no executed source node");
            const rootWeight = Math.max(
              ...roots.map((origin) =>
                feedback
                  ? origin.parameters.feedbackWeight
                  : origin.parameters.sourceWeight,
              ),
            );
            return {
              ...item,
              weight:
                rootWeight *
                (feedback
                  ? node.parameters.feedbackWeight
                  : node.parameters.sourceWeight),
            };
          });
          const inheritedInstructions = originNodes
            .filter((origin) => origin.parameters.instructions.trim())
            .map((origin) => ({
              nodeId: origin.id,
              instructions: origin.parameters.instructions,
            }));
          const enabled = weightedEvidence.filter((item) => item.weight > 0);
          if (!enabled.length)
            fail(422, "Workflow has no positively weighted evidence");
          if (
            input.evidence.reduce(
              (total, item) => total + item.text.length,
              0,
            ) > 120000
          )
            fail(
              413,
              "Combined sources exceed analysis limits; narrow source scope",
            );
          const criteria = node.parameters.criterionIds.length
            ? configuration.criteria.filter((criterion) =>
                node.parameters.criterionIds.includes(criterion.id),
              )
            : configuration.criteria;
          if (
            node.parameters.criterionIds.some(
              (id) => !criteria.some((criterion) => criterion.id === id),
            )
          )
            fail(400, "Workflow selects an unknown acceptance criterion");
          const enabledIds = new Set(enabled.map((evidence) => evidence.id));
          const permittedClaims = input.claims.filter((claim) =>
            claim.evidenceIds.every((id) => enabledIds.has(id)),
          );
          output.claims = permittedClaims;
          const permittedClaimIds = new Set(
            permittedClaims.map((claim) => claim.id),
          );
          const permittedPages = input.pages
            .map((page) => ({
              ...page,
              paragraphs: page.paragraphs.filter((p) =>
                p.claimIds.every((id) => permittedClaimIds.has(id)),
              ),
            }))
            .filter((page) => page.paragraphs.length);
          output.pages = permittedPages;
          const result = await runtime.generate(
            node.type,
            {
              goal: configuration.goal,
              instructions: node.parameters.instructions,
              sourceInstructions: inheritedInstructions,
              priorReviews: rejectedReviews
                .filter((review) => {
                  const parents = new Set([review.node_id]);
                  for (
                    let pass = 0;
                    pass < configuration.workflow.nodes.length;
                    pass++
                  )
                    for (const edge of configuration.workflow.edges)
                      if (parents.has(edge.target)) parents.add(edge.source);
                  return parents.has(node.id);
                })
                .flatMap((review) =>
                  review.output ? (JSON.parse(review.output).checks ?? []) : [],
                ),
              evidence: enabled,
              claims: permittedClaims,
              pages: permittedPages,
              criteria,
              maxDocumentDepth: configuration.maxDocumentDepth,
            },
            signal,
            report,
          );
          if (node.type === "extract") {
            const parsed = claimOutputSchema.parse(result);
            checkClaims(parsed.claims, enabled);
            output.pages = [];
            output.checks = [];
            output.claims = parsed.claims.map((claim) => ({
              ...claim,
              id: `claim_${bookHash([node.id, claim.id]).slice(0, 32)}`,
            }));
          } else if (node.type === "synthesize" || node.type === "organize") {
            const parsed = pageOutputSchema.parse(result);
            checkPages(
              parsed.pages,
              permittedClaims,
              configuration.maxDocumentDepth,
            );
            output.pages = parsed.pages.map((page) => ({
              ...page,
              id: `page_${bookHash([node.id, page.id]).slice(0, 32)}`,
              paragraphs: page.paragraphs.map((p) => ({
                ...p,
                id: `paragraph_${bookHash([node.id, p.id]).slice(0, 32)}`,
              })),
            }));
          } else {
            output.checks = acceptanceOutputSchema.parse(result).checks;
            const expected = new Set(criteria.map((criterion) => criterion.id));
            if (
              new Set(output.checks.map((check) => check.criterionId)).size !==
                output.checks.length ||
              output.checks.length !== expected.size ||
              output.checks.some((check) => !expected.has(check.criterionId))
            )
              fail(
                502,
                "Acceptance did not evaluate every configured criterion exactly once",
              );
            if (
              criteria.some(
                (criterion) =>
                  criterion.required &&
                  !output.checks.find(
                    (check) => check.criterionId === criterion.id,
                  )?.passed,
              )
            ) {
              await db
                .updateTable("knowledge_book_node_runs")
                .set({ output: JSON.stringify(compactOutput(output)) })
                .where("run_id", "=", id)
                .where("node_id", "=", node.id)
                .execute();
              fail(422, "Required acceptance criteria failed");
            }
          }
        }
        await db
          .updateTable("knowledge_book_node_runs")
          .set({
            status: "completed",
            output: JSON.stringify(compactOutput(output)),
            completed_at: bookNow(),
          })
          .where("run_id", "=", id)
          .where("node_id", "=", node.id)
          .execute();
        await appendBookRunLog(db, run, nodeIndex, { code: "node_completed", value: output.pages.length, total: output.claims.length });
        outputs.set(node.id, output);
        pending.delete(node.id);
      } catch (error) {
        const original =
          error instanceof Error ? error : new Error(String(error));
        const tagged = Object.assign(
          new Error(original.message, { cause: original }),
          { bookNodeId: node.id, bookCause: original },
        );
        await db
          .updateTable("knowledge_book_node_runs")
          .set({
            status: coordinator.signal.aborted ? "cancelled" : "failed",
            error:
              original instanceof AppError
                ? systemErrorText(original)
                : original.message,
            completed_at: bookNow(),
          })
          .where("run_id", "=", id)
          .where("node_id", "=", node.id)
          .execute();
        await appendBookRunLog(db, run, nodeIndex, {
          code: coordinator.signal.aborted ? "node_cancelled" : "node_failed",
        });
        throw tagged;
      }
    }
    const inflight = new Map<
      string,
      Promise<{ nodeId: string; error?: unknown }>
    >();
    while (pending.size || inflight.size) {
      signal.throwIfAborted();
      const ready = configuration.workflow.nodes.filter(
        (node) =>
          pending.has(node.id) &&
          !inflight.has(node.id) &&
          configuration.workflow.edges
            .filter((edge) => edge.target === node.id)
            .every((edge) => outputs.has(edge.source)),
      );
      const gate = ready.find(
        (node) => node.type === "human_review" || node.type === "publish",
      );
      const selected = gate
        ? inflight.size
          ? []
          : [gate]
        : ready.slice(0, 2 - inflight.size);
      for (const node of selected)
        inflight.set(
          node.id,
          executeNode(node).then(
            () => ({ nodeId: node.id }),
            (error) => ({ nodeId: node.id, error }),
          ),
        );
      if (!inflight.size) fail(400, "Workflow cannot advance");
      const result = await Promise.race(inflight.values());
      inflight.delete(result.nodeId);
      if (result.error) {
        coordinator.abort(result.error);
        await Promise.allSettled(inflight.values());
        throw result.error;
      }
      const status = await db
        .selectFrom("knowledge_book_runs")
        .select("status")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (status.status !== "running") {
        coordinator.abort();
        await Promise.allSettled(inflight.values());
        return;
      }
    }
  } catch (error) {
    activeNode =
      (error as { bookNodeId?: string })?.bookNodeId ??
      activeNode ??
      bookConfigurationSchema
        .parse(JSON.parse(run.configuration))
        .workflow.nodes.find((node) => node.type === "publish")!.id;
    const original = (error as { bookCause?: unknown })?.bookCause ?? error;
    const message =
      original instanceof AppError
        ? systemErrorText(original)
        : original instanceof Error
          ? original.message
          : String(original);
    if (activeNode)
      await db
        .updateTable("knowledge_book_node_runs")
        .set({ status: "failed", error: message, completed_at: bookNow() })
        .where("run_id", "=", id)
        .where("node_id", "=", activeNode)
        .where("status", "in", [
          "running",
          "awaiting_input",
          "awaiting_publication",
        ])
        .execute();
    const failed = await db
      .updateTable("knowledge_book_runs")
      .set({
        status: "failed",
        error: message,
        lease_id: null,
        updated_at: bookNow(),
      })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where("lease_id", "=", lease)
      .executeTakeFirst();
    if (Number(failed.numUpdatedRows) && activeNode)
      await db
        .insertInto("knowledge_book_human_tasks")
        .values({
          id: randomUUID(),
          book_id: run.book_id,
          run_id: id,
          node_id: activeNode,
          kind: "repair",
          title: bookConfigurationSchema
            .parse(JSON.parse(run.configuration))
            .workflow.nodes.find((node) => node.id === activeNode)!.label,
          status: "pending",
          revision: 1,
          input_hash: run.input_hash,
          resolution: "",
          created_at: bookNow(),
          updated_at: bookNow(),
        })
        .execute();
    if (Number(failed.numUpdatedRows)) await appendBookRunLog(db, run, null, { code: "run_failed" });
  } finally {
    clearInterval(heartbeat);
  }
}
