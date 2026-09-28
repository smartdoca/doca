import { cleanupFileReceipts } from "@server/plugins/file-receipt-cleanup.js";
import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { createServerFilesCapability } from "@server/plugins/files-capability-adapter.js";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";
import { definePlugin } from "@doca/plugin-sdk";
import { filesServiceToken, type FilesServiceV1 } from "@doca/plugin-sdk/files";
import { runPluginContractHarness } from "@doca/plugin-sdk/testing";

it("durably replays concurrent creates, rejects conflicts, recovers pending uploads and rechecks access", async () => {
  const root = await mkdtemp(join(tmpdir(), "doca-file-receipts-"));
  const config = { driver: "sqlite" as const, path: join(root, "test.sqlite") };
  let db = await openTestDatabase(config);
  const storage = {
    root: join(root, "objects"),
    credentials: {},
    endpointHosts: [],
    cdnKeyPairId: undefined,
    cdnPrivateKey: undefined,
  };
  const run = async (
    body: (files: FilesServiceV1) => Promise<void>,
    id = "example.mail",
  ) => {
    await runPluginContractHarness(
      scopeInstalledPlugin(
        definePlugin({
          manifest: {
            schemaVersion: 1,
            id,
            version: "1.0.0",
            displayName: "Receipt test",
          },
          async ready(context) {
            await body(context.inject(filesServiceToken));
          },
        }),
      ),
      {
        services: [
          {
            token: filesServiceToken,
            value: createServerFilesCapability(db, storage),
          },
        ],
      },
    );
  };
  try {
    const user = await createUser(
      db,
      {
        login: "receipt",
        displayName: "Receipt",
        password: "test-password-2026",
      },
      { bootstrap: true },
    );
    const context = { principalId: user.id };
    const folderInput = {
      parentId: null,
      name: "Mail",
      idempotencyKey: "folder:mail",
    };
    let folderId = "";
    let original: Awaited<ReturnType<FilesServiceV1["files"]["create"]>>;
    let contentIdentity: NonNullable<
      Awaited<
        ReturnType<FilesServiceV1["uploads"]["complete"]>
      >["contentIdentity"]
    >;
    const upload = async (files: FilesServiceV1) => {
      const item = await files.uploads.begin(context, {
        filename: "hello.txt",
        mime: "text/plain",
        size: 5,
      });
      await files.uploads.write(context, {
        uploadId: item.id,
        offset: 0,
        bytes: new TextEncoder().encode("hello"),
      });
      return files.uploads.complete(context, { uploadId: item.id });
    };
    await run(async (files) => {
      const folders = await Promise.all(
        Array.from({ length: 4 }, () =>
          files.folders.create(context, folderInput),
        ),
      );
      expect(new Set(folders.map((f) => f.id)).size).toBe(1);
      folderId = folders[0]!.id;
      await expect(
        files.folders.create(context, { ...folderInput, name: "Changed" }),
      ).rejects.toMatchObject({ status: 409 });
      const item = await upload(files);
      contentIdentity = item.contentIdentity!;
      const input = {
        folderId: null,
        name: "hello.txt",
        uploadId: item.id,
        idempotencyKey: "attachment:1",
        contentIdentity,
      };
      const rows = await Promise.all(
        Array.from({ length: 4 }, () => files.files.create(context, input)),
      );
      original = rows[0]!;
      expect(new Set(rows.map((f) => f.id)).size).toBe(1);
      expect(await files.files.create(context, input)).toEqual(original);
      await expect(
        files.files.create(context, { ...input, name: "changed" }),
      ).rejects.toMatchObject({ status: 409 });
      const copies = await Promise.all(
        [1, 2].map(() =>
          files.files.create(context, {
            sourceFileId: original.id,
            folderId: null,
            name: "copy",
            idempotencyKey: "copy:1",
          }),
        ),
      );
      expect(copies[0]!.id).toBe(copies[1]!.id);
      // Persist an intent whose transient upload is unavailable, then recover after restart.
      await expect(
        files.files.create(context, {
          ...input,
          idempotencyKey: "attachment:pending",
          uploadId: "expired" as typeof item.id,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await files.receipts.get(context, {
          operation: "file.create",
          key: "attachment:pending",
        }),
      ).toMatchObject({ status: "pending", result: null });
      // Fail after the physical write but before the file transaction commits.
      const faultUpload = await files.uploads.begin(context, {
        filename: "fault.txt",
        mime: "text/plain",
        size: 6,
      });
      await files.uploads.write(context, {
        uploadId: faultUpload.id,
        offset: 0,
        bytes: new TextEncoder().encode("recover").slice(0, 6),
      });
      const fault = await files.uploads.complete(context, {
        uploadId: faultUpload.id,
      });
      pluginServices(db).policies.set("fault", {
        id: "fault",
        check: async () => {
          throw new Error("injected commit failure");
        },
      });
      await expect(
        files.files.create(context, {
          folderId: null,
          name: "fault.txt",
          uploadId: fault.id,
          contentIdentity: fault.contentIdentity!,
          idempotencyKey: "fault",
        }),
      ).rejects.toThrow("injected commit failure");
      pluginServices(db).policies.clear();
      expect(
        await files.receipts.get(context, {
          operation: "file.create",
          key: "fault",
        }),
      ).toMatchObject({ status: "pending" });
    });
    await db.destroy();
    db = await openTestDatabase(config);
    await run(async (files) => {
      expect((await files.folders.create(context, folderInput)).id).toBe(
        folderId,
      );
      const item = await upload(files);
      const input = {
        folderId: null,
        name: "hello.txt",
        uploadId: item.id,
        idempotencyKey: "attachment:1",
        contentIdentity: contentIdentity!,
      };
      expect(await files.files.create(context, input)).toEqual(original!);
      const recovered = await files.files.create(context, {
        ...input,
        idempotencyKey: "attachment:pending",
      });
      expect(recovered.id).not.toBe(original!.id);
      expect(
        await files.receipts.get(context, {
          operation: "file.create",
          key: "attachment:pending",
        }),
      ).toMatchObject({ status: "completed", result: recovered });
      await files.files.delete(context, {
        fileId: original!.id,
        expectedVersion: original!.version,
      });
      await expect(files.files.create(context, input)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        files.receipts.get(context, {
          operation: "file.create",
          key: "attachment:1",
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (await db.selectFrom("file_items").selectAll().execute()).length,
      ).toBe(3);
      const pending = await db
        .selectFrom("file_operation_receipts")
        .selectAll()
        .where("operation_key", "=", "fault")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("file_operation_receipts")
        .set({ created_at: "2000-01-01T00:00:00.000Z" })
        .where("operation_key", "=", "fault")
        .execute();
      const path = join(storage.root, pending.object_key!);
      await access(path);
      await writeFile(
        path + ".pending-00000000-0000-0000-0000-000000000000",
        "partial",
      );
      expect(await cleanupFileReceipts(db, storage)).toBeGreaterThan(0);
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(path + ".pending-00000000-0000-0000-0000-000000000000"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // Committed content is never reclaimed along with abandoned staging bytes.
      const live = await files.content.read!(context, { fileId: recovered.id });
      const chunks = [];
      for await (const chunk of live.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("hello");
      const faultUpload = await files.uploads.begin(context, {
        filename: "fault.txt",
        mime: "text/plain",
        size: 6,
      });
      await files.uploads.write(context, {
        uploadId: faultUpload.id,
        offset: 0,
        bytes: new TextEncoder().encode("recove"),
      });
      const fault = await files.uploads.complete(context, {
        uploadId: faultUpload.id,
      });
      const recoveredFault = await files.files.create(context, {
        folderId: null,
        name: "fault.txt",
        uploadId: fault.id,
        contentIdentity: fault.contentIdentity!,
        idempotencyKey: "fault",
      });
      const stored = await db
        .selectFrom("file_items")
        .selectAll()
        .where("id", "=", recoveredFault.id)
        .executeTakeFirstOrThrow();
      expect(stored.storage_object_id).toBe(pending.object_id);
    });
    await run(async (files) => {
      expect((await files.folders.create(context, folderInput)).id).not.toBe(
        folderId,
      );
      expect(
        await files.receipts.get(context, {
          operation: "file.create",
          key: "attachment:1",
        }),
      ).toBeNull();
    }, "example.calendar");
    await db
      .updateTable("users")
      .set({ status: "disabled" })
      .where("id", "=", user.id)
      .execute();
    await run(async (files) => {
      await expect(
        files.folders.create(context, folderInput),
      ).rejects.toMatchObject({ status: 401 });
    });
  } finally {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
