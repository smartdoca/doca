import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { createServerFilesCapability } from "@server/plugins/files-capability-adapter.js";

it("rechecks binding authorization and never changes the original file ACL", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const root = await mkdtemp(join(tmpdir(), "doca-binding-"));
  try {
    const owner = await createUser(db, { login: "owner", displayName: "Owner", password: "test-password-2026" }, { bootstrap: true });
    const reader = await createUser(db, { login: "reader", displayName: "Reader", password: "test-password-2026" }, { actor: owner });
    const files = createServerFilesCapability(db, { root, credentials: {}, endpointHosts: [], cdnKeyPairId: undefined, cdnPrivateKey: undefined });
    const context = { principalId: owner.id };
    const upload = await files.uploads.begin(context, { filename: "attachment.txt", mime: "text/plain", size: 5 });
    await files.uploads.write(context, { uploadId: upload.id, offset: 0, bytes: new TextEncoder().encode("hello") });
    await files.uploads.complete(context, { uploadId: upload.id });
    const file = await files.files.create(context, { uploadId: upload.id, folderId: null, name: "attachment.txt" });
    const binding = await files.bindings.bind(context, { fileId: file.id, owner: { ownerPlugin: "example.mail", ownerType: "mailbox", ownerId: "inbox", role: "attachment" } });
    const request = { principalId: reader.id };
    await expect(files.content.read!(request, { fileId: file.id })).rejects.toMatchObject({ status: 404 });
    await expect(files.content.read!(request, { fileId: file.id, bindingId: binding.id })).rejects.toMatchObject({ status: 404 });
    let allowed = true;
    pluginServices(db).permissions.set("example.mail.mailbox", { pluginId: "example.mail", resourceType: "mailbox", async authorize(id, resource, action) { return allowed && id === reader.id && resource === "inbox" && action === "file.read"; } });
    const read = await files.content.read!(request, { fileId: file.id, bindingId: binding.id });
    const chunks = []; for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect((await files.content.resolveDownload(request, { fileId: file.id, bindingId: binding.id })).href).toContain("/plugin-file-bindings/");
    await expect(files.content.read!(request, { fileId: file.id })).rejects.toMatchObject({ status: 404 });
    allowed = false;
    await expect(files.content.read!(request, { fileId: file.id, bindingId: binding.id })).rejects.toMatchObject({ status: 404 });
    pluginServices(db).permissions.clear();
    await expect(files.content.read!(request, { fileId: file.id, bindingId: binding.id })).rejects.toMatchObject({ status: 404 });
  } finally { await db.destroy(); await rm(root, { recursive: true, force: true }); }
});
