import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  knowledgeManagementView,
  cancelKnowledgeCuration,
  knowledgeInstructions,
  saveKnowledgeInstruction,
  saveKnowledgeSettings,
  saveHumanKnowledge,
  reviewKnowledgeEntry,
  queueKnowledgeCuration,
  executeKnowledgeCuration,
  knowledgeSourceReviews,
  knowledgeEntries,
  knowledgeOutlineGaps,
  projectPublishedKnowledge,
  saveKnowledgeAssistant,
  searchKnowledgeAssistant,
  detachKnowledgeSource,
  type CurationGenerator,
} from "@core/modules/knowledge/system.js";
let db: DB, alice: Actor, bob: Actor, library: string;
const now = () => new Date().toISOString();
async function resource(owner: Actor, kind: "document" | "library", text = "") {
  const id = randomUUID();
  await db
    .insertInto("resources")
    .values({
      id,
      kind,
      format: "markdown",
      title: kind,
      owner_id: owner.id,
      library_id: null,
      parent_id: null,
      access_mode: "custom",
      visibility: "invited",
      version: 1,
      deleted_at: null,
      delete_batch: null,
      created_at: now(),
      updated_at: now(),
      ai_curated: 1,
    })
    .execute();
  if (kind === "document")
    await db
      .insertInto("document_states")
      .values({
        resource_id: id,
        codec: "test",
        checkpoint: "",
        checkpoint_seq: 1,
        seq: 1,
        text,
        updated_at: now(),
      })
      .execute();
  return id;
}
async function subscribe(text = "Protocol knowledge with a stable version.") {
  const sourceId = await resource(alice, "document", text),
    id = randomUUID();
  await db
    .insertInto("knowledge_subscriptions")
    .values({
      id,
      library_id: library,
      creator_id: alice.id,
      source_kind: "document",
      source_id: sourceId,
      url: "",
      node_id: null,
      source_version: "1",
      status: "active",
      created_at: now(),
    })
    .execute();
  return { id, sourceId };
}
async function generate(
  sourceId: string,
  text = "Protocol knowledge is independent of source access.",
) {
  const run = await queueKnowledgeCuration(db, alice, library);
  const generator: CurationGenerator = async () => ({
    entries: [
      {
        title: "Protocol",
        markdown: text,
        sourceIds: [sourceId],
        reason: "KNOWLEDGE.md: independent knowledge",
      },
    ],
    notes: "",
  });
  await executeKnowledgeCuration(db, run.id, generator);
  const row = await db
    .selectFrom("knowledge_runs")
    .selectAll()
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  expect(row.status, row.detail).toBe("awaiting_review");
  return (await knowledgeEntries(db, alice, library))[0]!;
}
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const users = ["alice", "bob"].map((login) => ({
    id: randomUUID(),
    login,
    display_name: login,
    password_hash: "unused",
    admin: 0,
    status: "active",
    created_at: now(),
  }));
  await db.insertInto("users").values(users).execute();
  alice = users[0]!;
  bob = users[1]!;
  library = await resource(alice, "library");
});
afterEach(async () => {
  await db.destroy();
});
it("keeps Markdown skill history and rejects stale, foreign, and unsafe-path writes", async () => {
  const bundle = await knowledgeInstructions(db, alice, library);
  expect(bundle.files[0]!.path).toBe("KNOWLEDGE.md");
  await saveKnowledgeInstruction(db, alice, library, {
    path: "KNOWLEDGE.md",
    markdown: "Deduplicate by the ID in this guide.",
    expectedRevision: 0,
  });
  await expect(
    saveKnowledgeInstruction(db, alice, library, {
      path: "KNOWLEDGE.md",
      markdown: "stale",
      expectedRevision: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    saveKnowledgeInstruction(db, bob, library, {
      path: "KNOWLEDGE.md",
      markdown: "foreign",
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    saveKnowledgeInstruction(db, alice, library, {
      path: "../SECRET.md",
      markdown: "bad",
      expectedRevision: 0,
    }),
  ).rejects.toMatchObject({ status: 400 });
  await saveKnowledgeInstruction(db, alice, library, {
    path: "KNOWLEDGE.md",
    markdown: "Different rule",
    expectedRevision: 1,
  });
  expect(
    await db
      .selectFrom("knowledge_instructions")
      .selectAll()
      .where("library_id", "=", library)
      .execute(),
  ).toHaveLength(2);
});
it("retains independently searchable knowledge after all sources disappear and suppresses retained reminders", async () => {
  const source = await subscribe();
  const entry = await generate(source.id);
  await reviewKnowledgeEntry(
    db,
    alice,
    library,
    entry.id,
    entry.revision,
    "publish",
  );
  const bot = await saveKnowledgeAssistant(db, alice, {
    expectedRevision: 0,
    title: "Company",
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
  });
  const before = await searchKnowledgeAssistant(db, bob, bot.id, "Protocol");
  expect(before.items).toHaveLength(1);
  expect(before.items[0]).not.toHaveProperty("documentUrl");
  await db
    .deleteFrom("document_states")
    .where("resource_id", "=", source.sourceId)
    .execute();
  await db
    .deleteFrom("knowledge_subscriptions")
    .where("id", "=", source.id)
    .execute();
  await db.deleteFrom("resources").where("id", "=", source.sourceId).execute();
  expect(await searchKnowledgeAssistant(db, bob, bot.id, "Protocol")).toEqual(
    before,
  );
  const reviews = await knowledgeSourceReviews(db, alice, library);
  expect(reviews).toHaveLength(1);
  await reviewKnowledgeEntry(
    db,
    alice,
    library,
    entry.id,
    reviews[0]!.revision,
    "keep",
  );
  expect(await knowledgeSourceReviews(db, alice, library)).toEqual([]);
  expect(await searchKnowledgeAssistant(db, bob, bot.id, "Protocol")).toEqual(
    before,
  );
});
it("does not flag human writing as missing evidence and preserves AI lineage after human revision", async () => {
  const manual = await saveHumanKnowledge(db, alice, library, {
    title: "Manual",
    markdown: "A human observation",
    expectedRevision: 0,
  });
  expect(manual.origin).toBe("human_authored");
  expect(await knowledgeSourceReviews(db, alice, library)).toEqual([]);
  const source = await subscribe();
  const ai = await generate(source.id);
  const edited = await saveHumanKnowledge(db, alice, library, {
    id: ai.id,
    title: ai.title,
    markdown: "Human correction",
    expectedRevision: ai.revision,
  });
  expect(edited.origin).toBe("human_revised");
  expect(edited.sourceRefs).toHaveLength(1);
  expect(
    await db
      .selectFrom("knowledge_entry_versions")
      .selectAll()
      .where("entry_id", "=", ai.id)
      .execute(),
  ).toHaveLength(2);
});
it("applies safety before the model and search; never persists raw source bodies in runs", async () => {
  const source = await subscribe(
    "Protocol contact private@example.com and SecretName.",
  );
  await saveKnowledgeSettings(db, alice, library, 0, {
    redactContacts: true,
    redactedTerms: ["SecretName"],
  });
  const run = await queueKnowledgeCuration(db, alice, library);
  const generator = vi.fn<CurationGenerator>(async (input) => {
    expect(JSON.stringify(input)).not.toContain("private@example.com");
    expect(JSON.stringify(input)).not.toContain("SecretName.");
    return {
      entries: [
        {
          title: "Protocol",
          markdown: "Protocol SecretName private@example.com",
          sourceIds: [source.id],
          reason: "rule",
        },
      ],
      notes: "",
    };
  });
  await executeKnowledgeCuration(db, run.id, generator);
  expect(generator).toHaveBeenCalledOnce();
  const [entry] = await knowledgeEntries(db, alice, library);
  expect(entry!.markdown).not.toContain("SecretName");
  expect(entry!.markdown).not.toContain("private@example.com");
  const savedRun = await db
    .selectFrom("knowledge_runs")
    .selectAll()
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  expect(savedRun.detail).not.toContain("private@example.com");
});
it("blocks publication when instructions change while preserving all existing knowledge", async () => {
  const source = await subscribe(),
    draft = await generate(source.id);
  await saveKnowledgeInstruction(db, alice, library, {
    path: "KNOWLEDGE.md",
    expectedRevision: 0,
    markdown: "New rule",
  });
  await expect(
    reviewKnowledgeEntry(
      db,
      alice,
      library,
      draft.id,
      draft.revision,
      "publish",
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await knowledgeEntries(db, alice, library))[0]!.status).toBe("draft");
});
it("fails a run if permissions are revoked during model execution, without saving output", async () => {
  const source = await subscribe();
  const run = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, run.id, async () => {
    await db
      .updateTable("resources")
      .set({ owner_id: bob.id })
      .where("id", "=", source.sourceId)
      .execute();
    return {
      entries: [
        {
          title: "Protocol",
          markdown: "Late output",
          sourceIds: [source.id],
          reason: "rule",
        },
      ],
      notes: "",
    };
  });
  expect(
    (
      await db
        .selectFrom("knowledge_runs")
        .selectAll()
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("failed");
  expect(await knowledgeEntries(db, alice, library)).toEqual([]);
});
it("supports multi-library search without exposing drafts or granting source access", async () => {
  const first = await saveHumanKnowledge(db, alice, library, {
    title: "Protocol A",
    markdown: "Protocol A fact",
    expectedRevision: 0,
  });
  await reviewKnowledgeEntry(db, alice, library, first.id, 1, "publish");
  const secondLibrary = await resource(alice, "library");
  const second = await saveHumanKnowledge(db, alice, secondLibrary, {
    title: "Protocol B",
    markdown: "Protocol B fact",
    expectedRevision: 0,
  });
  const bot = await saveKnowledgeAssistant(db, alice, {
    expectedRevision: 0,
    title: "Multi",
    libraryIds: [library, secondLibrary],
    memberIds: [bob.id],
    enabled: true,
  });
  expect(
    (await searchKnowledgeAssistant(db, bob, bot.id, "Protocol")).items,
  ).toHaveLength(1);
  await reviewKnowledgeEntry(db, alice, secondLibrary, second.id, 1, "publish");
  expect(
    (await searchKnowledgeAssistant(db, bob, bot.id, "Protocol")).items,
  ).toHaveLength(2);
  await saveKnowledgeAssistant(db, alice, {
    id: bot.id,
    expectedRevision: 1,
    title: "Multi",
    libraryIds: [library, secondLibrary],
    memberIds: [],
    enabled: true,
  });
  await expect(
    searchKnowledgeAssistant(db, bob, bot.id, "Protocol"),
  ).rejects.toMatchObject({ status: 404 });
});
it("excluded and detached sources do not reach the model, and queued runs are claimed once", async () => {
  const source = await subscribe();
  await detachKnowledgeSource(db, alice, library, source.id);
  const run = await queueKnowledgeCuration(db, alice, library);
  const model = vi.fn<CurationGenerator>();
  await Promise.all([
    executeKnowledgeCuration(db, run.id, model),
    executeKnowledgeCuration(db, run.id, model),
  ]);
  expect(model).not.toHaveBeenCalled();
});

it("keeps published answers until a human replacement is explicitly published", async () => {
  const original = await saveHumanKnowledge(db, alice, library, {
    title: "Protocol",
    markdown: "Old stable fact",
    expectedRevision: 0,
  });
  await reviewKnowledgeEntry(db, alice, library, original.id, 1, "publish");
  const bot = await saveKnowledgeAssistant(db, alice, {
    title: "Bot",
    expectedRevision: 0,
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
  });
  const draft = await saveHumanKnowledge(db, alice, library, {
    id: original.id,
    title: "Protocol",
    markdown: "New reviewed fact",
    expectedRevision: 2,
  });
  expect(draft.id).not.toBe(original.id);
  expect(
    (await searchKnowledgeAssistant(db, bob, bot.id, "Protocol")).items[0]!
      .excerpt,
  ).toContain("Old stable fact");
  await reviewKnowledgeEntry(db, alice, library, draft.id, 1, "publish");
  const results = (await searchKnowledgeAssistant(db, bob, bot.id, "Protocol"))
    .items;
  expect(results).toHaveLength(1);
  expect(results[0]!.excerpt).toContain("New reviewed fact");
});
it("rejects content changed during generation and leaves no draft", async () => {
  const source = await subscribe();
  const run = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, run.id, async () => {
    await db
      .updateTable("document_states")
      .set({ seq: 2, text: "new version" })
      .where("resource_id", "=", source.sourceId)
      .execute();
    return {
      entries: [
        {
          title: "Stale",
          markdown: "Outdated",
          sourceIds: [source.id],
          reason: "",
        },
      ],
      notes: "",
    };
  });
  expect(await knowledgeEntries(db, alice, library)).toHaveLength(0);
  expect(
    (
      await db
        .selectFrom("knowledge_runs")
        .select("status")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("failed");
});
it("cancels a running task without publishing its late result", async () => {
  const source = await subscribe();
  const run = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, run.id, async () => {
    await cancelKnowledgeCuration(db, alice, library, run.id);
    return {
      entries: [
        {
          title: "Canceled",
          markdown: "Late",
          sourceIds: [source.id],
          reason: "",
        },
      ],
      notes: "",
    };
  });
  expect(await knowledgeEntries(db, alice, library)).toHaveLength(0);
  expect(
    (
      await db
        .selectFrom("knowledge_runs")
        .select("status")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe("canceled");
});
it("skips unchanged material and combines library and source restrictions", async () => {
  const source = await subscribe(
    "Protocol: secret-local and secret-global; email test@example.com",
  );
  await saveKnowledgeSettings(db, alice, library, 0, {
    redactedTerms: ["secret-global"],
    sourcePolicies: {
      [source.id]: {
        redactedTerms: ["secret-local"],
        redactContacts: true,
        excludedResourceIds: [],
      },
    },
  });
  const model = vi.fn<CurationGenerator>(async ({ materials }) => {
    expect(materials[0]!.text).not.toContain("secret");
    expect(materials[0]!.text).not.toContain("test@example.com");
    return {
      entries: [
        {
          title: "Protocol",
          markdown: "Independent fact",
          sourceIds: [source.id],
          reason: "",
        },
      ],
      notes: "",
    };
  });
  await saveKnowledgeInstruction(db, alice, library, {
    path: `sources/${source.id}/SOURCE.md`,
    markdown: "Source rules",
    expectedRevision: 0,
  });
  const first = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, first.id, model);
  const second = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, second.id, model);
  expect(model).toHaveBeenCalledTimes(1);
  expect(await knowledgeEntries(db, alice, library)).toHaveLength(1);
});
it("segments Chinese questions without reading any source", async () => {
  const entry = await saveHumanKnowledge(db, alice, library, {
    title: "网络协议",
    markdown: "网络协议定义通信规则。",
    expectedRevision: 0,
  });
  await reviewKnowledgeEntry(db, alice, library, entry.id, 1, "publish");
  const bot = await saveKnowledgeAssistant(db, alice, {
    title: "Bot",
    expectedRevision: 0,
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
  });
  expect(
    (await searchKnowledgeAssistant(db, bob, bot.id, "请介绍网络协议的作用"))
      .items,
  ).toHaveLength(1);
});

it("all library managers can edit shared sources while ordinary readers cannot", async () => {
  const source = await subscribe();
  const path = `sources/${source.id}/SOURCE.md`;
  await expect(saveKnowledgeInstruction(db,bob,library,{path,markdown:"unauthorized",expectedRevision:0})).rejects.toMatchObject({status:404});
  await db.insertInto("grants").values({resource_id:library,user_id:bob.id,role:"manager",status:"active",source_type:"direct",source_id:bob.id,include_descendants:1}).execute();
  await saveKnowledgeInstruction(db,bob,library,{path,markdown:"Shared administrator instructions",expectedRevision:0});
  await saveKnowledgeSettings(db,bob,library,0,{sourcePolicies:{[source.id]:{redactContacts:true}}});
  await detachKnowledgeSource(db,bob,library,source.id);
  expect((await db.selectFrom("knowledge_subscriptions").select("status").where("id","=",source.id).executeTakeFirstOrThrow()).status).toBe("detached");
});

it("shared instructions remain editable while each source's private material and local rules are isolated", async () => {
  await db
    .insertInto("grants")
    .values({
      resource_id: library,
      user_id: bob.id,
      role: "manager",
      status: "active",
      source_type: "direct",
      source_id: bob.id,
      include_descendants: 1,
    })
    .execute();
  const source = await subscribe("Alice private material"),
    other = await subscribe("Other material");
  await saveKnowledgeInstruction(db, alice, library, {
    path: `sources/${source.id}/SOURCE.md`,
    markdown: "Never extract customer contact details",
    expectedRevision: 0,
  });
  await saveKnowledgeInstruction(db, bob, library, {
    path: "KNOWLEDGE.md",
    markdown: "Organize by company departments",
    expectedRevision: 0,
  });
  const model = vi.fn<CurationGenerator>(async ({ bundle, materials }) => {
    expect(materials).toHaveLength(1);
    expect(
      bundle.files.filter((file) => file.path.startsWith("sources/")),
    ).toHaveLength(1);
    expect(
      bundle.files.some(
        (file) =>
          file.path === "KNOWLEDGE.md" &&
          file.markdown === "Organize by company departments",
      ),
    ).toBe(true);
    if (materials[0]!.subscriptionId === source.id) {
      expect(
        bundle.files.find(
          (file) => file.path === `sources/${source.id}/SOURCE.md`,
        )!.markdown,
      ).toContain("Never extract");
      expect(
        bundle.files.some(
          (file) => file.path === `sources/${other.id}/SOURCE.md`,
        ),
      ).toBe(false);
    }
    return { entries: [], notes: "" };
  });
  const run = await queueKnowledgeCuration(db, bob, library);
  await executeKnowledgeCuration(db, run.id, model);
  expect(model).toHaveBeenCalledTimes(2);
});

it("shares source masking configuration with all library administrators", async () => {
  await db
    .insertInto("grants")
    .values({
      resource_id: library,
      user_id: bob.id,
      role: "manager",
      status: "active",
      source_type: "direct",
      source_id: bob.id,
      include_descendants: 1,
    })
    .execute();
  const source = await subscribe();
  await saveKnowledgeSettings(db, alice, library, 0, {
    sourcePolicies: {
      [source.id]: {
        redactedTerms: ["private@example.com"],
        redactContacts: true,
        excludedResourceIds: [],
      },
    },
  });
  const view = await knowledgeManagementView(db, bob, library);
  expect(JSON.stringify(view.settings)).toContain("private@example.com");
  await saveKnowledgeSettings(db, bob, library, 1, {
    ...view.settings,
    modelId: "chosen-model",
  });
  const current = await knowledgeInstructions(db, alice, library);
  expect(current.settings.sourcePolicies[source.id]!.redactedTerms).toEqual([
    "private@example.com",
  ]);
});

it("separates URL citation access from independent answers and protects creator-token links", async () => {
  const source = await subscribe();
  const entry = await generate(source.id);
  await reviewKnowledgeEntry(
    db,
    alice,
    library,
    entry.id,
    entry.revision,
    "publish",
  );
  const url = "https://example.com/orders?token=creator-private-token";
  await db
    .updateTable("knowledge_subscriptions")
    .set({ source_kind: "url", source_id: "", url })
    .where("id", "=", source.id)
    .execute();
  const bot = await saveKnowledgeAssistant(db, alice, {
    expectedRevision: 0,
    title: "Orders",
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
  });
  const query = () => searchKnowledgeAssistant(db, bob, bot.id, "Protocol");
  const original = await query();
  expect(original.items[0]!.sources[0]!.href).toBe(url);
  const settings = (await knowledgeInstructions(db, alice, library)).settings;
  await saveKnowledgeSettings(db, alice, library, 0, {
    ...settings,
    sourcePolicies: { [source.id]: { linkAccess: "follow" } },
  });
  const restricted = await query();
  expect(restricted.items[0]!.excerpt).toBe(original.items[0]!.excerpt);
  expect(JSON.stringify(restricted)).not.toContain("creator-private-token");
  expect(
    (await searchKnowledgeAssistant(db, alice, bot.id, "Protocol")).items[0]!
      .sources[0]!.href,
  ).toBe(url);
  // A knowledge manager can administer knowledge but cannot discover another creator's restricted URL.
  await db
    .insertInto("grants")
    .values({
      resource_id: library,
      user_id: bob.id,
      role: "manager",
      status: "active",
      source_type: "direct",
      source_id: bob.id,
      include_descendants: 1,
    })
    .execute();
  const { listKnowledgeSubscriptions } =
    await import("@core/modules/knowledge/subscriptions.js");
  const sourceCards = await listKnowledgeSubscriptions(db, bob, library);
  expect(sourceCards.items[0]?.creator).toMatchObject({ id: alice.id, displayName: "alice" });
  expect(sourceCards.items[0]?.canEdit).toBe(true);
  expect(JSON.stringify(sourceCards)).toContain("creator-private-token");
  expect(
    JSON.stringify(await knowledgeManagementView(db, bob, library)),
  ).toContain("creator-private-token");
  await saveKnowledgeSettings(db, alice, library, 1, {
    ...settings,
    sourcePolicies: { [source.id]: { linkAccess: "closed" } },
  });
  expect(
    (await searchKnowledgeAssistant(db, alice, bot.id, "Protocol")).items[0]!
      .sources[0],
  ).not.toHaveProperty("href");
  expect((await query()).items[0]!.excerpt).toBe(original.items[0]!.excerpt);
});

it("connects bots according to common distribution policy and explicit user preferences", async () => {
  const {
    listKnowledgeAssistants,
    visitKnowledgeAssistant,
    saveKnowledgeAssistantConnection,
  } = await import("@core/modules/knowledge/system.js");
  const { searchConnectedKnowledge } =
    await import("@core/modules/knowledge/assistant-connections.js");
  const draft = await saveHumanKnowledge(db, alice, library, {
    expectedRevision: 0,
    title: "DNS",
    markdown: "DNS connects domain names to records.",
  });
  await reviewKnowledgeEntry(
    db,
    alice,
    library,
    draft.id,
    draft.revision,
    "publish",
  );
  const bot = await saveKnowledgeAssistant(db, alice, {
    expectedRevision: 0,
    title: "DNS bot",
    libraryIds: [library],
    memberIds: [],
    visibility: "public",
    enabled: true,
  });
  expect(await listKnowledgeAssistants(db, bob)).toEqual([]);
  expect((await searchConnectedKnowledge(db, bob, "DNS")).results).toHaveLength(
    0,
  );
  await visitKnowledgeAssistant(db, bob, bot.id);
  const visited = (await listKnowledgeAssistants(db, bob))[0]!;
  expect(visited.connected).toBe(false);
  const {collectPublicResource}=await import("@core/modules/discovery/catalog.js");
  await collectPublicResource(db,bob,"assistant",bot.id,true);
  expect((await listKnowledgeAssistants(db,bob))[0]!.connected).toBe(false);
  expect((await searchConnectedKnowledge(db,bob,"DNS")).results).toHaveLength(0);
  await collectPublicResource(db,bob,"assistant",bot.id,false);
  expect((await searchConnectedKnowledge(db,bob,"DNS")).results).toHaveLength(0);
  await saveKnowledgeAssistantConnection(db, bob, bot.id, "enabled", visited.preferenceRevision);
  const connected = (await listKnowledgeAssistants(db, bob))[0]!;
  expect(connected.connected).toBe(true);
  expect(
    (await searchConnectedKnowledge(db, bob, "DNS")).results[0]!.items,
  ).toHaveLength(1);
  await saveKnowledgeAssistantConnection(
    db,
    bob,
    bot.id,
    "disabled",
    connected.preferenceRevision,
  );
  expect((await searchConnectedKnowledge(db, bob, "DNS")).results).toHaveLength(
    0,
  );
  // Visiting does not erase a deliberate opt-out.
  await visitKnowledgeAssistant(db, bob, bot.id);
  expect((await listKnowledgeAssistants(db, bob))[0]!.connected).toBe(false);
  await expect(
    saveKnowledgeAssistantConnection(
      db,
      bob,
      bot.id,
      "enabled",
      connected.preferenceRevision,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await db
    .updateTable("distribution_settings")
    .set({
      config: JSON.stringify({
        grantMode: "invite",
        sharedDocuments: "granted",
      }),
    })
    .where("id", "=", "system")
    .execute();
  const privateBot = await saveKnowledgeAssistant(db, alice, {
    expectedRevision: 0,
    title: "Private",
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
  });
  expect(
    (await listKnowledgeAssistants(db, bob)).find(
      (b) => b.id === privateBot.id,
    )!.invitationPending,
  ).toBe(true);
  await expect(
    searchKnowledgeAssistant(db, bob, privateBot.id, "DNS"),
  ).rejects.toMatchObject({ status: 404 });
  await visitKnowledgeAssistant(db, bob, privateBot.id, true);
  expect(
    (await searchConnectedKnowledge(db, bob, "DNS")).results.some(
      (b) => b.assistantId === privateBot.id,
    ),
  ).toBe(true);
  await saveKnowledgeAssistant(db, alice, {
    id: privateBot.id,
    expectedRevision: 1,
    title: "Private",
    libraryIds: [library],
    memberIds: [],
    enabled: true,
  });
  expect((await searchConnectedKnowledge(db, bob, "DNS")).results).toHaveLength(
    0,
  );
});

it.each(["DNS", "采购订单"])(
  "runs the %s curation demo with independent human changes, conflicts and explicit weighted resolution",
  async (scenario) => {
    const { knowledgeHumanChanges } =
      await import("@core/modules/knowledge/system.js");
    const { subscribeKnowledgeSource } =
      await import("@core/modules/knowledge/subscriptions.js");
    const dns = scenario === "DNS";
    const rule =
      "来源权重 100，人工修订权重 50；来源有明确更新且不违反安全限制时采用较高权重，否则交人工裁决。";
    await saveKnowledgeInstruction(db, alice, library, {
      path: "KNOWLEDGE.md",
      expectedRevision: 0,
      markdown: dns
        ? `# DNS 数据全链路\n目录三层。第一层：技术、应用场景、未来发展。第二层按内容拆分。保留链路条件、缓存与 TTL。\n${rule}`
        : `# 采购订单\n订阅采购单文件夹，按供应商、年度、订单组织三层。按订单号与版本去重，金额保留币种。不汇总不同币种。\n${rule}`,
    });
    let subscriptionId: string;
    if (dns) {
      subscriptionId = (
        await subscribeKnowledgeSource(db, alice, library, {
          sourceKind: "url",
          url: "https://www.rfc-editor.org/rfc/rfc1034.html",
        })
      ).id;
      await subscribe(
        "内部 DNS 部署：工作站通过组织递归解析器查询，缓存由记录 TTL 决定。",
      );
    } else {
      const folderId = randomUUID(),
        fileId = randomUUID(),
        objectId = randomUUID(),
        profileId = randomUUID();
      await db
        .insertInto("storage_profiles")
        .values({
          id: profileId,
          provider: "local",
          config: "{}",
          active: 0,
          created_at: now(),
        })
        .execute();
      await db
        .insertInto("file_storage_objects")
        .values({
          id: objectId,
          profile_id: profileId,
          object_key: "isolated-order-fixture",
          sha256: "fixture",
          size: 50,
          mime: "text/plain",
          created_at: now(),
        })
        .execute();
      await db
        .insertInto("file_folders")
        .values({
          id: folderId,
          owner_id: alice.id,
          parent_id: null,
          name: "采购单",
          version: 1,
          created_at: now(),
          updated_at: now(),
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      await db
        .insertInto("file_items")
        .values({
          id: fileId,
          owner_id: alice.id,
          parent_type: "folder",
          parent_id: folderId,
          storage_object_id: objectId,
          name: "PO-2026-001.txt",
          mime: "text/plain",
          size: 50,
          metadata: "{}",
          ai_description_override: null,
          locked: 0,
          version: 1,
          created_at: now(),
          updated_at: now(),
          deleted_at: null,
          delete_batch: null,
        })
        .execute();
      await db
        .insertInto("knowledge_chunks")
        .values({
          id: randomUUID(),
          source_kind: "file",
          source_id: fileId,
          ordinal: 0,
          title: "采购单",
          text: "订单 PO-2026-001；供应商甲；金额 100 CNY；版本 1。",
          anchor: "",
          content_hash: "fixture",
          reader_ids: JSON.stringify([alice.id]),
          updated_at: now(),
        })
        .execute();
      subscriptionId = (
        await subscribeKnowledgeSource(db, alice, library, {
          sourceKind: "folder",
          sourceId: folderId,
        })
      ).id;
    }
    await saveKnowledgeInstruction(db, alice, library, {
      path: `sources/${subscriptionId}/SOURCE.md`,
      expectedRevision: 0,
      markdown:
        "仅提炼技术或订单事实，排除私人联系方式，不得从共同指引扩大可输出范围。",
    });
    let pass = 0,
      replacing = "",
      proposedText = "";
    const title = dns ? "DNS 递归链路" : "采购订单 PO-2026-001";
    const path = dns ? ["技术", "递归解析"] : ["供应商甲", "2026"];
    const original = dns
      ? "DNS 查询从工作站进入递归解析器；缓存有效时直接回答，未命中时按委派逐级查找。记录按 TTL 缓存。"
      : "采购订单 PO-2026-001，供应商甲，版本 1，金额 100 CNY。";
    const human = dns
      ? original + " 内部人工补充：故障排查先检查客户端缓存。"
      : original.replace("100 CNY", "120 CNY（人工核对）");
    const generator: CurationGenerator = async (input) => {
      expect(input.bundle.settings.maxDocumentDepth).toBe(3);
      expect(input.bundle.files.some((f) => f.path === "KNOWLEDGE.md")).toBe(
        true,
      );
      if (input.materials[0]!.subscriptionId !== subscriptionId)
        return { entries: [], notes: "内部材料用于补证" };
      if (pass > 0)
        expect(
          input.humanChanges?.some((c) => c.change.inserted.length > 0),
        ).toBe(true);
      return {
        entries: [
          {
            title,
            path,
            markdown: pass === 0 ? original : proposedText,
            sourceIds: [subscriptionId],
            reason: pass ? "来源与人工修订冲突" : "按整库定义整理",
            ...(replacing ? { replacesId: replacing } : {}),
            ...(pass === 2
              ? {
                  resolution: {
                    mode: "weighted" as const,
                    rulePath: "KNOWLEDGE.md",
                    ruleQuote: rule,
                    existingWeight: 50,
                    incomingWeight: 100,
                  },
                }
              : {}),
          },
        ],
        notes: "",
      };
    };
    const scan = async () => {
      const run = await queueKnowledgeCuration(db, alice, library);
      await executeKnowledgeCuration(db, run.id, generator, async () => ({
        title: "DNS Concepts",
        text: "DNS records associate names with data. Resolvers follow delegation and cache records according to TTL.",
      }));
      const result = await db
        .selectFrom("knowledge_runs")
        .selectAll()
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(result.status, result.detail).not.toBe("failed");
    };
    await scan();
    const first = (await knowledgeEntries(db, alice, library))[0]!;
    expect(first.path).toEqual(path);
    await reviewKnowledgeEntry(
      db,
      alice,
      library,
      first.id,
      first.revision,
      "publish",
    );
    const published = (await knowledgeEntries(db, alice, library))[0]!;
    const amended = await saveHumanKnowledge(db, alice, library, {
      id: published.id,
      expectedRevision: published.revision,
      title,
      markdown: human,
    });
    await reviewKnowledgeEntry(
      db,
      alice,
      library,
      amended.id,
      amended.revision,
      "publish",
    );
    const active = (await knowledgeEntries(db, alice, library)).find(
      (e) => e.status === "published",
    )!;
    expect(active.origin).toBe("human_revised");
    expect(await knowledgeHumanChanges(db, alice, library)).toHaveLength(1);
    replacing = active.id;
    pass = 1;
    proposedText = original + " 来源补证待裁决。";
    // An unchanged source must be reconsidered after a human amendment.
    await scan();
    const pending = (await knowledgeEntries(db, alice, library)).find(
      (e) => e.status === "draft",
    )!;
    expect(pending.reviewState.conflict).toBe(true);
    const bot = await saveKnowledgeAssistant(db, alice, {
      expectedRevision: 0,
      title: scenario,
      libraryIds: [library],
      memberIds: [bob.id],
      enabled: true,
    });
    expect(
      (await searchKnowledgeAssistant(db, bob, bot.id, title)).items[0]!
        .excerpt,
    ).toBe(human);
    // Rejecting a candidate leaves the published human correction intact.
    await reviewKnowledgeEntry(
      db,
      alice,
      library,
      pending.id,
      pending.revision,
      "delete",
    );
    const settings = (await knowledgeInstructions(db, alice, library)).settings;
    await saveKnowledgeSettings(db, alice, library, 0, {
      ...settings,
      autoPublishWeighted: true,
    });
    pass = 2;
    proposedText = original + " 经明确权重规则核实采用。";
    await scan();
    expect(
      (await searchKnowledgeAssistant(db, bob, bot.id, title)).items[0]!
        .excerpt,
    ).toBe(proposedText);
    await detachKnowledgeSource(db, alice, library, subscriptionId);
    expect(
      (await searchKnowledgeAssistant(db, bob, bot.id, title)).items[0]!
        .excerpt,
    ).toBe(proposedText);
    expect(await knowledgeHumanChanges(db, alice, library)).toHaveLength(1);
    await expect(
      saveHumanKnowledge(db, alice, library, {
        expectedRevision: 0,
        title: "过深",
        path: ["一", "二", "三"],
        markdown: "超出三层",
      }),
    ).rejects.toMatchObject({ status: 400 });
  },
);

it("uses the same shared-folder permissions for original file citations and file downloads", async () => {
  const { authorizeFileItem } =
    await import("@core/modules/access/file-access.js");
  const folderId = randomUUID(),
    fileId = randomUUID(),
    objectId = randomUUID(),
    profileId = randomUUID();
  await db
    .insertInto("storage_profiles")
    .values({
      id: profileId,
      provider: "local",
      config: "{}",
      active: 0,
      created_at: now(),
    })
    .execute();
  await db
    .insertInto("file_storage_objects")
    .values({
      id: objectId,
      profile_id: profileId,
      object_key: "shared-test",
      sha256: "fixture",
      size: 1,
      mime: "text/plain",
      created_at: now(),
    })
    .execute();
  await db
    .insertInto("file_folders")
    .values({
      id: folderId,
      owner_id: alice.id,
      parent_id: "shared",
      name: "Shared orders",
      version: 1,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  await db
    .insertInto("file_items")
    .values({
      id: fileId,
      owner_id: alice.id,
      parent_type: "folder",
      parent_id: folderId,
      storage_object_id: objectId,
      name: "Order.txt",
      mime: "text/plain",
      size: 1,
      metadata: "{}",
      ai_description_override: null,
      locked: 0,
      version: 1,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  await db
    .insertInto("file_folder_shares")
    .values({
      folder_id: folderId,
      user_id: bob.id,
      role: "reader",
      version: 1,
      created_at: now(),
      updated_at: now(),
    })
    .execute();
  const source = await subscribe();
  const draft = await generate(source.id);
  await reviewKnowledgeEntry(
    db,
    alice,
    library,
    draft.id,
    draft.revision,
    "publish",
  );
  await db
    .updateTable("knowledge_subscriptions")
    .set({ source_kind: "file", source_id: fileId })
    .where("id", "=", source.id)
    .execute();
  const bot = await saveKnowledgeAssistant(db, alice, {
    expectedRevision: 0,
    title: "Shared",
    libraryIds: [library],
    memberIds: [bob.id],
    enabled: true,
  });
  expect((await authorizeFileItem(db, bob, fileId)).id).toBe(fileId);
  const before = await searchKnowledgeAssistant(db, bob, bot.id, "Protocol");
  expect(before.items[0]!.sources[0]!.href).toBe(
    `/api/v1/files/items/${fileId}/content`,
  );
  await db
    .deleteFrom("file_folder_shares")
    .where("folder_id", "=", folderId)
    .where("user_id", "=", bob.id)
    .execute();
  await expect(authorizeFileItem(db, bob, fileId)).rejects.toMatchObject({
    status: 404,
  });
  const after = await searchKnowledgeAssistant(db, bob, bot.id, "Protocol");
  expect(after.items[0]!.sources[0]).not.toHaveProperty("href");
  expect(after.items[0]!.excerpt).toBe(before.items[0]!.excerpt);
});

it("retrieves a relevant passage beyond the beginning of a long independent summary", async () => {
  const draft = await saveHumanKnowledge(db, alice, library, {expectedRevision: 0, title: "DNS manual", markdown: "Background material. ".repeat(180) + "\n\nThe negative-cache TTL for demo.example is 600 seconds."});
  await reviewKnowledgeEntry(db, alice, library, draft.id, draft.revision, "publish");
  const bot = await saveKnowledgeAssistant(db, alice, {expectedRevision: 0, title: "DNS", libraryIds: [library], memberIds: [bob.id], enabled: true});
  const result = await searchKnowledgeAssistant(db, bob, bot.id, "What is the negative-cache TTL for demo.example?");
  expect(result.items[0]!.excerpt).toContain("600 seconds");
});

it("provides actual library configuration and subscriptions to read-only AI review", async () => {
  const { knowledgeReviewSnapshot } = await import("../apps/server/src/services/ai/knowledge-review.js");
  const source = await subscribe("Do not include this original source body in review");
  await saveKnowledgeInstruction(db, alice, library, { path: "KNOWLEDGE.md", markdown: "# Build independently useful knowledge", expectedRevision: 0 });
  await db.updateTable("knowledge_subscriptions").set({ source_version: "outdated" }).where("id", "=", source.id).execute();
  const snapshot = await knowledgeReviewSnapshot(db, alice, library);
  expect(snapshot.instructions.files.find(file => file.path === "KNOWLEDGE.md")?.revision).toBe(1);
  expect(snapshot.sources.items[0]?.sourceId).toBe(source.sourceId);
  expect(JSON.stringify(snapshot)).not.toContain("Do not include this original source body");
  expect((await db.selectFrom("knowledge_subscriptions").select("status").where("id", "=", source.id).executeTakeFirstOrThrow()).status).toBe("active");
  await expect(knowledgeReviewSnapshot(db, bob, library)).rejects.toThrow();
});


it("keeps a conflict candidate matching a superseded fact, but does not resurrect a rejected candidate", async () => {
  const source = await subscribe("TTL is 600 seconds");
  const original = await generate(source.id, "TTL is 600 seconds");
  await reviewKnowledgeEntry(db, alice, library, original.id, original.revision, "publish");
  const revised = await saveHumanKnowledge(db, alice, library, { id: original.id, expectedRevision: original.revision + 1, title: original.title, markdown: "TTL is 180 seconds" });
  await reviewKnowledgeEntry(db, alice, library, revised.id, revised.revision, "publish");
  const generator: CurationGenerator = async () => ({ entries: [{ title: original.title, markdown: original.markdown, sourceIds: [source.id], reason: "Source differs from human amendment", replacesId: revised.id }], notes: "" });
  const run = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, run.id, generator);
  const entries = await knowledgeEntries(db, alice, library);
  const candidate = entries.find(entry => entry.status === "draft" && entry.reviewState.replaces === revised.id);
  expect(candidate?.markdown).toBe("TTL is 600 seconds");
  expect(entries.find(entry => entry.id === revised.id)?.status).toBe("published");
  await reviewKnowledgeEntry(db, alice, library, candidate!.id, candidate!.revision, "delete");
  await saveKnowledgeInstruction(db, alice, library, { path: "guides/recheck.md", expectedRevision: 0, markdown: "Check sources again without reviving rejected candidates." });
  const next = await queueKnowledgeCuration(db, alice, library);
  await executeKnowledgeCuration(db, next.id, generator);
  expect((await knowledgeEntries(db, alice, library)).filter(entry => entry.status === "draft")).toHaveLength(0);
});


it("keeps instruction history without listing guides for removed pending subscriptions", async () => {
  const source = await subscribe();
  await db.updateTable("knowledge_subscriptions").set({ status: "pending" }).where("id", "=", source.id).execute();
  const path = `sources/${source.id}/SOURCE.md`;
  await saveKnowledgeInstruction(db, alice, library, { path, expectedRevision: 0, markdown: "Source boundary" });
  const { dismissKnowledgeSubscription } = await import("@core/modules/knowledge/subscriptions.js");
  await dismissKnowledgeSubscription(db, alice, library, source.id);
  expect((await knowledgeInstructions(db, alice, library)).files.some(file => file.path === path)).toBe(false);
  expect(await db.selectFrom("knowledge_instructions").select("path").where("library_id", "=", library).where("path", "=", path).execute()).toHaveLength(1);
});

it("places a published entry three levels deep in the library tree", async () => {
  const draft = await saveHumanKnowledge(db, alice, library, {
    title: "DNS 递归链路",
    markdown: "查询从工作站进入递归解析器。",
    path: ["技术", "递归解析"],
    expectedRevision: 0,
  });
  await reviewKnowledgeEntry(db, alice, library, draft.id, draft.revision, "publish");
  const docs = await db
    .selectFrom("resources")
    .select(["id", "title", "parent_id", "format"])
    .where("library_id", "=", library)
    .where("kind", "=", "document")
    .where("deleted_at", "is", null)
    .execute();
  const first = docs.find((doc) => doc.title === "技术" && !doc.parent_id);
  const second = docs.find((doc) => doc.title === "递归解析" && doc.parent_id === first?.id);
  const leaf = docs.find((doc) => doc.title === "DNS 递归链路" && doc.parent_id === second?.id);
  expect(first?.format).toBe("rich_text");
  expect(second?.format).toBe("rich_text");
  expect(leaf?.format).toBe("rich_text");
  const text = await db.selectFrom("document_states").select(["text", "codec"]).where("resource_id", "=", leaf!.id).executeTakeFirst();
  expect(text?.codec).toBe("slate-kit");
  expect(text?.text).toContain("递归解析器");
  const stored = await db.selectFrom("knowledge_entries").select("review_state").where("id", "=", draft.id).executeTakeFirstOrThrow();
  const state = JSON.parse(stored.review_state);
  state.figures = [{
    type: "flowchart",
    nodes: [
      { id: "ask", label: "解析器节点", shape: "terminator" },
      { id: "resolve", label: "递归解析", shape: "process" },
    ],
    edges: [{ source: "ask", target: "resolve" }],
  }];
  delete state.projectedHash;
  await db.updateTable("knowledge_entries").set({ review_state: JSON.stringify(state) }).where("id", "=", draft.id).execute();
  await projectPublishedKnowledge(db, alice, library);
  const drawn = await db.selectFrom("document_states").select("text").where("resource_id", "=", leaf!.id).executeTakeFirst();
  expect(drawn?.text).toContain("解析器节点");
});

it("lists guide topics that published knowledge does not cover", () => {
  const gaps = knowledgeOutlineGaps("范围包括“缓存与记录”。缓存如何影响查询？", [
    { status: "published", title: "查询入口", markdown: "工作站发起查询。", path: ["技术"] },
  ]);
  expect(gaps.map((gap) => gap.title)).toContain("缓存与记录");
  expect(gaps.some((gap) => gap.title.includes("缓存如何影响"))).toBe(false);
  const missed = knowledgeOutlineGaps("量子中继何时落地？", [
    { status: "published", title: "查询入口", markdown: "工作站发起查询。", path: ["技术"] },
  ]);
  expect(missed.map((gap) => gap.title)).toContain("量子中继何时落地");
});
