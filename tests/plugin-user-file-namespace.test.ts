import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { storageRuntime } from "@server/adapters/storage.js";
import { createServerFilesCapability } from "@server/plugins/files-capability-adapter.js";
import { scopeInstalledPlugin } from "@server/plugins/scope.js";
import { definePlugin } from "@smartdoca/plugin-sdk";
import {
  filesServiceToken,
  type FilesServiceV1,
} from "@smartdoca/plugin-sdk/files";
import { runPluginContractHarness } from "@smartdoca/plugin-sdk/testing";

it("attributes ordinary folders/files and deduplicates only inside the installed namespace", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "doca-user-file-namespace-"));
  try {
    const user = await createUser(
      db,
      {
        login: "namespace",
        displayName: "Namespace",
        password: "test-password-2026",
      },
      { bootstrap: true },
    );
    const context = { principalId: user.id };
    const files = createServerFilesCapability(db, {
      ...storageRuntime(),
      root,
    });
    const create = async (service: FilesServiceV1) => {
      const folder = await service.folders.create(context, {
        name: "same folder",
        parentId: null,
      });
      const upload = await service.uploads.begin(context, {
        filename: "same.txt",
        mime: "text/plain",
        size: 5,
      });
      await service.uploads.write(context, {
        uploadId: upload.id,
        offset: 0,
        bytes: new TextEncoder().encode("hello"),
      });
      await service.uploads.complete(context, { uploadId: upload.id });
      return service.files.create(context, {
        folderId: folder.id,
        uploadId: upload.id,
        name: "same.txt",
      });
    };
    await create(files);
    for (const id of ["example.a-b", "example.a.b"]) {
      await runPluginContractHarness(
        scopeInstalledPlugin(
          definePlugin({
            manifest: {
              schemaVersion: 1,
              id,
              version: "1.0.0",
              displayName: "Namespace",
            },
            async ready(ctx) {
              await create(ctx.inject(filesServiceToken));
              await create(ctx.inject(filesServiceToken));
            },
          }),
        ),
        { services: [{ token: filesServiceToken, value: files }] },
      );
    }
    const objects = await db
      .selectFrom("file_storage_objects")
      .selectAll()
      .execute();
    expect(objects).toHaveLength(3);
    const folders = await db.selectFrom("file_folders").selectAll().execute();
    const items = await db.selectFrom("file_items").selectAll().execute();
    for (const namespace of [
      "host",
      "plugins/example.a-b",
      "plugins/example.a.b",
    ]) {
      expect(folders.some((f) => f.storage_namespace === namespace)).toBe(true);
      expect(items.some((f) => f.storage_namespace === namespace)).toBe(true);
      expect(
        objects.filter((o) => o.object_key.startsWith(namespace + "/objects/")),
      ).toHaveLength(1);
    }
  } finally {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
