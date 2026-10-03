import {
  pluginDatabaseToken,
  pluginObjectStorageToken,
  pluginCredentialToken,
} from "@smartdoca/plugin-sdk/storage";
import { httpServiceToken } from "@smartdoca/plugin-sdk/platform";
import { filesServiceToken } from "@smartdoca/plugin-sdk/files";
import { contentServiceToken } from "@smartdoca/plugin-sdk/content";
import { registerResources } from "./resources.js";
import manifest from "./manifest.json";
import { validatePluginManifest } from "@smartdoca/plugin-sdk";
import type { DocaPlugin } from "@smartdoca/plugin-sdk";
export default (): DocaPlugin => ({
  manifest: validatePluginManifest(manifest),
  injections: {
    required: [
      pluginDatabaseToken,
      pluginObjectStorageToken,
      pluginCredentialToken,
    ],
  },
  async initialize(ctx) {
    const database = ctx.inject(pluginDatabaseToken);
    await database.defineSchema({
      version: 1,
      tables: {
        credential_refs: {
          columns: {
            user_id: { type: "text", nullable: false },
            credential_id: { type: "text", nullable: false },
          },
          primaryKey: ["user_id"],
          unique: [],
        },
        notes: {
          columns: {
            id: { type: "text", nullable: false },
            user_id: { type: "text", nullable: false },
            text: { type: "text", nullable: false },
          },
          primaryKey: ["id"],
          unique: [],
        },
      },
    });
    registerResources(ctx, manifest.id);
    ctx.inject(contentServiceToken).register({
      id: "example.storage.notes",
      pluginId: manifest.id,
      version: 1,
      title: { zh: "验收笔记", en: "Acceptance notes" },
      contentTypes: ["text/plain"],
      purposes: ["analysis", "knowledge", "search"],
      capabilities: { search: false },
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async list(context, input) {
        const rows = await database.select("notes", {
          where: [
            { column: "user_id", operator: "=", value: context.principalId },
          ],
          limit: input.limit,
        });
        return {
          items: rows.map((row) => ({
            ref: {
              sourceId: "example.storage.notes",
              resourceId: String(row.id),
              blockId: "body",
            },
            fingerprint: String(row.text),
            title: "SDK note",
          })),
          nextCursor: null,
          snapshot: "isolated-notes",
        };
      },
      async read(context, input) {
        const rows = await database.select("notes", {
          where: [
            { column: "id", operator: "=", value: input.ref.resourceId },
            { column: "user_id", operator: "=", value: context.principalId },
          ],
        });
        const row = rows[0];
        return row && row.text === input.fingerprint
          ? {
              ref: input.ref,
              fingerprint: input.fingerprint,
              title: "SDK note",
              text: String(row.text),
            }
          : null;
      },
      async resolve(context, ref) {
        const rows = await database.select("notes", {
          where: [
            { column: "id", operator: "=", value: ref.resourceId },
            { column: "user_id", operator: "=", value: context.principalId },
          ],
        });
        return rows[0]
          ? {
              path: "/plugins/example.storage/",
              fingerprint: String(rows[0].text),
            }
          : null;
      },
    });
  },
  async mount(ctx) {
    const db = ctx.inject(pluginDatabaseToken),
      objects = ctx.inject(pluginObjectStorageToken),
      credentials = ctx.inject(pluginCredentialToken),
      files = ctx.inject(filesServiceToken);
    const credentialFor = async (principalId: string) => {
      const ref = (
        await db.select("credential_refs", {
          where: [{ column: "user_id", operator: "=", value: principalId }],
        })
      )[0];
      return ref ? credentials.get(String(ref.credential_id)) : null;
    };
    await ctx.inject(httpServiceToken).register(manifest.id, [
      {
        method: "POST",
        path: "/credential/create",
        async handle(req) {
          const existing = await credentialFor(req.principal.id);
          if (existing) return existing.credential;
          const created = await credentials.create({
            value: "sdk-test-password",
          });
          try {
            await db.insert("credential_refs", [
              { user_id: req.principal.id, credential_id: created.id },
            ]);
          } catch (error) {
            await credentials.remove({
              id: created.id,
              expectedRevision: created.revision,
            });
            throw error;
          }
          return created;
        },
      },
      {
        method: "GET",
        path: "/credential/check",
        async handle(req) {
          const stored = await credentialFor(req.principal.id);
          return stored
            ? {
                credential: stored.credential,
                verified: ["sdk-test-password", "sdk-test-refreshed"].includes(
                  stored.value,
                ),
              }
            : { credential: null };
        },
      },
      {
        method: "POST",
        path: "/credential/refresh",
        async handle(req) {
          const stored = await credentialFor(req.principal.id);
          if (!stored) throw Error("Create a credential first");
          return credentials.update({
            id: stored.credential.id,
            expectedRevision: stored.credential.revision,
            value: "sdk-test-refreshed",
          });
        },
      },
      {
        method: "POST",
        path: "/credential/remove",
        async handle(req) {
          const stored = await credentialFor(req.principal.id);
          if (stored)
            await credentials.remove({
              id: stored.credential.id,
              expectedRevision: stored.credential.revision,
            });
          await db.remove("credential_refs", [
            { column: "user_id", operator: "=", value: req.principal.id },
          ]);
          return { removed: true };
        },
      },
      {
        method: "GET",
        path: "/notes",
        async handle(req) {
          return db.select("notes", {
            where: [
              { column: "user_id", operator: "=", value: req.principal.id },
            ],
          });
        },
      },
      {
        method: "POST",
        path: "/note",
        async handle(req) {
          const text = (req.body as { text?: string })?.text;
          if (typeof text !== "string" || !text.trim())
            throw Error("Text is required");
          await db.insert("notes", [
            { id: crypto.randomUUID(), user_id: req.principal.id, text },
          ]);
          return { saved: true };
        },
      },
      {
        method: "POST",
        path: "/private-roundtrip",
        async handle() {
          const bytes = new TextEncoder().encode("private SDK bytes");
          const object = await objects.put({
            data: bytes,
            mime: "application/octet-stream",
          });
          const read = await objects.get(object.id);
          return { object, text: new TextDecoder().decode(read!.data) };
        },
      },
      {
        method: "POST",
        path: "/folder-file",
        async handle(req) {
          const context = { principalId: req.principal.id, signal: req.signal };
          const folder = await files.folders.create(context, {
            parentId: null,
            name: "SDK acceptance files",
            idempotencyKey: "acceptance-folder",
          });
          const upload = await files.uploads.begin(context, {
            filename: "sdk-note.txt",
            mime: "text/plain",
            size: 18,
          });
          await files.uploads.write(context, {
            uploadId: upload.id,
            offset: 0,
            bytes: new TextEncoder().encode("normal SDK content"),
          });
          const completed = await files.uploads.complete(context, {
            uploadId: upload.id,
          });
          const file = await files.files.create(context, {
            folderId: folder.id,
            name: "sdk-note.txt",
            uploadId: upload.id,
            contentIdentity: completed.contentIdentity,
            idempotencyKey: "acceptance-file",
          });
          return { folder, file };
        },
      },
      {
        method: "GET",
        path: "/sources",
        async handle(req) {
          return ctx.inject(contentServiceToken).sources(req, "analysis");
        },
      },
    ]);
  },
  async uninstall() {},
});
