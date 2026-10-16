import { z } from "zod";
import { decodeSystemError } from "@doca/i18n";
import type { DB, Schema } from "@db/index.js";
import { bookAccess, bookHash, bookInputSnapshot } from "./management.js";
import { readBookPayload } from "./payload-storage.js";
import { canReadBookPayload } from "./reads.js";
import { bookFail as fail } from "./errors.js";
import {
  acceptanceOutputSchema,
  bookConfigurationSchema,
  type BookArtifact,
  type BookConfiguration,
} from "./protocol.js";

type Candidate = Pick<BookArtifact, "pages" | "claims" | "evidence" | "checks">;
type Run = Schema["knowledge_book_runs"];

// Stored only on a new explicit decision. Existing resolutions confer no override.
const overrideSchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string(),
    outputHash: z.string().length(64),
    runConfigurationHash: z.string().length(64),
    bookConfigurationHash: z.string().length(64),
    bookRevision: z.number().int(),
    inputHash: z.string().length(64),
  })
  .strict();

export function canAcceptBookFailure(
  configuration: BookConfiguration,
  nodeId: string,
  error: string,
  output: Candidate | null,
) {
  const node = configuration.workflow.nodes.find((node) => node.id === nodeId);
  if (
    node?.type !== "acceptance" ||
    !output?.pages.some((page) =>
      page.paragraphs.some((paragraph) => paragraph.markdown.trim()),
    ) ||
    decodeSystemError(error)?.code !== "book_acceptance"
  )
    return false;
  const parsed = acceptanceOutputSchema.safeParse({ checks: output.checks });
  if (!parsed.success) return false;
  const criteria = node.parameters.criterionIds.length
    ? configuration.criteria.filter((c) =>
        node.parameters.criterionIds.includes(c.id),
      )
    : configuration.criteria;
  const checks = parsed.data.checks;
  return (
    checks.length === criteria.length &&
    new Set(checks.map((check) => check.criterionId)).size ===
      criteria.length &&
    checks.every((check) => criteria.some((c) => c.id === check.criterionId)) &&
    criteria.some(
      (c) =>
        c.required &&
        checks.some((check) => check.criterionId === c.id && !check.passed),
    )
  );
}

export function bookAcceptanceDecision(
  run: Run,
  book: Schema["knowledge_books"],
  nodeId: string,
  output: Candidate,
) {
  return overrideSchema.parse({
    version: 1,
    nodeId,
    outputHash: bookHash(output),
    runConfigurationHash: bookHash(run.configuration),
    bookConfigurationHash: bookHash(book.configuration),
    bookRevision: book.revision,
    inputHash: run.input_hash,
  });
}

/** Revalidate the actual approver and immutable candidate before using a decision. */
export async function acceptedBookFailures(db: DB, run: Run) {
  const tasks = await db
    .selectFrom("knowledge_book_human_tasks")
    .selectAll()
    .where("run_id", "=", run.id)
    .where("kind", "=", "repair")
    .where("status", "=", "resolved")
    .execute();
  const accepted = new Map<string, Candidate>();
  for (const task of tasks) {
    const resolution = JSON.parse(task.resolution);
    if (!Object.hasOwn(resolution, "acceptanceOverride")) continue;
    const parsed = overrideSchema.safeParse(resolution.acceptanceOverride);
    if (
      !parsed.success ||
      resolution.decision !== "approve" ||
      typeof resolution.note !== "string" ||
      !resolution.note.trim() ||
      typeof resolution.actorId !== "string"
    )
      fail(409, "Manual acceptance decision is invalid");
    const approval = parsed.data;
    const actor = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", resolution.actorId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!actor) fail(403, "Manual acceptance approver is unavailable");
    const { book } = await bookAccess(db, actor, run.book_id, 3);
    const node = await db
      .selectFrom("knowledge_book_node_runs")
      .selectAll()
      .where("run_id", "=", run.id)
      .where("node_id", "=", task.node_id)
      .executeTakeFirst();
    if (
      !node?.output ||
      !(await canReadBookPayload(db, actor, run.book_id, node.output))
    )
      fail(403, "Original evidence access is required for manual acceptance");
    const output = await readBookPayload<Candidate>(db, node.output);
    if (
      node.status !== "failed" ||
      approval.nodeId !== task.node_id ||
      approval.outputHash !== bookHash(output) ||
      approval.runConfigurationHash !== bookHash(run.configuration) ||
      approval.bookRevision !== book.revision ||
      approval.bookConfigurationHash !== bookHash(book.configuration) ||
      approval.inputHash !== run.input_hash ||
      (await bookInputSnapshot(db, run.book_id)).hash !== approval.inputHash ||
      !canAcceptBookFailure(
        bookConfigurationSchema.parse(JSON.parse(run.configuration)),
        task.node_id,
        node.error,
        output,
      )
    )
      fail(
        409,
        "Manual acceptance candidate or configuration changed; review again",
      );
    accepted.set(task.node_id, output);
  }
  return accepted;
}

/** A human decision waives a negative check; it never changes the model's verdict. */
export async function assertBookPublicationAcceptance(
  db: DB,
  run: Run,
  output: Candidate,
) {
  const configuration = bookConfigurationSchema.parse(
    JSON.parse(run.configuration),
  );
  if (
    configuration.criteria.some(
      (c) => !output.checks.some((check) => check.criterionId === c.id),
    )
  )
    fail(422, "Publication is missing successful required acceptance checks");
  const failed = output.checks.filter(
    (check) =>
      !check.passed &&
      configuration.criteria.some(
        (c) => c.id === check.criterionId && c.required,
      ),
  );
  if (!failed.length) return;
  const decisions = await acceptedBookFailures(db, run);
  const covered = [...decisions.values()].filter(
    (candidate) =>
      candidate.pages.every((page) =>
        output.pages.some((current) => bookHash(current) === bookHash(page)),
      ) &&
      candidate.claims.every((claim) =>
        output.claims.some((current) => bookHash(current) === bookHash(claim)),
      ),
  );
  if (
    failed.some(
      (check) =>
        !covered.some((candidate) =>
          candidate.checks.some(
            (approved) => bookHash(approved) === bookHash(check),
          ),
        ),
    )
  )
    fail(
      422,
      "Publication is missing successful required acceptance checks or a valid manual decision",
    );
}
