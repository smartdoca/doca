import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { captureAIInputFileSnapshot } from "../apps/server/src/services/ai/ai-input-file-snapshot.js";
import {
  createImageBatchRequirements,
  bindImageBatchClarifications,
  imageBatchRequests,
  verifyImageBatchRequirements,
  imageBatchUserRequests,
  imageBatchReviewSources,
  imageBatchRequirementsSchema,
  batchClarificationInputSchema,
  type BatchRequirementContext,
  type BatchSource,
} from "../apps/server/src/services/ai/image-batch-requirements.js";

let db: Awaited<ReturnType<typeof openTestDatabase>>,
  userId: string,
  sessionId: string,
  ctx: BatchRequirementContext,
  actor: Actor,
  clock: number;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  userId = (
    await createUser(
      db,
      {
        login: "batch-owner",
        displayName: "Batch",
        password: "batch-isolated-2026",
      },
      { bootstrap: true },
    )
  ).id;
  actor = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  clock = Date.parse("2026-10-05T01:00:00Z");
  sessionId = await newSession(userId);
});
afterEach(async () => {
  await db.destroy();
});
async function newSession(owner: string) {
  const id = randomUUID(),
    now = new Date(clock).toISOString();
  await db
    .insertInto("ai_sessions")
    .values({
      id,
      user_id: owner,
      title: "Isolated batch",
      model_id: "test",
      resource_ids: "[]",
      archived: 0,
      revision: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}
async function userJob(
  text: string,
  input: object = {},
  options: { owner?: string; session?: string; result?: object } = {},
) {
  const id = randomUUID(),
    now = new Date((clock += 1000)).toISOString(),
    owner = options.owner ?? userId,
    session = options.session ?? sessionId;
  if (owner === userId)
    for (const assetId of (input as any).attachments ?? [])
      await attachmentFact(assetId);
  await db
    .insertInto("ai_jobs")
    .values({
      id,
      session_id: session,
      user_id: owner,
      model_id: "test",
      status: "completed",
      input: JSON.stringify({ text, ...input }),
      digest: id,
      result: JSON.stringify(options.result ?? {}),
      error: "",
      lease: null,
      lease_until: null,
      attempts: 1,
      cancelled: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (owner === userId && session === sessionId)
    ctx = { userId, actor, sessionId, currentJobId: id };
  return id;
}

async function attachmentFact(
  assetId: string,
  mime = "application/pdf",
  filename = "book.pdf",
) {
  if (
    await db
      .selectFrom("assets")
      .select("id")
      .where("id", "=", assetId)
      .executeTakeFirst()
  )
    return;
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .executeTakeFirstOrThrow();
  const objectId = randomUUID(),
    objectKey = `isolated/${assetId}`,
    now = new Date(clock).toISOString();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profile.id,
      object_key: objectKey,
      sha256: "a".repeat(64),
      size: 1,
      mime,
      created_at: now,
    })
    .execute();
  await db
    .insertInto("assets")
    .values({
      id: assetId,
      owner_id: userId,
      resource_id: null,
      purpose: "ai_attachment",
      profile_id: profile.id,
      object_key: objectKey,
      filename,
      mime,
      size: 1,
      created_at: now,
      deleted_at: null,
    })
    .execute();
}
function createRequirements(
  db: Awaited<ReturnType<typeof openTestDatabase>>,
  ctx: BatchRequirementContext,
  jobId: string,
  sources: BatchSource[],
  criteria: string[],
  clarifications: {
    jobId: string;
    scope: "batch" | "general";
    question?: { jobId: string; id: string };
  }[] = [],
) {
  return createImageBatchRequirements(
    db,
    ctx,
    jobId,
    sources,
    "all-documents",
    criteria,
    clarifications,
  );
}

it("lists only formal requests explicitly associated with all selected sources, without choosing the latest short clarification", async () => {
  const assetId = randomUUID(),
    otherId = randomUUID();
  const original = await userJob(
    "Real people; every background pixel unchanged",
    { attachments: [assetId] },
  );
  await userJob("Other task with other files", { attachments: [otherId] });
  const choice = await userJob("Kipper");
  const list = await imageBatchRequests(db, ctx, [{ assetId }]);
  expect(list.currentJobId).toBe(choice);
  expect(list.requests).toEqual([
    expect.objectContaining({
      jobId: original,
      rootJobId: original,
      messageId: original,
      text: "Real people; every background pixel unchanged",
    }),
  ]);
  expect(list.requests[0]?.allDocuments).toMatchObject({
    available: true,
    targetSources: [{ source: { assetId } }],
  });
  await expect(
    createRequirements(db, ctx, choice, [{ assetId }], []),
  ).rejects.toThrow(/正式请求中的全部文档附件/);
  await expect(
    createRequirements(
      db,
      ctx,
      original,
      [{ assetId }, { assetId: otherId }],
      [],
    ),
  ).rejects.toThrow(/必须精确登记/);
});

it("retains exact original and more than six scoped clarifications after refresh while excluding future general guidance", async () => {
  const assetId = randomUUID(),
    text = "真人替换；背景、狗、朋友、房屋完全不变，和原图一模一样。";
  const original = await userJob(text, { attachments: [assetId] });
  const inputs = [];
  for (let n = 0; n < 9; n++)
    inputs.push({
      jobId: await userJob(`本批确认 ${n}：仍按原始严格要求`),
      scope: "batch" as const,
    });
  const general = await userJob(
    "FUTURE_ONLY_MARKER：未来普通图片允许细微变化，本条只适用未来任务",
  );
  inputs.push({ jobId: general, scope: "general" as any });
  const criteria = ["All protected pixels unchanged", "Real people"];
  const snapshot = await createRequirements(
    db,
    ctx,
    original,
    [{ assetId }],
    criteria,
    inputs,
  );
  criteria[0] = "execution plan subsequently got weaker";
  const restored = imageBatchRequirementsSchema.parse(
    JSON.parse(JSON.stringify(snapshot)),
  );
  await userJob("继续");
  await verifyImageBatchRequirements(db, ctx, restored);
  const requests = imageBatchUserRequests(restored);
  expect(requests[0]).toBe(text);
  expect(requests[0]).not.toContain(original);
  expect(requests).toHaveLength(10);
  expect(imageBatchReviewSources(restored).userRequestMetadata).toMatchObject({
    nonCitable: true,
    requests: [
      { requestIndex: 0, kind: "original", jobId: original, boundToRootJobId: null, question: null },
      ...inputs.slice(0, 9).map((item, index) => ({
        requestIndex: index + 1, kind: "batch-clarification", jobId: item.jobId,
        boundToRootJobId: original, question: null,
      })),
    ],
  });
  expect(requests.join("\n")).toContain("本批确认 0");
  expect(requests.join("\n")).toContain("本批确认 8");
  expect(requests.join("\n")).not.toContain("FUTURE_ONLY_MARKER");
  expect(restored.criteria).toEqual([
    "All protected pixels unchanged",
    "Real people",
  ]);
  expect(restored.clarifications).toHaveLength(10);
});

it("keeps exact citable UTF16 bodies and detached non-citable facts without altering stored input or SHA", async () => {
  const assetId = randomUUID(), questionId = randomUUID();
  const originalText = "  全部人物🙂替换；其余保留。\r\n文字不变。\t ";
  const answerText = " \r\nKipper🙂  \t\r\n";
  const questionTitle = "HOST_QUESTION_ONLY：谁变成Zeze，允许改背景？";
  const generalText = "GENERAL_ONLY：未来任务可以自由重画。";
  const original = await userJob(originalText, { attachments: [assetId] }, {
    result: { progress: { questions: [{ id: questionId, title: questionTitle, options: ["Kipper", "Chip"] }] } },
  });
  const answer = await userJob(answerText), general = await userJob(generalText);
  const requirements = await createRequirements(db, ctx, original, [{ assetId }], ["实际人物及文字"], [
    { jobId: general, scope: "general" },
    { jobId: answer, scope: "batch", question: { jobId: original, id: questionId } },
  ]);
  const before = JSON.stringify(requirements);
  const inputRows = await db.selectFrom("ai_jobs").select(["id", "input", "result", "digest"]).orderBy("id").execute();
  const storageRows = await db.selectFrom("file_storage_objects").select(["id", "sha256"]).orderBy("id").execute();
  await verifyImageBatchRequirements(db, ctx, requirements);
  const sources = imageBatchReviewSources(requirements);
  expect(sources.userRequests).toEqual([originalText, answerText]);
  expect(sources.userRequests.map(text => Buffer.from(text, "utf16le"))).toEqual(
    [originalText, answerText].map(text => Buffer.from(text, "utf16le")),
  );
  expect(sources.userRequestMetadata).toMatchObject({
    nonCitable: true,
    requests: [
      { requestIndex: 0, kind: "original", jobId: original, rootJobId: original, messageId: original,
        boundToRootJobId: null, question: null },
      { requestIndex: 1, kind: "batch-clarification", jobId: answer, rootJobId: answer, messageId: answer,
        boundToRootJobId: original, question: { jobId: original, id: questionId, title: questionTitle, options: ["Kipper", "Chip"] } },
    ],
  });
  for (const nonUserText of [questionTitle, original, answer, generalText, "【作用域规则】", ...sources.userRequestMetadata.rules])
    expect(sources.userRequests.some(text => text.includes(nonUserText))).toBe(false);
  expect(sources.userRequestMetadata.requests.some(item => item.jobId === general)).toBe(false);
  const question = sources.userRequestMetadata.requests[1]!.question!;
  question.title = "Changed transient projection";
  question.options[0] = "Changed transient choice";
  sources.userRequestMetadata.rules[0] = "Changed transient rule";
  expect(JSON.stringify(requirements)).toBe(before);
  expect(await db.selectFrom("ai_jobs").select(["id", "input", "result", "digest"]).orderBy("id").execute()).toEqual(inputRows);
  expect(await db.selectFrom("file_storage_objects").select(["id", "sha256"]).orderBy("id").execute()).toEqual(storageRows);
  await verifyImageBatchRequirements(db, ctx, requirements);
});

it("reads host-owned user input instead of generated notes, tool results or compressed history and detects snapshot tampering", async () => {
  const assetId = randomUUID();
  const original = await userJob(
    "Strict original text",
    { attachments: [assetId] },
    {
      result: {
        progress: { text: "FAKE_TOOL_REQUEST_MARKER" },
        checkpoint: {
          messages: [{ role: "user", content: "WEAK_SUMMARY_MARKER" }],
        },
      },
    },
  );
  const requirements = await createRequirements(
    db,
    ctx,
    original,
    [{ assetId }],
    ["Strict"],
  );
  expect(JSON.stringify(requirements)).not.toContain(
    "FAKE_TOOL_REQUEST_MARKER",
  );
  expect(JSON.stringify(requirements)).not.toContain("WEAK_SUMMARY_MARKER");
  await expect(
    verifyImageBatchRequirements(db, ctx, {
      ...requirements,
      original: { ...requirements.original, text: "Weak machine rewrite" },
    }),
  ).rejects.toThrow(/与持久记录不一致/);
  const raw = (
    await db
      .selectFrom("ai_jobs")
      .select("input")
      .where("id", "=", original)
      .executeTakeFirstOrThrow()
  ).input;
  expect(JSON.parse(raw).text).toBe("Strict original text");
  await db
    .updateTable("ai_jobs")
    .set({
      input: JSON.stringify({ attachments: [assetId], toolText: "not a user" }),
    })
    .where("id", "=", original)
    .execute();
  await expect(
    verifyImageBatchRequirements(db, ctx, requirements),
  ).rejects.toThrow(/没有可验证的正式用户请求/);
});

it("rejects cross-account/session sources and future records without reading their raw text", async () => {
  const admin = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const assetId = randomUUID(),
    other = (
      await createUser(
        db,
        {
          login: "batch-other",
          displayName: "Other",
          password: "batch-other-isolated",
        },
        { actor: admin },
      )
    ).id;
  const otherSession = await newSession(other),
    ownOtherSession = await newSession(userId);
  const foreign = await userJob(
    "FOREIGN_PRIVATE",
    { attachments: [assetId] },
    { owner: other, session: otherSession },
  );
  const wrongSession = await userJob(
    "WRONG_SESSION_PRIVATE",
    { attachments: [assetId] },
    { session: ownOtherSession },
  );
  const original = await userJob("Own request", { attachments: [assetId] });
  const oldCtx = { ...ctx };
  const future = await userJob("future", { attachments: [assetId] });
  for (const id of [foreign, wrongSession])
    await expect(
      createRequirements(db, ctx, id, [{ assetId }], []),
    ).rejects.toThrow(/不属于当前账号、会话/);
  await expect(
    createRequirements(db, oldCtx, future, [{ assetId }], []),
  ).rejects.toThrow(/本轮之后/);
  expect(
    (await imageBatchRequests(db, ctx, [{ assetId }])).requests.map(
      (item) => item.jobId,
    ),
  ).toEqual([future, original]);
});

it("keeps automatic retry roots separate from explicit original task selection and rejects changed retry text", async () => {
  const assetId = randomUUID(),
    original = await userJob("Original task", { attachments: [assetId] });
  const retry = await userJob("Original task", {
    attachments: [assetId],
    retryOf: original,
  });
  const chosen = await createRequirements(db, ctx, retry, [{ assetId }], []);
  expect(chosen.original).toMatchObject({
    jobId: retry,
    rootJobId: original,
    text: "Original task",
  });
  const changed = await userJob("Kipper", {
    attachments: [assetId],
    retryOf: retry,
  });
  await expect(
    createRequirements(db, ctx, changed, [{ assetId }], []),
  ).rejects.toThrow(/重试原文与来源不一致/);
});

it("binds a real ask_user receipt and exact reply text to the selected task, rejecting unrelated questions", async () => {
  const assetId = randomUUID(),
    questionId = randomUUID();
  const original = await userJob(
    "Full original task",
    { attachments: [assetId] },
    {
      result: {
        progress: {
          questions: [
            {
              id: questionId,
              title: "Who becomes Zeze?",
              options: ["Kipper", "Chip"],
            },
          ],
        },
      },
    },
  );
  const requirements = await createRequirements(
    db,
    ctx,
    original,
    [{ assetId }],
    ["Full body replacement"],
  );
  const unrelatedQuestionId = randomUUID(),
    unrelated = await userJob(
      "Unrelated task",
      {},
      {
        result: {
          progress: {
            questions: [
              {
                id: unrelatedQuestionId,
                title: "Other question",
                options: ["A", "B"],
              },
            ],
          },
        },
      },
    );
  const reply = await userJob("Kipper");
  const binding = {
    jobId: reply,
    scope: "batch" as const,
    question: { jobId: original, id: questionId },
  };
  const bound = await bindImageBatchClarifications(
    db,
    ctx,
    requirements,
    original,
    [binding],
  );
  expect(bound.clarifications[0]).toMatchObject({
    source: { jobId: reply, text: "Kipper" },
    boundToRootJobId: original,
    question: { title: "Who becomes Zeze?" },
  });
  await expect(
    bindImageBatchClarifications(db, ctx, requirements, original, [
      { ...binding, question: { jobId: unrelated, id: unrelatedQuestionId } },
    ]),
  ).rejects.toThrow(/没有绑定当前批次/);
  await expect(
    bindImageBatchClarifications(db, ctx, requirements, original, [
      { ...binding, question: { jobId: original, id: randomUUID() } },
    ]),
  ).rejects.toThrow(/回执不存在/);
  await db
    .updateTable("ai_jobs")
    .set({
      result: JSON.stringify({
        progress: {
          questions: [
            {
              id: questionId,
              title: "Changed question",
              options: ["Kipper", "Chip"],
            },
          ],
        },
      }),
    })
    .where("id", "=", original)
    .execute();
  await expect(verifyImageBatchRequirements(db, ctx, bound)).rejects.toThrow(
    /提问回执已改变/,
  );
});

it("allows a later batch-bound question while freezing its scope, and keeps direct confirmations as their actual words", async () => {
  const assetId = randomUUID(),
    original = await userJob("Original", { attachments: [assetId] });
  const requirements = await createRequirements(
    db,
    ctx,
    original,
    [{ assetId }],
    [],
  );
  const questionId = randomUUID(),
    asked = await userJob(
      "Continue batch",
      {},
      {
        result: {
          checkpoint: { imageBatch: { version: 2, requirements } },
          progress: {
            questions: [
              {
                id: questionId,
                title: "Confirm this batch?",
                options: ["Yes", "No"],
              },
            ],
          },
        },
      },
    );
  const reply = await userJob("本次仍严格，人物必须全身真人。");
  const input = {
    jobId: reply,
    scope: "batch" as const,
    question: { jobId: asked, id: questionId },
  };
  const bound = await bindImageBatchClarifications(
    db,
    ctx,
    requirements,
    original,
    [input],
  );
  expect(
    await bindImageBatchClarifications(db, ctx, bound, original, [input]),
  ).toEqual(bound);
  await expect(
    bindImageBatchClarifications(db, ctx, bound, original, [
      { jobId: reply, scope: "general" },
    ]),
  ).rejects.toThrow(/不能被重新解释/);
  await expect(
    bindImageBatchClarifications(db, ctx, requirements, asked, [input]),
  ).rejects.toThrow(/原始 taskJobId/);
  expect(
    batchClarificationInputSchema.safeParse({
      ...input,
      text: "invented wording",
    }).success,
  ).toBe(false);
  const direct = await userJob(
    "这是当前任务的明确更改：只改脸，其他依照原要求。",
  );
  const updated = await bindImageBatchClarifications(db, ctx, bound, original, [
    { jobId: direct, scope: "batch" },
  ]);
  expect(imageBatchUserRequests(updated).join("\n")).toContain(
    "这是当前任务的明确更改：只改脸，其他依照原要求。",
  );
  expect(updated.criteria).toEqual(bound.criteria);
});

it("rejects old folder references without a complete original snapshot instead of reconstructing past scope from current contents", async () => {
  const now = new Date(clock).toISOString(),
    folder = randomUUID(),
    child = randomUUID(),
    file = randomUUID(),
    object = randomUUID();
  await db
    .insertInto("file_folders")
    .values([
      {
        id: folder,
        owner_id: userId,
        parent_id: null,
        name: "Input",
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      },
      {
        id: child,
        owner_id: userId,
        parent_id: folder,
        name: "Nested",
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      },
    ])
    .execute();
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: object,
      profile_id: profile.id,
      object_key: `isolated/${object}`,
      sha256: "a".repeat(64),
      size: 1,
      mime: "application/pdf",
      created_at: now,
    })
    .execute();
  await db
    .insertInto("file_items")
    .values({
      id: file,
      owner_id: userId,
      parent_type: "folder",
      parent_id: child,
      storage_object_id: object,
      name: "book.pdf",
      mime: "application/pdf",
      size: 1,
      metadata: "{}",
      ai_description_override: null,
      locked: 0,
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  const original = await userJob("Process this uploaded folder", {
    files: [{ kind: "folder", id: folder }],
  });
  await expect(
    createRequirements(db, ctx, original, [{ fileId: file }], []),
  ).rejects.toThrow(/文件来源快照/);
  const misleading = await userJob("Continue", {
    currentFolder: { type: "folder", id: folder },
  });
  await expect(
    createRequirements(db, ctx, misleading, [{ fileId: file }], []),
  ).rejects.toThrow(/正式请求中的全部文档附件/);
  await db
    .updateTable("file_items")
    .set({ parent_type: "system", parent_id: "root" })
    .where("id", "=", file)
    .execute();
  await expect(
    createRequirements(db, ctx, original, [{ fileId: file }], []),
  ).rejects.toThrow(/文件来源快照/);
});

it("paginates request discovery across many unrelated turns while retaining the original source in durable storage", async () => {
  const assetId = randomUUID(),
    original = await userJob("Original must remain discoverable", {
      attachments: [assetId],
    });
  for (let n = 0; n < 51; n++) await userJob(`Unrelated ${n}`);
  const first = await imageBatchRequests(db, ctx, [{ assetId }]);
  expect(first.requests).toEqual([]);
  expect(first.nextOffset).toBe(50);
  const next = await imageBatchRequests(
    db,
    ctx,
    [{ assetId }],
    first.nextOffset!,
  );
  expect(next.requests.map((item) => item.jobId)).toEqual([original]);
  expect(next.nextOffset).toBeNull();
});

it("requires every original document exactly once while classifying photos as references without interpreting people", async () => {
  const one = randomUUID(),
    two = randomUUID(),
    photo = randomUUID(),
    note = randomUUID();
  await attachmentFact(photo, "image/png", "uninterpreted-person.png");
  await attachmentFact(note, "text/plain", "requirements.txt");
  const job = await userJob("处理全部文档，照片提供人物参考；背景完全不变", {
    attachments: [one, two, photo, note],
  });
  await expect(
    createRequirements(db, ctx, job, [{ assetId: one }], []),
  ).rejects.toThrow(/必须精确登记/);
  await expect(
    createRequirements(
      db,
      ctx,
      job,
      [{ assetId: one }, { assetId: two }, { assetId: photo }],
      [],
    ),
  ).rejects.toThrow(/加入参考图片均拒绝/);
  await expect(
    createRequirements(db, ctx, job, [{ assetId: one }, { assetId: one }], []),
  ).rejects.toThrow(/必须精确登记/);
  const complete = await createRequirements(
    db,
    ctx,
    job,
    [{ assetId: two }, { assetId: one }],
    [],
  );
  expect(complete.scope.selection).toBe("all-documents");
  expect(complete.scope.inputManifest.map((item) => item.role)).toEqual([
    "target",
    "target",
    "reference",
    "context",
  ]);
  expect(complete.sources.map((item) => item.source.assetId)).toEqual([
    two,
    one,
  ]);
  expect(
    imageBatchRequirementsSchema.safeParse({ ...complete, scope: undefined })
      .success,
  ).toBe(false);
  await expect(
    createImageBatchRequirements(
      db,
      ctx,
      job,
      [{ assetId: one }, { assetId: two }],
      "explicit-targets" as any,
      [],
      [],
    ),
  ).rejects.toThrow(/只支持 all-documents/);
});

it("keeps scope immutable and refuses removed inputs or changed original storage facts without filling a missing scope", async () => {
  const assetId = randomUUID(),
    job = await userJob("All documents", { attachments: [assetId] });
  const original = await createRequirements(db, ctx, job, [{ assetId }], []);
  const invalidScope = {
    ...original.scope,
    inputManifest: original.scope.inputManifest.map((item) => ({
      ...item,
      filename: "invented.pdf",
    })),
  };
  await expect(
    verifyImageBatchRequirements(db, ctx, { ...original, scope: invalidScope }),
  ).rejects.toThrow(/与持久记录不一致/);
  await db
    .updateTable("assets")
    .set({ deleted_at: new Date(clock).toISOString() })
    .where("id", "=", assetId)
    .execute();
  await expect(verifyImageBatchRequirements(db, ctx, original)).rejects.toThrow(
    /无法核验完整文档范围/,
  );
  expect(original.scope.inputManifest[0]?.filename).toBe("book.pdf");
});

it("freezes all Doca folder documents from its host snapshot, exposes full target IDs and excludes files added later", async () => {
  const now = new Date(clock).toISOString(),
    folderId = randomUUID();
  await db
    .insertInto("file_folders")
    .values({
      id: folderId,
      owner_id: userId,
      parent_id: null,
      name: "Books",
      version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  const profile = await db
    .selectFrom("storage_profiles")
    .select("id")
    .executeTakeFirstOrThrow();
  async function addFile(mime: string, name: string) {
    const fileId = randomUUID(),
      objectId = randomUUID();
    await db
      .insertInto("file_storage_objects")
      .values({
        id: objectId,
        profile_id: profile.id,
        object_key: `isolated/${objectId}`,
        sha256: "a".repeat(64),
        size: 1,
        mime,
        created_at: now,
      })
      .execute();
    await db
      .insertInto("file_items")
      .values({
        id: fileId,
        owner_id: userId,
        parent_type: "folder",
        parent_id: folderId,
        storage_object_id: objectId,
        name,
        mime,
        size: 1,
        metadata: "{}",
        ai_description_override: null,
        locked: 0,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      })
      .execute();
    return fileId;
  }
  const one = await addFile("application/pdf", "first.pdf"),
    two = await addFile("application/pdf", "second.pdf"),
    image = await addFile("image/png", "reference.png");
  const files = [{ kind: "folder" as const, id: folderId }];
  const fileInputSnapshot = await captureAIInputFileSnapshot(db, actor, files);
  const job = await userJob(
    "Process all folder documents, using images as identity references",
    { files, fileInputSnapshot },
  );
  const future = await addFile("application/pdf", "added-later.pdf");
  await expect(
    createRequirements(db, ctx, job, [{ fileId: one }], []),
  ).rejects.toThrow(/必须精确登记/);
  await expect(
    createRequirements(
      db,
      ctx,
      job,
      [{ fileId: one }, { fileId: two }, { fileId: future }],
      [],
    ),
  ).rejects.toThrow(/必须精确登记/);
  const complete = await createRequirements(
    db,
    ctx,
    job,
    [{ fileId: one }, { fileId: two }],
    [],
  );
  expect(
    complete.scope.inputManifest.map((item) => item.source.fileId).sort(),
  ).toEqual([one, two, image].sort());
  expect(
    complete.scope.inputManifest.find((item) => item.source.fileId === image)
      ?.role,
  ).toBe("reference");
  expect(
    complete.sources.every(
      (item) =>
        item.inputReference.kind === "folder" &&
        item.inputReference.id === folderId,
    ),
  ).toBe(true);
  const requests = await imageBatchRequests(db, ctx, [{ fileId: one }]);
  expect(requests.requests[0]?.allDocuments.available).toBe(true);
  expect(
    (requests.requests[0]?.allDocuments as any).targetSources
      .map((item: any) => item.source.fileId)
      .sort(),
  ).toEqual([one, two].sort());
  await db
    .updateTable("file_items")
    .set({ version: 2 })
    .where("id", "=", one)
    .execute();
  await expect(verifyImageBatchRequirements(db, ctx, complete)).rejects.toThrow(
    /已发生变化/,
  );
  expect(fileInputSnapshot.files).toHaveLength(3);
});
