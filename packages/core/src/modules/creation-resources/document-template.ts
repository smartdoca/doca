import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB, Resource, Schema } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type {
  TemplateSelection,
  TemplatePayload,
} from "@smartdoca/plugin-contracts";
import {
  createMaterialsService,
  createTemplatesService,
  templateProviderGuard,
} from "./service.js";
import { authorizeFileItem } from "../access/file-access.js";
import { checkStorage, requireCapability } from "../access/operation-policy.js";
import {
  applyTemplateContent,
  assertTemplateContent,
} from "../templates/templates.js";
import { validateImport } from "../documents/import.js";
import {
  validateNewMentions,
  documentMentions,
} from "../interactions/community.js";
import { enqueueProjection } from "../automation/jobs.js";
import { fail } from "../../shared/errors.js";
export const documentTemplateType = (format: string) => ({
  id: `doca.document.${format}`,
  version: 1,
});
export const nativeTemplateType = (format: string) => ({
  id: `doca.native.${format}`,
  version: format === "presentation" ? 2 : 1,
});
export function resourceRequest(
  actor: Actor,
  signal = new AbortController().signal,
): PluginRequestContext {
  return {
    requestId: randomUUID(),
    principal: {
      id: actor.id,
      displayName: actor.display_name,
      publicId: actor.public_id ?? "",
      admin: !!actor.admin,
    },
    signal,
  };
}
export async function prepareDocumentTemplate(
  db: DB,
  actor: Actor,
  format: string,
  selection: TemplateSelection,
  signal?: AbortSignal,
) {
  const assertProvider = templateProviderGuard(db, selection.ref.providerId);
  const context = resourceRequest(actor, signal),
    payload = await createTemplatesService(db).read(context, selection);
  if (
    payload.contract.id !== documentTemplateType(format).id ||
    payload.contract.version !== 1 ||
    payload.contentType.id !== nativeTemplateType(format).id ||
    payload.contentType.version !== nativeTemplateType(format).version
  )
    fail(400, "Template does not match document format");
  // Each use imports under a fresh operation identity. Provider retries use the same key.
  const files = new Map<string, string>();
  const operation = randomUUID();
  for (const asset of payload.assets) {
    const result = await createMaterialsService(db).import(context, {
      ref: asset.ref,
      operationKey: `${operation}:${asset.key}`,
    });
    files.set(asset.key, result.fileId);
  }
  await createTemplatesService(db).describe(context, selection.ref);
  assertProvider();
  return { payload, files, selection, context, assertProvider };
}
function remap(value: unknown, ids: Map<string, string>, depth = 0): unknown {
  if (depth > 40) fail(413, "Template nesting limit exceeded");
  if (typeof value === "string") {
    if (value.startsWith("material:")) {
      const id = ids.get(value.slice(9));
      if (!id) fail(400, "Unresolved template material");
      return id;
    }
    return value.replace(/\]\(material:([a-zA-Z0-9._-]+)\)/g, (_, key) => {
      const id = ids.get(key);
      if (!id) fail(400, "Unresolved template material");
      return `](${id})`;
    });
  }
  if (Array.isArray(value)) return value.map((x) => remap(x, ids, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, remap(v, ids, depth + 1)]),
    );
  return value;
}
export async function initializeDocumentTemplate(
  tx: Transaction<Schema>,
  actor: Actor,
  resource: Resource,
  prepared: Awaited<ReturnType<typeof prepareDocumentTemplate>>,
) {
  prepared.context.signal.throwIfAborted();
  prepared.assertProvider();
  const ids = new Map<string, string>();
  if (prepared.files.size)
    await requireCapability(tx, actor.id, "assets.upload");
  for (const [key, fileId] of prepared.files) {
    const source = await authorizeFileItem(tx, actor, fileId);
    const physical = await tx
      .selectFrom("file_storage_objects")
      .selectAll()
      .where("id", "=", source.storage_object_id)
      .executeTakeFirstOrThrow();
    await checkStorage(tx, resource.owner_id, source.size);
    const assetId = randomUUID(),
      fileItemId = randomUUID(),
      now = resource.created_at;
    await tx
      .insertInto("assets")
      .values({
        id: assetId,
        owner_id: resource.owner_id,
        resource_id: resource.id,
        purpose: "attachment",
        profile_id: physical.profile_id,
        object_key: physical.object_key,
        filename: source.name,
        mime: source.mime,
        size: source.size,
        uploaded_by: actor.id,
        created_at: now,
        deleted_at: null,
      })
      .execute();
    await tx
      .insertInto("file_items")
      .values({
        id: fileItemId,
        owner_id: resource.owner_id,
        parent_type: "document",
        parent_id: resource.id,
        storage_object_id: source.storage_object_id,
        name: source.name,
        mime: source.mime,
        size: source.size,
        metadata: JSON.stringify({ assetId, copiedFrom: source.id }),
        ai_description_override: source.ai_description_override,
        locked: 1,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        delete_batch: null,
      })
      .execute();
    await enqueueProjection(tx, "search-file", fileItemId, {
      fileId: fileItemId,
    });
    ids.set(key, assetId);
  }
  const content = remap(prepared.payload.content, ids),
    allowed = new Set(ids.values());
  validateImport(content, 0, { nodes: 0 }, allowed);
  if (resource.format === "rich_text")
    await validateNewMentions(
      tx,
      actor,
      new Set(documentMentions(content).keys()),
      new Set(),
    );
  await assertTemplateContent(resource.format, content, allowed);
  await applyTemplateContent(tx, resource, content, allowed);
  prepared.context.signal.throwIfAborted();
  prepared.assertProvider();
}

export type PreparedDocumentTemplate = Awaited<
  ReturnType<typeof prepareDocumentTemplate>
>;
