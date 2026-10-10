import { decodeSystemError } from "@doca/i18n";
import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { homeOverview } from "@core/modules/workspace/home.js";
import {
  bookConfigurationSchema,
  defaultBookConfiguration,
} from "@core/modules/knowledge-books/protocol.js";
import {
  createKnowledgeBook,
  saveBookConfiguration,
  queueBookRun,
} from "@core/modules/knowledge-books/management.js";
import { executeBookCommand } from "@core/modules/knowledge-books/commands.js";
import { validateBookModelAccess } from "@core/modules/knowledge-books/model-access.js";
import {
  executeBookRun,
  type BookRuntime,
} from "@core/modules/knowledge-books/engine.js";
import {
  readKnowledgeBook,
  readBookRun,
  readBookPipeline,
  readBookRelease,
} from "@core/modules/knowledge-books/reads.js";
import {
  listBookHumanTasks,
  resolveBookHumanTask,
} from "@core/modules/knowledge-books/human-tasks.js";

let db: DB, owner: Actor, collaborator: Actor, bookId: string;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      {
        login: "book-owner",
        displayName: "Book owner",
        password: randomUUID(),
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  collaborator = {
    ...(await createUser(
      db,
      {
        login: "book-collaborator",
        displayName: "Collaborator",
        password: randomUUID(),
      },
      { actor: owner },
    )),
    admin: 0,
  };
  bookId = (await createKnowledgeBook(db, owner, "Network protocols")).id;
  const configuration = defaultBookConfiguration();
  configuration.goal = "A detailed network protocol tutorial";
  configuration.autoPublish = true;
  configuration.criteria = [
    {
      id: "grounded",
      description: "All factual paragraphs are supported by evidence",
      required: true,
    },
  ];
  await saveBookConfiguration(db, owner, bookId, 1, configuration);
});
afterEach(async () => {
  await db.destroy();
});
async function share(
  role: "reader" | "commenter" | "editor" | "manager" | null,
) {
  const row = await db
    .selectFrom("resources")
    .select("authz_revision")
    .where("id", "=", bookId)
    .executeTakeFirstOrThrow();
  await createContent(db).member(owner, bookId, collaborator.id, {
    revision: row.authz_revision!,
    role,
    includeDescendants: true,
  });
}
async function manual(
  text = "DNS negative caching uses the smaller of the SOA record TTL and the SOA MINIMUM field.",
) {
  return executeBookCommand(db, owner, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    title: "Protocol source",
    configuration: {
      version: 1,
      items: [{ id: "binding", kind: "manual", markdown: text }],
    },
    status: "active",
  });
}
function runtime(
  transform?: (stage: string, input: any, result: any) => Promise<any> | any,
): BookRuntime {
  return {
    async readFile() {
      throw new Error("File not used by this fixture");
    },
    async readWeb() {
      return {
        title: "Web protocol source",
        text: "TCP is a reliable byte stream protocol.",
      };
    },
    async generate(stage, input: any) {
      let result: any;
      if (stage === "extract")
        result = {
          claims: input.evidence.map((e: any, i: number) => ({
            id: `claim_${i}`,
            statement: e.text,
            evidenceIds: [e.id],
            evidenceQuotes: [{ evidenceId: e.id, quote: e.text.slice(0, 800) }],
            reason: "Supported by the supplied source",
            confidence: 1,
          })),
        };
      else if (stage === "acceptance")
        result = {
          checks: input.criteria.map((c: any) => ({
            criterionId: c.id,
            passed: true,
            reason: "The required content exists",
          })),
        };
      else
        result = {
          pages: [
            {
              id: "dns",
              title: "DNS caching",
              path: ["Concepts"],
              paragraphs: input.claims.map((c: any, i: number) => ({
                id: `paragraph_${i}`,
                markdown: c.statement,
                claimIds: [c.id],
                reason: "Adopt the supported claim under the workflow rules",
              })),
            },
          ],
        };
      return transform ? transform(stage, input, result) : result;
    },
  };
}
async function run(model = runtime()) {
  const queued = await queueBookRun(db, owner, bookId);
  await executeBookRun(db, queued.id, model);
  return db
    .selectFrom("knowledge_book_runs")
    .selectAll()
    .where("id", "=", queued.id)
    .executeTakeFirstOrThrow();
}
it("pauses at a human review node, resumes without repeating completed model nodes, and records the decision", async () => {
  await manual();
  await share("editor");
  const config = (await readKnowledgeBook(db, owner, bookId)).configuration;
  config.workflow.nodes.push({
    id: "review",
    type: "human_review",
    label: "Check the tutorial",
    position: { x: 500, y: 200 },
    parameters: {
      instructions: "Review technical precision",
      sourceIds: [],
      criterionIds: [],
      sourceWeight: 1,
      feedbackWeight: 1,
    },
  });
  config.workflow.edges = config.workflow.edges.filter(
    (edge) => edge.target !== "publish",
  );
  config.workflow.edges.push(
    { source: "acceptance", target: "review" },
    { source: "review", target: "publish" },
  );
  await saveBookConfiguration(db, owner, bookId, 2, config);
  let calls = 0;
  const model = runtime((_stage, _input, result) => {
    calls++;
    return result;
  });
  const first = await run(model);
  expect(first.status).toBe("awaiting_input");
  expect(calls).toBe(4);
  const task = (
    await listBookHumanTasks(db, collaborator, {
      bookId,
      kind: "review",
      status: "pending",
    })
  ).items[0]!;
  expect(task.output.pages.length).toBeGreaterThan(0);
  await resolveBookHumanTask(db, collaborator, task.id, {
    expectedRevision: task.revision,
    decision: "approve",
    note: "Checked the DNS caching rule",
  });
  await expect(
    resolveBookHumanTask(db, owner, task.id, {
      expectedRevision: task.revision,
      decision: "approve",
      note: "Duplicate",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await executeBookRun(db, first.id, model);
  expect(calls).toBe(4);
  const result = await readKnowledgeBook(db, owner, bookId);
  expect(
    result.publishedRelease?.artifact?.provenance.nodes.some(
      (node) => node.detail.note === "Checked the DNS caching rule",
    ),
  ).toBe(true);
});
it("shows a stale human task and rejects approving it after inputs change", async () => {
  await manual();
  const config = (await readKnowledgeBook(db, owner, bookId)).configuration;
  config.autoPublish = false;
  await saveBookConfiguration(db, owner, bookId, 2, config);
  await run();
  const task = (
    await listBookHumanTasks(db, owner, { bookId, status: "pending" })
  ).items[0]!;
  expect(task.output.pages.length).toBeGreaterThan(0);
  await manual("A new source input");
  expect(
    (await listBookHumanTasks(db, owner, { bookId, status: "pending" }))
      .items[0]?.stale,
  ).toBe(true);
  await expect(
    resolveBookHumanTask(db, owner, task.id, {
      expectedRevision: task.revision,
      decision: "approve",
      note: "",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("blocks ordinary document creation, move and copy into a knowledge book", async () => {
  const content = createContent(db);
  await expect(
    content.create(owner, {
      kind: "document",
      format: "markdown",
      title: "Bypass",
      libraryId: bookId,
    }),
  ).rejects.toMatchObject({ status: 403 });
  const document = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Source",
    markdown: "DNS source",
  });
  const row = await db
    .selectFrom("resources")
    .select("version")
    .where("id", "=", document.id)
    .executeTakeFirstOrThrow();
  await expect(
    content.move(owner, document.id, {
      version: row.version,
      parentId: null,
      libraryId: bookId,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    content.copy(owner, document.id, {
      includeChildren: false,
      libraryId: bookId,
    }),
  ).rejects.toMatchObject({ status: 403 });
});
it("rejects cycles, type-invalid edges, unreachable publication and unversioned configurations", () => {
  const configuration = defaultBookConfiguration();
  expect(bookConfigurationSchema.safeParse(configuration).success).toBe(true);
  configuration.workflow.edges.push({ source: "publish", target: "extract" });
  expect(bookConfigurationSchema.safeParse(configuration).success).toBe(false);
  const disconnected = defaultBookConfiguration();
  disconnected.workflow.edges = disconnected.workflow.edges.filter(
    (e) => e.source !== "organize",
  );
  expect(bookConfigurationSchema.safeParse(disconnected).success).toBe(false);
  expect(
    bookConfigurationSchema.safeParse({
      ...defaultBookConfiguration(),
      version: 0,
    }).success,
  ).toBe(false);
});
it("uses normal resource roles and rejects stale writes from another editor", async () => {
  await share("reader");
  expect((await readKnowledgeBook(db, collaborator, bookId)).canEdit).toBe(
    false,
  );
  await expect(
    saveBookConfiguration(
      db,
      collaborator,
      bookId,
      2,
      defaultBookConfiguration(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await share("editor");
  expect((await readKnowledgeBook(db, collaborator, bookId)).canEdit).toBe(
    true,
  );
  await saveBookConfiguration(
    db,
    collaborator,
    bookId,
    2,
    defaultBookConfiguration(),
  );
  await expect(
    saveBookConfiguration(db, owner, bookId, 2, defaultBookConfiguration()),
  ).rejects.toMatchObject({ status: 409 });
});
it("produces immutable releases with paragraph evidence lineage and node execution records", async () => {
  await manual();
  const result = await run();
  expect(result.status, result.error).toBe("published");
  const view = await readKnowledgeBook(db, owner, bookId),
    artifact = view.publishedRelease!.artifact!;
  const paragraph = artifact.pages[0]!.paragraphs[0]!;
  expect(
    artifact.provenance.edges.some(
      (edge) =>
        edge.target === `paragraph:${paragraph.id}` &&
        edge.relation === "generated",
    ),
  ).toBe(true);
  expect(
    artifact.provenance.nodes.some(
      (node) => node.kind === "evidence" && node.label.includes("SOA"),
    ),
  ).toBe(true);
  const snapshot = JSON.stringify(artifact);
  await executeBookCommand(db, owner, bookId, {
    operation: "feedback.save",
    expectedRevision: 0,
    status: "active",
    detail: {
      kind: "correction",
      content: "Explain that cached TTL counts down over time.",
      releaseId: view.publishedRelease!.id,
      pageId: artifact.pages[0]!.id,
      paragraphId: paragraph.id,
    },
  });
  expect((await run()).status).toBe("published");
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease!.revision,
  ).toBe(2);
  expect(
    JSON.stringify(
      (await readBookRelease(db, owner, bookId, view.publishedRelease!.id))
        .artifact,
    ),
  ).toBe(snapshot);
  expect((await readBookRun(db, owner, bookId, result.id)).nodes).toHaveLength(
    7,
  );
});
it("blocks forged evidence and preserves the last published release after failed acceptance", async () => {
  await manual();
  expect((await run()).status).toBe("published");
  const previous = (await readKnowledgeBook(db, owner, bookId))
    .publishedRelease!.id;
  const forged = await run(
    runtime((stage, _input, result) =>
      stage === "extract"
        ? {
            claims: [
              { ...result.claims[0], evidenceIds: ["nonexistent-evidence"] },
            ],
          }
        : result,
    ),
  );
  expect(forged.status).toBe("failed");
  expect(decodeSystemError(forged.error)?.code).toBe("book_model_output");
  const failed = await run(
    runtime((stage, _input, result) =>
      stage === "acceptance"
        ? { checks: result.checks.map((c: any) => ({ ...c, passed: false })) }
        : result,
    ),
  );
  expect(failed.status).toBe("failed");
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease!.id,
  ).toBe(previous);
});
it("requires an explicit publication task when automatic publication is disabled", async () => {
  await manual();
  const view = await readKnowledgeBook(db, owner, bookId);
  view.configuration.autoPublish = false;
  await saveBookConfiguration(
    db,
    owner,
    bookId,
    view.revision,
    view.configuration,
  );
  const result = await run();
  expect(result.status).toBe("awaiting_publication");
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease,
  ).toBeNull();
  await executeBookCommand(db, owner, bookId, {
    operation: "run.publish",
    runId: result.id,
  });
  await executeBookRun(db, result.id, runtime());
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease!.revision,
  ).toBe(1);
});
it("fails publication if configuration or source content changes during model execution", async () => {
  const added: any = await manual();
  const result = await run(
    runtime(async (stage, _input, output) => {
      if (stage === "extract")
        await executeBookCommand(db, owner, bookId, {
          operation: "source.save",
          id: added.id,
          expectedRevision: 1,
          title: "Changed protocol source",
          configuration: {
            version: 1,
            items: [
              {
                id: "binding",
                kind: "manual",
                markdown: "A concurrently changed source.",
              },
            ],
          },
          status: "active",
        });
      return output;
    }),
  );
  expect(result.status).toBe("failed");
  expect(decodeSystemError(result.error)?.code).toBe("book_conflict");
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease,
  ).toBeNull();
});
it("withholds artifacts and node bodies from readers lacking original-source access", async () => {
  const doc = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "Private protocol",
    markdown: "Secret production protocol configuration",
    private: true,
  });
  await executeBookCommand(db, owner, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    title: "Private protocol",
    configuration: {
      version: 1,
      items: [{ id: "binding", kind: "document", resourceId: doc.id }],
    },
    status: "active",
  });
  const result = await run();
  expect(result.status).toBe("published");
  await share("manager");
  const view = await readKnowledgeBook(db, collaborator, bookId);
  expect(view.sources[0]!.configuration).toBeNull();
  expect(view.publishedRelease!.artifact).toBeNull();
  const detail = await readBookRun(db, collaborator, bookId, result.id);
  expect(detail.artifact).toBeNull();
  expect(detail.nodes.every((node) => node.output === null)).toBe(true);
});
it("allows commenters to contribute feedback but not edit the workflow or forge anchors", async () => {
  await share("commenter");
  const feedback: any = await executeBookCommand(db, collaborator, bookId, {
    operation: "feedback.save",
    expectedRevision: 0,
    status: "active",
    detail: {
      kind: "question",
      content: "Please explain the DNS cache boundary.",
      releaseId: null,
      pageId: null,
      paragraphId: null,
    },
  });
  expect(feedback.revision).toBe(1);
  await expect(
    executeBookCommand(db, collaborator, bookId, { operation: "run.start" }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    executeBookCommand(db, collaborator, bookId, {
      operation: "feedback.save",
      expectedRevision: 0,
      status: "active",
      detail: {
        kind: "correction",
        content: "A forged target",
        releaseId: randomUUID(),
        pageId: "private",
        paragraphId: "private",
      },
    }),
  ).rejects.toMatchObject({ status: 404 });
});

it("records real manual and personal-assistant feedback authors and versions", async () => {
  await share("commenter");
  const detail = {
    kind: "correction",
    content: "TCP preserves byte order, not application message boundaries.",
    releaseId: null,
    pageId: null,
    paragraphId: null,
  };
  const first: any = await executeBookCommand(
    db,
    collaborator,
    bookId,
    {
      operation: "feedback.save",
      expectedRevision: 0,
      status: "active",
      detail,
    },
    "assistant",
  );
  let feedback = (await readKnowledgeBook(db, owner, bookId)).feedback[0]!;
  expect(feedback.origin.method).toBe("assistant");
  expect(feedback.origin.actorId).toBe(collaborator.id);
  await executeBookCommand(db, collaborator, bookId, {
    operation: "feedback.save",
    id: first.id,
    expectedRevision: 1,
    status: "active",
    detail: { ...detail, content: "Manual follow-up clarification" },
  });
  feedback = (await readKnowledgeBook(db, owner, bookId)).feedback[0]!;
  expect(feedback.origin.method).toBe("manual");
  expect(feedback.revision).toBe(2);
  expect(
    await db
      .selectFrom("knowledge_book_feedback_versions")
      .selectAll()
      .where("feedback_id", "=", first.id)
      .execute(),
  ).toHaveLength(2);
});
it("propagates configured source instructions and weights, and fails after a contributor loses access", async () => {
  await share("editor");
  const added: any = await executeBookCommand(db, collaborator, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    title: "Shared source",
    configuration: {
      version: 1,
      items: [
        {
          id: "binding",
          kind: "manual",
          markdown: "TCP is a reliable byte stream.",
        },
      ],
    },
    status: "active",
  });
  const configuration = (await readKnowledgeBook(db, owner, bookId))
    .configuration;
  configuration.workflow.nodes.find(
    (n) => n.type === "sources",
  )!.parameters.sourceWeight = 7;
  configuration.workflow.nodes.find(
    (n) => n.type === "sources",
  )!.parameters.instructions = "Use protocol definitions with their conditions";
  configuration.workflow.nodes.find(
    (n) => n.type === "extract",
  )!.parameters.sourceWeight = 3;
  await saveBookConfiguration(db, owner, bookId, 2, configuration);
  const result = await run(
    runtime(async (stage, input, output) => {
      if (stage === "extract") {
        expect(input.evidence[0].weight).toBe(21);
        expect(input.sourceInstructions[0].instructions).toContain(
          "protocol definitions",
        );
        await share(null);
      }
      return output;
    }),
  );
  expect(result.status).toBe("failed");
  expect(result.error).toBeTruthy();
  expect(
    (await readBookRun(db, owner, bookId, result.id)).nodes.filter(
      (n) => n.type === "synthesize",
    )[0]?.status,
  ).toBe("failed");
  expect(added.id).toBeTruthy();
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease,
  ).toBeNull();
});
it("uses bounded assistant reads and enforces original evidence access on page search", async () => {
  const { readBookForAssistant, readBookPageForAssistant, findBookParagraphs } =
    await import("@core/modules/knowledge-books/assistant-reads.js");
  await manual();
  await run();
  const book = await readBookForAssistant(db, owner, bookId),
    release = book.publishedRelease!;
  expect(release.artifact!.pages[0]).not.toHaveProperty("paragraphs");
  expect(book.sources[0]!.configuration!.items[0]).toMatchObject({
    kind: "manual",
    markdown: null,
    contentOmitted: true,
  });
  const page = await readBookPageForAssistant(
    db,
    owner,
    bookId,
    release.id,
    release.artifact!.pages[0]!.id,
  );
  expect(page.paragraphs[0]!.markdown).toContain("DNS");
  expect(page.evidence.length).toBeGreaterThan(0);
  const matches = await findBookParagraphs(
    db,
    owner,
    bookId,
    release.id,
    "smaller",
  );
  expect(matches.items[0]!.paragraphId).toBe(page.paragraphs[0]!.id);
  await expect(
    readBookPageForAssistant(
      db,
      collaborator,
      bookId,
      release.id,
      page.page.id,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it("preserves public read-only book results while private evidence still prevents anonymous reading", async () => {
  const { readPublishedKnowledgeBook } =
    await import("@core/modules/knowledge-books/reads.js");
  await manual();
  await run();
  const row = await db
    .selectFrom("resources")
    .select("version")
    .where("id", "=", bookId)
    .executeTakeFirstOrThrow();
  await createContent(db).permissions(owner, bookId, {
    version: row.version,
    visibility: "public",
    publicRole: "reader",
  });
  expect(
    (await readPublishedKnowledgeBook(db, bookId)).publishedRelease?.artifact
      ?.pages.length,
  ).toBeGreaterThan(0);
  const doc = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "Private input",
    markdown: "Private deployment fact",
    private: true,
  });
  await executeBookCommand(db, owner, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    title: "Private input",
    configuration: {
      version: 1,
      items: [{ id: "binding", kind: "document", resourceId: doc.id }],
    },
    status: "active",
  });
  await run();
  expect(
    (await readPublishedKnowledgeBook(db, bookId)).publishedRelease?.artifact,
  ).toBeNull();
});
it("gives unnamed repair tasks a visible home link that opens the exact task", async () => {
  await manual();
  const queued = await queueBookRun(db, owner, bookId);
  await executeBookRun(db, queued.id, runtime(() => { throw new Error("Isolated model failure"); }));
  const tasks = await listBookHumanTasks(db, owner, { bookId, runId: queued.id, status: "pending" });
  const overview = await homeOverview(db, owner);
  const item = overview.todos.find((group) => group.kind === "knowledge-books")!.items.find((item) => item.id === tasks.items[0]!.id)!;
  expect(item.title).toBe("Network protocols");
  expect(item.href).toBe(`#/knowledge-books/${bookId}?task=${tasks.items[0]!.id}&run=${queued.id}`);
});
it("turns an interrupted lease into queryable node repair tasks without changing prior outputs", async () => {
  const { recoverBookRuns } =
    await import("@core/modules/knowledge-books/recovery.js");
  await manual();
  const queued = await queueBookRun(db, owner, bookId),
    old = "2020-01-01T00:00:00.000Z";
  await db
    .updateTable("knowledge_book_runs")
    .set({ status: "running", lease_id: randomUUID(), heartbeat_at: old })
    .where("id", "=", queued.id)
    .execute();
  await db
    .insertInto("knowledge_book_node_runs")
    .values({
      run_id: queued.id,
      node_id: "extract",
      type: "extract",
      status: "running",
      input_refs: "[]",
      output: "",
      error: "",
      started_at: old,
      completed_at: null,
    })
    .execute();
  await recoverBookRuns(db, "2026-01-01T00:00:00.000Z");
  await recoverBookRuns(db, "2026-01-01T00:00:00.000Z");
  const tasks = await listBookHumanTasks(db, owner, {
    bookId,
    runId: queued.id,
    nodeId: "extract",
    kind: "repair",
    status: "pending",
  });
  expect(tasks.items).toHaveLength(1);
  expect(decodeSystemError(tasks.items[0]!.error)?.code).toBe("book_failed");
  expect(
    (await readBookRun(db, owner, bookId, queued.id)).nodes[0]!.status,
  ).toBe("failed");
});

it("retains native grouped source subscriptions without recreating curation rows or resource fields", async () => {
  const {
    subscribeKnowledgeSource,
    updateKnowledgeSourceGroup,
    listKnowledgeSubscriptions,
  } = await import("@core/modules/knowledge/subscriptions.js");
  const content = createContent(db),
    library = await content.create(owner, {
      kind: "library",
      format: "markdown",
      title: "Editable sources",
    });
  const first = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "TCP primary source",
    markdown: "TCP is a byte stream.",
  });
  const second = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "DNS primary source",
    markdown: "DNS caches both positive and negative answers.",
  });
  const added = await subscribeKnowledgeSource(db, owner, library.id, {
    sourceKind: "document",
    sourceIds: [first.id],
    title: "Protocol documents",
  });
  expect(added.groupId).toBeTruthy();
  await updateKnowledgeSourceGroup(db, owner, library.id, added.groupId!, {
    sourceIds: [first.id, second.id],
    title: "Primary protocol documents",
  });
  const initialTitle = (await content.detail(owner, first.id)).resource.title;
  let subscriptions = await listKnowledgeSubscriptions(db, owner, library.id);
  expect(subscriptions.items).toHaveLength(2);
  expect(subscriptions.groups[0]!.title).toBe("Primary protocol documents");
  const { detachKnowledgeSource } =
    await import("@core/modules/knowledge/source-access.js");
  await detachKnowledgeSource(
    db,
    owner,
    library.id,
    subscriptions.items[0]!.id,
  );
  subscriptions = await listKnowledgeSubscriptions(db, owner, library.id);
  expect(subscriptions.items.some((item) => item.status === "detached")).toBe(
    true,
  );
  expect((await content.detail(owner, first.id)).resource.title).toBe(
    initialTitle,
  );
  const tables = await db.introspection.getTables();
  expect(tables.some((table) => table.name === "knowledge_entries")).toBe(
    false,
  );
  expect(tables.some((table) => table.name === "knowledge_conversations")).toBe(
    false,
  );
  expect(
    tables
      .find((table) => table.name === "knowledge_subscriptions")!
      .columns.map((column) => column.name),
  ).not.toContain("preset");
  expect(
    tables
      .find((table) => table.name === "resources")!
      .columns.map((column) => column.name),
  ).not.toContain("ai_curated");
});

it("retries failed nodes with audited completed outputs and keeps the failed run intact", async () => {
  await manual();
  let calls = 0;
  const failed = await run(
    runtime((stage, _input, result) => {
      calls++;
      if (stage === "synthesize") throw new Error("Temporary model problem");
      return result;
    }),
  );
  expect(failed.status).toBe("failed");
  expect(calls).toBe(2);
  const task = (
    await listBookHumanTasks(db, owner, {
      bookId,
      runId: failed.id,
      kind: "repair",
      status: "pending",
    })
  ).items[0]!;
  const queued = await resolveBookHumanTask(db, owner, task.id, {
    expectedRevision: task.revision,
    decision: "retry",
    note: "Retry the interrupted model node",
  });
  expect(queued).toHaveProperty("reusedNodes");
  let retriedCalls = 0;
  await executeBookRun(
    db,
    (queued as { id: string }).id,
    runtime((_stage, _input, result) => {
      retriedCalls++;
      return result;
    }),
  );
  expect(retriedCalls).toBe(3);
  expect(
    (
      await db
        .selectFrom("knowledge_book_runs")
        .select("status")
        .where("id", "=", failed.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("failed");
  const book = await readKnowledgeBook(db, owner, bookId);
  expect(
    book.publishedRelease?.artifact?.provenance.nodes.some(
      (node) => node.detail.reusedFromRunId === failed.id,
    ),
  ).toBe(true);
  const trace = await readBookRun(
    db,
    owner,
    bookId,
    (queued as { id: string }).id,
  );
  expect(
    trace.nodes.find((node) => node.type === "extract")?.reusedFromRunId,
  ).toBe(failed.id);
});
it("does not reuse results when a human changes frozen inputs before retry", async () => {
  await manual();
  const failed = await run(
    runtime((stage, _input, result) => {
      if (stage === "synthesize") throw new Error("Temporary model problem");
      return result;
    }),
  );
  await manual("A changed protocol input");
  const task = (
    await listBookHumanTasks(db, owner, {
      bookId,
      runId: failed.id,
      kind: "repair",
      status: "pending",
    })
  ).items[0]!;
  const queued = await resolveBookHumanTask(db, owner, task.id, {
    expectedRevision: task.revision,
    decision: "retry",
    note: "Use the new inputs",
  });
  expect(queued).not.toHaveProperty("reusedNodes");
  let calls = 0;
  await executeBookRun(
    db,
    (queued as { id: string }).id,
    runtime((_stage, _input, result) => {
      calls++;
      return result;
    }),
  );
  expect(calls).toBe(4);
});

it("invalidates cached model results when a native primary document version changes", async () => {
  const document = await createContent(db).create(owner, {
    kind: "document",
    format: "markdown",
    title: "Primary input",
    markdown: "Old protocol condition.",
  });
  await executeBookCommand(db, owner, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    title: "Primary input",
    configuration: {
      version: 1,
      items: [{ id: "binding", kind: "document", resourceId: document.id }],
    },
    status: "active",
  });
  const failed = await run(
    runtime((stage, _input, result) => {
      if (stage === "synthesize") throw new Error("Temporary problem");
      return result;
    }),
  );
  const state = await db
    .selectFrom("document_states")
    .select("seq")
    .where("resource_id", "=", document.id)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("document_states")
    .set({ text: "Updated protocol condition.", seq: state.seq + 1 })
    .where("resource_id", "=", document.id)
    .execute();
  const task = (
    await listBookHumanTasks(db, owner, {
      bookId,
      runId: failed.id,
      kind: "repair",
      status: "pending",
    })
  ).items[0]!;
  const queued = await resolveBookHumanTask(db, owner, task.id, {
    expectedRevision: task.revision,
    decision: "retry",
    note: "Read the changed primary document",
  });
  await executeBookRun(db, (queued as { id: string }).id, runtime());
  const trace = await readBookRun(
    db,
    owner,
    bookId,
    (queued as { id: string }).id,
  );
  expect(
    trace.nodes.find((node) => node.type === "extract")?.reusedFromRunId,
  ).toBeNull();
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease?.artifact
      ?.pages[0]?.paragraphs[0]?.markdown,
  ).toContain("Updated protocol condition");
});

it("keeps separate provenance for identical paragraphs in different library documents", async () => {
  const content = createContent(db),
    library = await content.create(owner, {
      kind: "library",
      format: "markdown",
      title: "Source collection",
    });
  const first = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Same",
    libraryId: library.id,
    markdown: "TCP is a byte stream.",
  });
  const second = await content.create(owner, {
    kind: "document",
    format: "markdown",
    title: "Same",
    libraryId: library.id,
    markdown: "TCP is a byte stream.",
  });
  await executeBookCommand(db, owner, bookId, {
    operation: "source.save",
    expectedRevision: 0,
    status: "active",
    title: "Both protocol sources",
    configuration: {
      version: 1,
      items: [{ id: "binding", kind: "library", resourceId: library.id }],
    },
  });
  await run(
    runtime((stage, input, result) => {
      if (stage === "extract") {
        expect(input.evidence).toHaveLength(2);
        expect(new Set(input.evidence.map((e: any) => e.id)).size).toBe(2);
      }
      return result;
    }),
  );
  const artifact = (await readKnowledgeBook(db, owner, bookId))
    .publishedRelease!.artifact!;
  expect(
    new Set(
      artifact.evidence.map((e) =>
        e.reference.kind === "document" ? e.reference.resourceId : null,
      ),
    ),
  ).toEqual(new Set([first.id, second.id]));
});
it("applies document history permissions to historical knowledge-book releases", async () => {
  await manual();
  const first = await run();
  await manual("Updated DNS condition.");
  await run();
  await share("reader");
  const release = await db
    .selectFrom("knowledge_book_releases")
    .select("id")
    .where("run_id", "=", first.id)
    .executeTakeFirstOrThrow();
  await expect(
    readBookRelease(db, collaborator, bookId, release.id),
  ).rejects.toMatchObject({ status: 403 });
  const row = await db
    .selectFrom("resources")
    .select("version")
    .where("id", "=", bookId)
    .executeTakeFirstOrThrow();
  await createContent(db).permissions(owner, bookId, {
    version: row.version,
    historyReaders: true,
  });
  expect(
    (await readBookRelease(db, collaborator, bookId, release.id)).artifact
      ?.pages.length,
  ).toBeGreaterThan(0);
});

it.each([true, false])(
  "reuses one shared criterion across acceptance nodes while preserving every mandatory result (%s)",
  async (pass) => {
    await manual();
    const book = await readKnowledgeBook(db, owner, bookId);
    const config = book.configuration;
    const first = config.workflow.nodes.find(
      (node) => node.type === "acceptance",
    )!;
    config.workflow.nodes.push({
      ...structuredClone(first),
      id: "second-review",
      parameters: {
        ...first.parameters,
        instructions: "Second independent review",
        criterionIds: ["grounded"],
      },
    });
    config.workflow.edges.push(
      { source: "organize", target: "second-review" },
      { source: "second-review", target: "publish" },
    );
    await saveBookConfiguration(db, owner, bookId, book.revision, config);
    const reviewed = new Set<string>();
    const result = await run(
      runtime((stage, input, output) => {
        if (stage !== "acceptance") return output;
        expect(input.criteria).toHaveLength(1);
        reviewed.add(input.instructions);
        return input.instructions === "Second independent review" && !pass
          ? {
              checks: output.checks.map((check: any) => ({
                ...check,
                passed: false,
                reason: "This branch is incomplete",
              })),
            }
          : output;
      }),
    );
    expect(reviewed.size).toBe(2);
    const current = await readKnowledgeBook(db, owner, bookId);
    if (pass) {
      expect(result.status).toBe("published");
      expect(current.configuration.criteria).toHaveLength(1);
      expect(current.publishedRelease!.artifact!.checks).toHaveLength(2);
      expect(
        current.publishedRelease!.artifact!.checks.every(
          (check) => check.criterionId === "grounded" && check.passed,
        ),
      ).toBe(true);
    } else {
      expect(result.status).toBe("failed");
      expect(current.publishedRelease).toBeNull();
    }
  },
);
it("regenerates rejected facts and pages after acceptance fails and supplies the recorded review", async () => {
  await manual();
  const rejected = await run(
    runtime((stage, input, result) =>
      stage === "acceptance"
        ? {
            checks: input.criteria.map((c: any) => ({
              criterionId: c.id,
              passed: false,
              reason: "Missing multicast mechanisms",
            })),
          }
        : result,
    ),
  );
  expect(rejected.status).toBe("failed");
  const task = (
    await listBookHumanTasks(db, owner, {
      bookId,
      runId: rejected.id,
      kind: "repair",
      status: "pending",
    })
  ).items[0]!;
  const queued = await resolveBookHumanTask(db, owner, task.id, {
    expectedRevision: task.revision,
    decision: "retry",
    note: "Restore the missing topic",
  });
  const stages: string[] = [];
  await executeBookRun(
    db,
    (queued as { id: string }).id,
    runtime((stage, input, result) => {
      stages.push(stage);
      if (stage === "extract")
        expect(input.priorReviews[0].reason).toBe(
          "Missing multicast mechanisms",
        );
      return result;
    }),
  );
  expect(stages).toEqual(["extract", "synthesize", "organize", "acceptance"]);
  expect(
    (await readKnowledgeBook(db, owner, bookId)).publishedRelease?.artifact
      ?.pages.length,
  ).toBeGreaterThan(0);
});

it("stores a visible run lifecycle and model progress without copying model text into audit logs", async () => {
  await manual();
  const model = runtime(), generate = model.generate;
  model.generate = async (stage, input, signal, report) => {
    await report?.({ code: "model_request", value: 1, total: 3 });
    const result = await generate(stage, input, signal);
    await report?.({ code: "model_output", value: 120 });
    return result;
  };
  const finished = await run(model);
  const saved = await readBookRun(db, owner, bookId, finished.id);
  expect(saved.logs.map(entry => entry.code)).toEqual(expect.arrayContaining(["run_started", "node_started", "source_loading", "source_loaded", "model_request", "model_output", "node_completed", "run_published"]));
  expect(saved.logs.filter(entry => entry.code === "model_request")).toHaveLength(4);
  expect(saved.logs.find(entry => entry.code === "model_output" && entry.nodeType === "extract")).toMatchObject({ value: 120, nodeType: "extract" });
  const audit = await db.selectFrom("audit_events").select("action").where("resource_id", "=", bookId).execute();
  expect(audit.every(entry => entry.action.length <= 64)).toBe(true);
  expect(JSON.stringify(audit)).not.toContain("negative caching");
  expect(finished.status).toBe("published");
});
it("keeps recorded failure diagnostics after a model failure and does not fabricate logs for an unstarted run", async () => {
  await manual();
  const queued = await queueBookRun(db, owner, bookId);
  expect((await readBookRun(db, owner, bookId, queued.id)).logs.map(entry => entry.code)).toEqual(["run_queued"]);
  const model = runtime();
  model.generate = async () => { throw new Error("isolated model failure"); };
  await executeBookRun(db, queued.id, model);
  const failed = await readBookRun(db, owner, bookId, queued.id);
  expect(failed.status).toBe("failed");
  expect(failed.logs.map(entry => entry.code)).toEqual(expect.arrayContaining(["node_failed", "run_failed"]));
  expect(failed.nodes.find(node => node.status === "failed")?.error).toContain("isolated model failure");
});

it("keeps the actual trigger person and first start time when a different editor approves publication", async () => {
  await manual(); await share("editor");
  const config = (await readKnowledgeBook(db, owner, bookId)).configuration;
  config.autoPublish = false;
  await saveBookConfiguration(db, owner, bookId, 2, config);
  const first = await run();
  expect(first.status).toBe("awaiting_publication");
  const startedAt = first.started_at;
  const task = (await listBookHumanTasks(db, collaborator, { bookId, runId: first.id, kind: "publication", status: "pending" })).items[0]!;
  await resolveBookHumanTask(db, collaborator, task.id, { expectedRevision: task.revision, decision: "approve", note: "Reviewed" });
  await executeBookRun(db, first.id, runtime());
  const detail = await readBookRun(db, owner, bookId, first.id);
  expect(detail.startedAt).toBe(startedAt);
  expect(detail.trigger).toMatchObject({ kind: "user", actorId: owner.id, actorName: "Book owner" });
  const list = await readKnowledgeBook(db, owner, bookId);
  expect(list.runs.find(item => item.id === first.id)).toMatchObject({ started_at: startedAt, trigger: { actorId: owner.id } });
});
it("identifies scheduled triggers from recorded queue facts and never invents a historical trigger", async () => {
  await manual();
  const scheduled = await queueBookRun(db, owner, bookId, "daily:2026-10-10");
  expect((await readBookRun(db, owner, bookId, scheduled.id)).trigger).toMatchObject({ kind: "schedule", schedule: "daily", actorId: owner.id });
  const prior = await queueBookRun(db, owner, bookId);
  await db.deleteFrom("audit_events").where("action", "=", `kb1:${prior.id}:-:rq:-:-`).execute();
  expect((await readBookRun(db, owner, bookId, prior.id)).trigger).toBeNull();
});


it("continues the same failed pipeline with frozen configuration and unchanged completed nodes", async () => {
  await manual();
  const failed = await run(runtime((stage, _input, output) => {
    if (stage === "synthesize") throw new Error("Temporary model failure");
    return output;
  }));
  const before = await db.selectFrom("knowledge_book_node_runs").selectAll().where("run_id", "=", failed.id).where("status", "=", "completed").execute();
  const book = await readKnowledgeBook(db, owner, bookId);
  const edited = structuredClone(book.configuration!);
  edited.goal = "A different goal for future pipelines";
  await saveBookConfiguration(db, owner, bookId, book.revision, edited);
  const queued = await executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id });
  expect(queued).toMatchObject({ id: failed.id, status: "queued_resume" });
  const stages: string[] = [];
  await executeBookRun(db, failed.id, runtime(async (stage, input, output) => {
    stages.push(stage);
    expect(input.goal).toBe("A detailed network protocol tutorial");
    await validateBookModelAccess(db, owner.id, failed.id, input.evidence);
    return output;
  }));
  expect(stages).toEqual(["synthesize", "organize", "acceptance"]);
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("published");
  const after = await db.selectFrom("knowledge_book_node_runs").selectAll().where("run_id", "=", failed.id).where("node_id", "in", before.map(node => node.node_id)).execute();
  expect(after).toEqual(before);
  expect(await db.selectFrom("knowledge_book_runs").selectAll().where("book_id", "=", bookId).execute()).toHaveLength(1);
});

it("can fail and resume the same node repeatedly without duplicate node or repair-task records", async () => {
  await manual();
  const broken = runtime((stage, _input, output) => {
    if (stage === "synthesize") throw new Error("Still unavailable");
    return output;
  });
  const failed = await run(broken);
  const repair = (await listBookHumanTasks(db, owner, { bookId, runId: failed.id, kind: "repair", status: "pending" })).items[0]!;
  await resolveBookHumanTask(db, owner, repair.id, { expectedRevision: repair.revision, decision: "resume", note: "First repair attempt" });
  const earlierResolution = (await db.selectFrom("knowledge_book_human_tasks").select("resolution").where("id", "=", repair.id).executeTakeFirstOrThrow()).resolution;
  await executeBookRun(db, failed.id, broken);
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("failed");
  await executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id });
  await executeBookRun(db, failed.id, runtime());
  const trace = await readBookRun(db, owner, bookId, failed.id);
  expect(trace.status).toBe("published");
  expect(trace.logs.filter(log => log.code === "node_failed")).toHaveLength(2);
  expect(trace.nodes.filter(node => node.nodeId === "synthesize")).toHaveLength(1);
  expect(await db.selectFrom("knowledge_book_human_tasks").select("id").where("run_id", "=", failed.id).where("kind", "=", "repair").execute()).toHaveLength(1);
  const retained = await db.selectFrom("security_audit").select("details").where("action", "=", "knowledge_book.task_resolution_retained").executeTakeFirstOrThrow();
  expect(JSON.parse(retained.details).resolution).toBe(earlierResolution);
});

it("repairs rejected content without extracting every source again", async () => {
  await manual();
  const failed = await run(runtime((stage, input, output) => stage === "acceptance" ? {
    checks: input.criteria.map((criterion: any) => ({ criterionId: criterion.id, passed: false, reason: "Explain the supported mechanism" })),
  } : output));
  await executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id });
  const stages: string[] = [];
  await executeBookRun(db, failed.id, runtime((stage, input, output) => {
    stages.push(stage);
    if (stage === "organize") expect(input.priorReviews[0].reason).toBe("Explain the supported mechanism");
    return output;
  }));
  expect(stages).toEqual(["organize", "acceptance"]);
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("published");
});

it("refuses to reuse a checkpoint after its source inputs changed", async () => {
  await manual();
  const failed = await run(runtime((stage, _input, output) => {
    if (stage === "synthesize") throw new Error("Temporary failure");
    return output;
  }));
  await manual("Changed source facts");
  await expect(executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id })).rejects.toMatchObject({ status: 409 });
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("failed");
});

it("keeps full node output out of the pipeline projection", async () => {
  await manual();
  const result = await run();
  const full = await readBookRun(db, owner, bookId, result.id);
  const pipeline = await readBookRun(db, owner, bookId, result.id, "pipeline");
  expect(full.nodes[0]).toHaveProperty("output");
  expect(pipeline.nodes[0]).not.toHaveProperty("output");
  expect(pipeline.nodes[0]).not.toHaveProperty("inputRefs");
  expect(pipeline.status).toBe(full.status);
  expect(pipeline.logs).toEqual(full.logs);
});


it("keeps source evidence and dense provenance out of the authorized canvas payload", async () => {
  await manual();
  const result = await run();
  const canvas = await readBookPipeline(db, owner, bookId, result.id);
  expect(canvas.artifact?.pages.length).toBeGreaterThan(0);
  expect(canvas.artifact).not.toHaveProperty("evidence");
  expect(canvas.artifact).not.toHaveProperty("claims");
  expect(canvas.artifact).not.toHaveProperty("provenance");
});

it("records a repair-task resolution when continuing the same pipeline", async () => {
  await manual();
  const failed = await run(runtime((stage, _input, output) => {
    if (stage === "synthesize") throw new Error("Transient failure");
    return output;
  }));
  const task = (await listBookHumanTasks(db, owner, { bookId, runId: failed.id, kind: "repair", status: "pending" })).items[0]!;
  const queued = await resolveBookHumanTask(db, owner, task.id, { expectedRevision: task.revision, decision: "resume", note: "Model connection repaired" });
  expect(queued).toMatchObject({ id: failed.id });
  const resolved = (await listBookHumanTasks(db, owner, { bookId, runId: failed.id, kind: "repair", status: "resolved" })).items[0]!;
  expect(resolved.resolution).toMatchObject({ decision: "resume", note: "Model connection repaired" });
  await expect(resolveBookHumanTask(db, owner, task.id, { expectedRevision: task.revision, decision: "resume", note: "Duplicate" })).rejects.toMatchObject({ status: 409 });
});

it("requires original-source access before resuming another person's checkpoint", async () => {
  const document = await createContent(db).create(owner, { kind: "document", format: "markdown", title: "Private primary source", markdown: "Private protocol facts.", private: true });
  await executeBookCommand(db, owner, bookId, { operation: "source.save", expectedRevision: 0, title: "Private source", configuration: { version: 1, items: [{ id: "binding", kind: "document", resourceId: document.id }] }, status: "active" });
  const failed = await run(runtime((stage, _input, output) => { if (stage === "synthesize") throw new Error("Transient failure"); return output; }));
  await share("editor");
  await expect(executeBookCommand(db, collaborator, bookId, { operation: "run.resume", runId: failed.id })).rejects.toMatchObject({ status: 403 });
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("failed");
});

it("revalidates native source contents even when their registration is unchanged", async () => {
  const document = await createContent(db).create(owner, { kind: "document", format: "markdown", title: "Primary source", markdown: "Original protocol facts." });
  await executeBookCommand(db, owner, bookId, { operation: "source.save", expectedRevision: 0, title: "Primary source", configuration: { version: 1, items: [{ id: "binding", kind: "document", resourceId: document.id }] }, status: "active" });
  const failed = await run(runtime((stage, _input, output) => { if (stage === "synthesize") throw new Error("Transient failure"); return output; }));
  const state = await db.selectFrom("document_states").select("seq").where("resource_id", "=", document.id).executeTakeFirstOrThrow();
  await db.updateTable("document_states").set({ text: "Changed protocol facts.", seq: state.seq + 1 }).where("resource_id", "=", document.id).execute();
  await expect(executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id })).rejects.toMatchObject({ status: 409 });
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("failed");
});

it("refuses an incomplete checkpoint when a bound library gains another document", async () => {
  const content = createContent(db);
  const library = await content.create(owner, { kind: "library", format: "markdown", title: "Primary source library" });
  await content.create(owner, { kind: "document", format: "markdown", libraryId: library.id, title: "First protocol", markdown: "Original protocol facts." });
  await executeBookCommand(db, owner, bookId, { operation: "source.save", expectedRevision: 0, title: "Source library", configuration: { version: 1, items: [{ id: "binding", kind: "library", resourceId: library.id }] }, status: "active" });
  const failed = await run(runtime((stage, _input, output) => { if (stage === "synthesize") throw new Error("Transient failure"); return output; }));
  await content.create(owner, { kind: "document", format: "markdown", libraryId: library.id, title: "Another protocol", markdown: "Additional protocol facts." });
  await expect(executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id })).rejects.toMatchObject({ status: 409 });
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("failed");
});

it("keeps frozen-run audits independent of user-selected workflow node IDs", async () => {
  await manual();
  const book = await readKnowledgeBook(db, owner, bookId);
  const configuration = structuredClone(book.configuration!);
  configuration.workflow.nodes.find(node => node.id === "synthesize")!.id = "frozen-resume";
  configuration.workflow.edges = configuration.workflow.edges.map(edge => ({ source: edge.source === "synthesize" ? "frozen-resume" : edge.source, target: edge.target === "synthesize" ? "frozen-resume" : edge.target }));
  await saveBookConfiguration(db, owner, bookId, book.revision, configuration);
  const failed = await run(runtime((stage, _input, output) => { if (stage === "synthesize") throw new Error("Transient failure"); return output; }));
  await executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id });
  await executeBookRun(db, failed.id, runtime());
  expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("published");
});

it("reopens a reviewed content branch after quality repair and retains the earlier decision", async () => {
  await manual();
  const book = await readKnowledgeBook(db, owner, bookId);
  const config = structuredClone(book.configuration!);
  config.workflow.nodes.push({ id: "review", type: "human_review", label: "Review details", position: { x: 500, y: 200 }, parameters: { instructions: "Review revised content", sourceIds: [], criterionIds: [], sourceWeight: 1, feedbackWeight: 1 } });
  config.workflow.edges = config.workflow.edges.filter(edge => !(edge.source === "organize" && edge.target === "acceptance"));
  config.workflow.edges.push({ source: "organize", target: "review" }, { source: "review", target: "acceptance" });
  await saveBookConfiguration(db, owner, bookId, book.revision, config);
  const first = await run();
  const initial = (await listBookHumanTasks(db, owner, { bookId, runId: first.id, kind: "review", status: "pending" })).items[0]!;
  await resolveBookHumanTask(db, owner, initial.id, { expectedRevision: initial.revision, decision: "approve", note: "Initial review" });
  await executeBookRun(db, first.id, runtime((stage, input, output) => stage === "acceptance" ? { checks: input.criteria.map((criterion: any) => ({ criterionId: criterion.id, passed: false, reason: "Need deeper explanation" })) } : output));
  await executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: first.id });
  await executeBookRun(db, first.id, runtime());
  expect((await readBookRun(db, owner, bookId, first.id)).status).toBe("awaiting_input");
  const reopened = (await listBookHumanTasks(db, owner, { bookId, runId: first.id, kind: "review", status: "pending" })).items[0]!;
  expect(reopened.id).toBe(initial.id);
  expect(reopened.revision).toBeGreaterThan(initial.revision);
  await resolveBookHumanTask(db, owner, reopened.id, { expectedRevision: reopened.revision, decision: "approve", note: "Revised content approved" });
  const retained = await db.selectFrom("security_audit").select("details").where("action", "=", "knowledge_book.task_resolution_retained").executeTakeFirstOrThrow();
  expect(JSON.parse(JSON.parse(retained.details).resolution).note).toBe("Initial review");
  await executeBookRun(db, first.id, runtime());
  expect((await readBookRun(db, owner, bookId, first.id)).status).toBe("published");
});

it("recovers a worker interruption after resuming without duplicating its repair task", async () => {
  const { recoverBookRuns } = await import("@core/modules/knowledge-books/recovery.js");
  await manual();
  const failed = await run(runtime((stage, _input, output) => { if (stage === "synthesize") throw new Error("Transient failure"); return output; }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await executeBookCommand(db, owner, bookId, { operation: "run.resume", runId: failed.id });
    await db.updateTable("knowledge_book_runs").set({ status: "running", heartbeat_at: "2026-10-09T00:00:00.000Z", lease_id: randomUUID() }).where("id", "=", failed.id).execute();
    await db.updateTable("knowledge_book_node_runs").set({ status: "running" }).where("run_id", "=", failed.id).where("node_id", "=", "synthesize").execute();
    await recoverBookRuns(db, "2026-10-10T00:00:00.000Z");
    expect((await readBookRun(db, owner, bookId, failed.id)).status).toBe("failed");
    expect((await listBookHumanTasks(db, owner, { bookId, runId: failed.id, kind: "repair", status: "pending" })).items).toHaveLength(1);
  }
});
