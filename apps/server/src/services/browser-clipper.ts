import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { createEditorDocument } from "@smartdoca/slate/headless";
import type { ConversionWarning } from "@smartdoca/slate/conversion";
import { convertClipperMarkdown } from "./browser-clipper-conversion.js";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import { createContent } from "@core/workflows/resources.js";
import { authorize } from "@core/modules/access/queries.js";
import {
  checkStorage,
  requireCapability,
} from "@core/modules/access/operation-policy.js";
import { lockAIUser } from "@core/modules/ai/config.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { requireBrowserConnection } from "@core/modules/browser-clipper/access.js";
import { appendImportedContent } from "@core/modules/documents/append-import.js";
import { AppError, fail } from "@core/shared/errors.js";
import {
  createStorage,
  storageConfigForProfile,
  type StorageRuntime,
} from "../adapters/storage.js";
import { registerStoredObject } from "./stored-objects.js";
import { detectBufferMime, objectKey, uploadLimits } from "./storage-policy.js";
import { enqueueProjection } from "@core/modules/automation/jobs.js";
import {
  captureInput,
  profileInput,
  parseClipper,
  type CaptureInput,
  type StagedImage,
} from "./browser-clipper-protocol.js";

type Profile = Schema["browser_clipper_profiles"];
const snapshotSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    input: profileInput,
  })
  .strict();
export function parseClipperProfileSnapshot(value: string) {
  return snapshotSchema.parse(JSON.parse(value));
}
const imagesSchema = z
  .array(
    z
      .object({
        id: z.string().uuid(),
        objectId: z.string().uuid(),
        profileId: z.string().min(1).max(160),
        key: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        size: z.number().int().positive(),
        name: z.string(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
  )
  .max(100);
export const imageMarker = (id: string) =>
  `https://clipper.invalid/images/${id}`;
export const captureHash = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const publicProfile = (row: Profile) => ({
  id: row.id,
  revision: row.revision,
  name: row.name,
  enabled: !!row.enabled,
  isDefault: !!row.is_default,
  strategy: row.strategy,
  libraryId: row.library_id,
  parentId: row.parent_id,
  targetId: row.target_id,
  titleTemplate: row.title_template,
  aiInstruction: row.ai_instruction,
});
const profileValues = ({
  id: _id,
  revision: _rev,
  ...input
}: ReturnType<typeof publicProfile>) => input;
function captureTitle(
  profile: { titleTemplate: string },
  input: Pick<CaptureInput, "title" | "capturedAt">,
) {
  const title = profile.titleTemplate
    .replaceAll("{title}", input.title)
    .replaceAll("{date}", input.capturedAt.slice(0, 10));
  if (!title.trim() || title.length > 160) fail(400, "clipper_title_too_long");
  return title;
}
export async function describeClipperProfile(
  db: DB,
  actor: Actor,
  profile: Profile,
) {
  const names = [];
  try {
    for (const id of [profile.library_id, profile.parent_id, profile.target_id])
      if (id) names.push((await authorize(db, actor, id, 1)).resource.title);
  } catch (error) {
    if (!(error instanceof AppError) || ![403, 404].includes(error.status))
      throw error;
    return { ...publicProfile(profile), destinationTitle: null };
  }
  return {
    ...publicProfile(profile),
    destinationTitle: names.join(" / ") || null,
  };
}

export async function validateClipperTarget(
  db: DB,
  actor: Actor,
  input: z.infer<typeof profileInput>,
) {
  await requireCapability(db, actor.id, "documents.create");
  await requireCapability(db, actor.id, "documents.import");
  if (input.strategy === "append") {
    if (!input.targetId || input.libraryId || input.parentId)
      fail(400, "clipper_invalid_target");
    const { resource } = await authorize(db, actor, input.targetId, 3);
    if (
      resource.kind !== "document" ||
      !["rich_text", "markdown"].includes(resource.format)
    )
      fail(400, "clipper_target_unsupported");
    if (
      resource.library_id &&
      (await db
        .selectFrom("knowledge_books")
        .select("id")
        .where("id", "=", resource.library_id)
        .executeTakeFirst())
    )
      fail(403, "clipper_knowledge_book_readonly");
  } else {
    if (input.targetId || (input.parentId && !input.libraryId))
      fail(400, "clipper_invalid_target");
    if (input.libraryId) {
      const { resource } = await authorize(db, actor, input.libraryId, 3);
      if (resource.kind !== "library") fail(400, "clipper_invalid_target");
      if (
        await db
          .selectFrom("knowledge_books")
          .select("id")
          .where("id", "=", resource.id)
          .executeTakeFirst()
      )
        fail(403, "clipper_knowledge_book_readonly");
    }
    if (input.parentId) {
      const { resource } = await authorize(db, actor, input.parentId, 3);
      if (
        resource.kind !== "document" ||
        resource.library_id !== input.libraryId
      )
        fail(400, "clipper_invalid_target");
    }
  }
}

export function createBrowserClipper(
  db: DB,
  runtime: StorageRuntime,
  notify: (id: string) => Promise<unknown>,
) {
  const storage = createStorage(runtime);
  async function receipt(userId: string, requestId: string, tx = db) {
    const row = await tx
      .selectFrom("browser_clipper_receipts")
      .selectAll()
      .where("user_id", "=", userId)
      .where("request_id", "=", requestId)
      .executeTakeFirst();
    if (!row) fail(404, "clipper_capture_missing");
    return row;
  }
  async function usable(
    row: Schema["browser_clipper_receipts"],
    actor: Actor,
    tx = db,
  ) {
    await requireBrowserConnection(tx, row.connection_id);
    if (
      row.status === "expired" ||
      (row.status === "pending" && row.expires_at <= new Date().toISOString())
    )
      fail(410, "clipper_capture_expired");
    const current = await tx
      .selectFrom("browser_clipper_profiles")
      .selectAll()
      .where("id", "=", row.profile_id)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    if (!current?.enabled) fail(403, "clipper_profile_unavailable");
    const snapshot = parseClipperProfileSnapshot(row.profile_json);
    await validateClipperTarget(tx, actor, snapshot.input);
    return snapshot;
  }
  async function result(
    row: Schema["browser_clipper_receipts"],
    actor: Actor,
    tx = db,
  ) {
    if (row.resource_id) await authorize(tx, actor, row.resource_id, 1);
    return {
      requestId: row.request_id,
      status: row.status,
      resourceId: row.resource_id,
      href: row.resource_id ? `/#/r/${row.resource_id}` : null,
      uploadedImageIds: imagesSchema
        .parse(JSON.parse(row.images_json))
        .map((image) => image.id),
    };
  }
  return {
    async prepare(actor: Actor, connectionId: string, input: CaptureInput) {
      return transact(db, async (tx) => {
        await lockAIUser(tx, actor.id);
        await requireBrowserConnection(tx, connectionId);
        const old = await tx
          .selectFrom("browser_clipper_receipts")
          .selectAll()
          .where("user_id", "=", actor.id)
          .where("request_id", "=", input.requestId)
          .executeTakeFirst();
        if (old) {
          if (
            old.connection_id !== connectionId ||
            old.input_hash !== captureHash(input)
          )
            fail(409, "clipper_request_conflict");
          await usable(old, actor, tx);
          return result(old, actor, tx);
        }
        const profile = await tx
          .selectFrom("browser_clipper_profiles")
          .selectAll()
          .where("id", "=", input.profileId)
          .where("user_id", "=", actor.id)
          .executeTakeFirst();
        if (!profile?.enabled) fail(403, "clipper_profile_unavailable");
        if (profile.revision !== input.profileRevision)
          fail(409, "clipper_profile_changed");
        await validateClipperTarget(
          tx,
          actor,
          profileValues(publicProfile(profile)),
        );
        const pending = await tx
          .selectFrom("browser_clipper_receipts")
          .select("request_id")
          .where("user_id", "=", actor.id)
          .where("status", "=", "pending")
          .where("expires_at", ">", new Date().toISOString())
          .execute();
        if (pending.length >= 10) fail(429, "clipper_too_many_pending");
        const now = new Date().toISOString();
        const row: Schema["browser_clipper_receipts"] = {
          user_id: actor.id,
          request_id: input.requestId,
          connection_id: connectionId,
          input_hash: captureHash(input),
          profile_id: profile.id,
          profile_json: JSON.stringify({
            version: 1,
            id: profile.id,
            revision: profile.revision,
            input: profileValues(publicProfile(profile)),
          }),
          payload_json: JSON.stringify(input),
          images_json: "[]",
          status: "pending",
          resource_id: null,
          expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
          created_at: now,
          updated_at: now,
        };
        await tx.insertInto("browser_clipper_receipts").values(row).execute();
        return result(row, actor, tx);
      });
    },
    async describeCapture(
      actor: Actor,
      connectionId: string,
      requestId: string,
    ) {
      const row = await receipt(actor.id, requestId);
      if (row.connection_id !== connectionId)
        fail(404, "clipper_capture_missing");
      const snapshot = await usable(row, actor);
      if (row.status !== "pending") fail(409, "clipper_request_conflict");
      const input = captureInput.parse(JSON.parse(row.payload_json));
      const names: string[] = [];
      for (const id of [
        snapshot.input.libraryId,
        snapshot.input.parentId,
        snapshot.input.targetId,
      ])
        if (id) names.push((await authorize(db, actor, id, 3)).resource.title);
      return {
        profileId: snapshot.id,
        profileRevision: snapshot.revision,
        strategy: snapshot.input.strategy,
        title: captureTitle(snapshot.input, input),
        path: names.join(" / "),
      };
    },
    async status(actor: Actor, connectionId: string, requestId: string) {
      const row = await receipt(actor.id, requestId);
      if (row.connection_id !== connectionId)
        fail(404, "clipper_capture_missing");
      await usable(row, actor);
      return result(row, actor);
    },
    async upload(
      actor: Actor,
      connectionId: string,
      requestId: string,
      imageId: string,
      body: Buffer,
    ) {
      const row = await receipt(actor.id, requestId);
      if (row.connection_id !== connectionId || row.status !== "pending")
        fail(409, "clipper_capture_not_pending");
      await usable(row, actor);
      await requireCapability(db, actor.id, "assets.upload");
      const input = captureInput.parse(JSON.parse(row.payload_json));
      const source = input.images.find((image) => image.id === imageId);
      if (!source || !body.length || body.length > uploadLimits.asset)
        fail(413, "clipper_image_invalid");
      const mime = await detectBufferMime(body, source.name);
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
      )
        fail(400, "clipper_image_invalid");
      const metadata = await sharp(body, {
        limitInputPixels: 25_000_000,
        animated: false,
      })
        .metadata()
        .catch(() => fail(400, "clipper_image_invalid"));
      const images = imagesSchema.parse(JSON.parse(row.images_json));
      const hash = createHash("sha256").update(body).digest("hex");
      const old = images.find((image) => image.id === imageId);
      if (old) {
        if (old.sha256 !== hash) fail(409, "clipper_request_conflict");
        return { id: imageId, uploaded: true };
      }
      const profile = await db
        .selectFrom("storage_profiles")
        .selectAll()
        .where("active", "=", 1)
        .executeTakeFirstOrThrow();
      const objectId = randomUUID(),
        key = objectKey(objectId, mime),
        config = storageConfigForProfile(runtime, profile);
      await checkStorage(db, actor.id, body.length);
      await storage.put(config, key, body, mime, source.name);
      let committed = false;
      try {
        await transact(db, async (tx) => {
          await lockAIUser(tx, actor.id);
          const current = await receipt(actor.id, requestId, tx);
          await usable(current, actor, tx);
          if (current.status !== "pending")
            fail(409, "clipper_capture_not_pending");
          await requireCapability(tx, actor.id, "assets.upload");
          const staged = imagesSchema.parse(JSON.parse(current.images_json));
          const duplicate = staged.find((image) => image.id === imageId);
          if (duplicate) {
            if (duplicate.sha256 !== hash)
              fail(409, "clipper_request_conflict");
            return;
          }
          const size = staged.reduce(
            (sum, image) => sum + image.size,
            body.length,
          );
          if (size > 100 * 1024 ** 2) fail(413, "clipper_images_too_large");
          await checkStorage(tx, actor.id, size);
          staged.push({
            id: imageId,
            objectId,
            profileId: profile.id,
            key,
            sha256: hash,
            mime: mime as StagedImage["mime"],
            size: body.length,
            name: source.name,
            width: metadata.width!,
            height: metadata.height!,
          });
          await tx
            .updateTable("browser_clipper_receipts")
            .set({
              images_json: JSON.stringify(staged),
              updated_at: new Date().toISOString(),
            })
            .where("user_id", "=", actor.id)
            .where("request_id", "=", requestId)
            .execute();
          committed = true;
        });
      } finally {
        if (!committed) await storage.remove(config, key);
      }
      return { id: imageId, uploaded: true };
    },
    async commit(actor: Actor, connectionId: string, requestId: string) {
      const saved = await transact(db, async (tx) => {
        await lockAIUser(tx, actor.id);
        const row = await receipt(actor.id, requestId, tx);
        if (row.connection_id !== connectionId)
          fail(404, "clipper_capture_missing");
        const snapshot = await usable(row, actor, tx);
        if (row.status === "completed") return result(row, actor, tx);
        const input = captureInput.parse(JSON.parse(row.payload_json)),
          images = imagesSchema.parse(JSON.parse(row.images_json));
        const profile = snapshot.input;
        const title = captureTitle(profile, input);
        const escape = (text: string) => text.replace(/[\\[\]*_`<>]/g, "\\$&");
        const sourceUrl = input.url.replace(/[()<>\s]/g, (character) =>
          encodeURIComponent(character),
        );
        let markdown = `# ${escape(title)}\n\n[${escape(input.title)}](${sourceUrl}) · ${input.capturedAt}\n\n${input.markdown}`;
        const imageWarnings: ConversionWarning[] = [];
        for (const image of input.images) {
          if (images.some((staged) => staged.id === image.id)) continue;
          const label = `Image not saved: ${image.name}`;
          let replacement = escape(`[${label}]`);
          try {
            const url = new URL(image.url);
            if (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password
            )
              replacement = `[${escape(label)}](${url.href.replace(/[()<>\s]/g, (character) => encodeURIComponent(character))})`;
          } catch {
            /* Embedded/invalid source addresses stay readable text. */
          }
          const marker = imageMarker(image.id).replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );
          markdown = markdown.replace(
            new RegExp(`!\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(${marker}\\)`, "g"),
            () => replacement,
          );
          imageWarnings.push({
            code: "resource-skipped",
            message: `Image "${image.name}" was not received and was replaced by a source placeholder.`,
          });
        }
        const content = createContent(tx);
        const resource =
          profile.strategy === "append"
            ? (await authorize(tx, actor, profile.targetId!, 3)).resource
            : await content.create(actor, {
                title,
                kind: "document",
                format: "rich_text",
                libraryId: profile.libraryId,
                parentId: profile.parentId,
                private: true,
              });
        const assetIds = new Map<string, string>();
        await checkStorage(
          tx,
          resource.owner_id,
          images.reduce((sum, image) => sum + image.size, 0),
        );
        if (images.length)
          await requireCapability(tx, actor.id, "assets.upload");
        for (const image of images) {
          const id = image.objectId,
            now = new Date().toISOString();
          // Portable import paths are opaque source IDs, never external URLs.
          // The converter deliberately refuses remote-image fetching.
          markdown = markdown.replaceAll(imageMarker(image.id), image.id);
          assetIds.set(image.id, id);
          await tx
            .insertInto("assets")
            .values({
              id,
              uploaded_by: actor.id,
              owner_id: resource.owner_id,
              resource_id: resource.id,
              purpose: "attachment",
              profile_id: image.profileId,
              object_key: image.key,
              filename: image.name,
              mime: image.mime,
              size: image.size,
              created_at: now,
              deleted_at: null,
            })
            .execute();
          await registerStoredObject(tx, {
            id,
            profile_id: image.profileId,
            object_key: image.key,
            sha256: image.sha256,
            size: image.size,
            mime: image.mime,
            ai_description: null,
            ai_status: "skipped",
            ai_model: null,
            ai_generated_at: null,
            created_at: now,
          });
          const fileId = randomUUID();
          await tx
            .insertInto("file_items")
            .values({
              id: fileId,
              owner_id: resource.owner_id,
              parent_type: "document",
              parent_id: resource.id,
              storage_object_id: id,
              name: image.name,
              mime: image.mime,
              size: image.size,
              metadata: JSON.stringify({
                assetId: id,
                resourceId: resource.id,
              }),
              ai_description_override: null,
              locked: 1,
              version: 1,
              created_at: now,
              updated_at: now,
              deleted_at: null,
              delete_batch: null,
            })
            .execute();
          await enqueueProjection(tx, "search-file", fileId, { fileId });
        }
        const converted = await convertClipperMarkdown(
          markdown,
          assetIds,
          undefined,
          imageWarnings,
        );
        markdown = converted.markdown;
        for (const [marker, id] of assetIds)
          markdown = markdown.replaceAll(marker, id);
        if (profile.strategy === "create")
          await content.initializeImport(
            actor,
            resource.id,
            createEditorDocument(converted.initialValue),
          );
        else
          await appendImportedContent(
            tx,
            actor,
            resource.id,
            converted.initialValue,
            markdown,
            requestId,
          );
        const next = {
          ...row,
          status: "completed" as const,
          resource_id: resource.id,
          payload_json: "",
          updated_at: new Date().toISOString(),
        };
        await tx
          .updateTable("browser_clipper_receipts")
          .set({
            status: next.status,
            resource_id: resource.id,
            payload_json: "",
            updated_at: next.updated_at,
          })
          .where("user_id", "=", actor.id)
          .where("request_id", "=", requestId)
          .execute();
        // Current-attempt diagnostics only: no schema or persisted payload change.
        return {
          ...(await result(next, actor, tx)),
          warnings: converted.warnings,
        };
      });
      if (saved.resourceId) await notify(saved.resourceId).catch(() => {});
      return saved;
    },
    async cleanup() {
      // Claim under the user lock, then remove only that expired task's unbound objects.
      const expired = await db
        .selectFrom("browser_clipper_receipts")
        .select(["user_id", "request_id"])
        .where((eb) =>
          eb.or([
            eb("status", "=", "pending"),
            eb.and([
              eb("status", "=", "expired"),
              eb("images_json", "!=", "[]"),
            ]),
          ]),
        )
        .where("expires_at", "<=", new Date().toISOString())
        .limit(50)
        .execute();
      for (const task of expired) {
        const images = await transact(db, async (tx) => {
          await lockAIUser(tx, task.user_id);
          const row = await receipt(task.user_id, task.request_id, tx);
          if (
            row.status === "completed" ||
            row.expires_at > new Date().toISOString()
          )
            return [];
          await tx
            .updateTable("browser_clipper_receipts")
            .set({
              status: "expired",
              payload_json: "",
              updated_at: new Date().toISOString(),
            })
            .where("user_id", "=", task.user_id)
            .where("request_id", "=", task.request_id)
            .execute();
          return imagesSchema.parse(JSON.parse(row.images_json));
        });
        for (const image of images) {
          const profile = await db
            .selectFrom("storage_profiles")
            .selectAll()
            .where("id", "=", image.profileId)
            .executeTakeFirstOrThrow();
          await storage.remove(
            storageConfigForProfile(runtime, profile),
            image.key,
          );
        }
        if (images.length)
          await db
            .updateTable("browser_clipper_receipts")
            .set({ images_json: "[]" })
            .where("user_id", "=", task.user_id)
            .where("request_id", "=", task.request_id)
            .where("status", "=", "expired")
            .execute();
      }
    },
  };
}
