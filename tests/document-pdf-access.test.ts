import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEditorDocument } from "@smartdoca/slate/headless";
import * as Y from "yjs";
import Fastify, { type FastifyInstance } from "fastify";
import type { DB } from "@db/index.js";
import { openTestDatabase } from "./database.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { restoreDocument } from "@core/modules/collaboration/documents.js";
import { registerDocumentPdf } from "@server/routes/document-pdf.js";
import { renderDocumentPdf } from "@server/services/document-pdf.js";

vi.mock("@server/services/document-pdf.js", () => ({ PDF_RENDER_MAX_BYTES: 32 * 1024 * 1024, renderDocumentPdf: vi.fn(async () => Buffer.from("%PDF-test")) }));
let db: DB, app: FastifyInstance, owner: Actor, principal: Actor | null;
beforeEach(async () => {
  vi.mocked(renderDocumentPdf).mockClear();
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = { ...await createUser(db, { login: "pdfowner", displayName: "PDF Owner", password: "pdf-access-test" }, { bootstrap: true }), admin: 1 };
  principal = owner;
  app = Fastify();
  app.setErrorHandler((error: any, _req, reply) => reply.status(error.status ?? 500).send({ message: error.message }));
  registerDocumentPdf(app, db, () => principal);
});
afterEach(async () => { await app.close(); await db.destroy(); });
const body = { html: "<p>Export view</p>", width: 794 };

it("permits readonly export, rejects inaccessible resources and leaves content/checkpoint unchanged", async () => {
  const content = createContent(db);
  const resource = await content.create(owner, { kind: "document", format: "rich_text", title: "PDF document", initialContent: createEditorDocument([{ id: "pdf-test-body", type: "paragraph", children: [{ text: "Isolated export content" }] }]) });
  await db.updateTable("resources").set({ access_mode: "custom", visibility: "public" }).where("id", "=", resource.id).execute();
  const before = await restoreDocument(db, resource.id);
  const checkpoint = Y.encodeStateAsUpdate(before.doc), seq = before.state?.seq;
  before.destroy();
  principal = null;
  const response = await app.inject({ method: "POST", url: `/api/v1/resources/${resource.id}/pdf`, payload: body });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/pdf");
  expect(response.headers["cache-control"]).toBe("no-store");
  const after = await restoreDocument(db, resource.id);
  try { expect(after.state?.seq).toBe(seq); expect(Y.encodeStateAsUpdate(after.doc)).toEqual(checkpoint); }
  finally { after.destroy(); }
  await db.updateTable("resources").set({ visibility: "invited" }).where("id", "=", resource.id).execute();
  expect((await app.inject({ method: "POST", url: `/api/v1/resources/${resource.id}/pdf`, payload: body })).statusCode).toBe(404);
  expect(renderDocumentPdf).toHaveBeenCalledTimes(1);
});

it("rechecks permission after rendering and rejects malformed dimensions before opening a browser", async () => {
  const resource = await createContent(db).create(owner, { kind: "document", format: "markdown", title: "Public markdown", markdown: "Isolated export content" });
  await db.updateTable("resources").set({ access_mode: "custom", visibility: "public" }).where("id", "=", resource.id).execute();
  principal = null;
  expect((await app.inject({ method: "POST", url: `/api/v1/resources/${resource.id}/pdf`, payload: { ...body, width: 0 } })).statusCode).toBe(400);
  expect(renderDocumentPdf).not.toHaveBeenCalled();
  vi.mocked(renderDocumentPdf).mockImplementationOnce(async () => {
    await db.updateTable("resources").set({ visibility: "invited" }).where("id", "=", resource.id).execute();
    return Buffer.from("%PDF-test");
  });
  expect((await app.inject({ method: "POST", url: `/api/v1/resources/${resource.id}/pdf`, payload: body })).statusCode).toBe(404);
});
