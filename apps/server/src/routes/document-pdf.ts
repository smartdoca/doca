import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { authorize } from "@core/modules/access/queries.js";
import { fail } from "@core/shared/errors.js";
import { PDF_RENDER_MAX_BYTES, renderDocumentPdf } from "../services/document-pdf.js";

export function registerDocumentPdf(api: FastifyInstance, db: DB, actor: (request: FastifyRequest) => Actor | null) {
  api.post<{ Params: { id: string } }>("/api/v1/resources/:id/pdf", { bodyLimit: PDF_RENDER_MAX_BYTES }, async (req, reply) => {
    const principal = actor(req);
    const { resource } = await authorize(db, principal, req.params.id, "read_content");
    if (!["rich_text", "markdown"].includes(resource.format)) fail(400, "pdf_format_unsupported");
    const parsed = z.object({ html: z.string().min(1), width: z.number().int().min(400).max(2000) }).strict().safeParse(req.body);
    if (!parsed.success) fail(400, "pdf_invalid_request");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const bytes = await renderDocumentPdf(parsed.data.html, parsed.data.width, controller.signal);
      await authorize(db, principal, resource.id, "read_content");
      return reply.header("Cache-Control", "no-store").type("application/pdf").send(bytes);
    } finally {
      req.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    }
  });
}
