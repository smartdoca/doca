import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@core/modules/identity/passwords.js";
import {
  TEMPLATE_FORMATS,
  createTemplates,
} from "@core/modules/templates/templates.js";
import type { DB } from "@db/index.js";

export function registerTemplates(
  api: FastifyInstance,
  db: DB,
  authenticated: (req: FastifyRequest) => Actor,
  admin: (req: FastifyRequest) => Actor,
) {
  const templates = createTemplates(db);
  const id = Type.String({ format: "uuid" });
  const format = Type.Union(TEMPLATE_FORMATS.map((value) => Type.Literal(value)));
  const object = (properties: Record<string, TSchema>) =>
    Type.Object(properties, { additionalProperties: false });
  api.get<{ Querystring: { format?: string } }>(
    "/api/v1/templates",
    {
      schema: {
        summary: "列出可选用的文档模板",
        tags: ["Content"],
        querystring: object({ format: Type.Optional(format) }),
      },
    },
    async (req) => {
      authenticated(req);
      return templates.list(req.query.format);
    },
  );
  api.get<{ Params: { id: string } }>(
    "/api/v1/templates/:id",
    {
      schema: {
        summary: "读取文档模板内容",
        tags: ["Content"],
        params: object({ id }),
      },
    },
    async (req) => {
      authenticated(req);
      return templates.get(req.params.id);
    },
  );
  api.post<{
    Body: { format: string; title: string; content: unknown; preview?: string };
  }>(
    "/api/v1/admin/templates",
    {
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        summary: "创建文档模板",
        tags: ["Admin"],
        body: object({
          format,
          title: Type.String({ minLength: 1, maxLength: 160 }),
          content: Type.Unknown(),
          preview: Type.Optional(Type.String({ maxLength: 180000 })),
        }),
      },
    },
    async (req) => templates.create(admin(req), req.body),
  );
  api.patch<{
    Params: { id: string };
    Body: { title?: string; content?: unknown; preview?: string };
  }>(
    "/api/v1/admin/templates/:id",
    {
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        summary: "更新文档模板",
        tags: ["Admin"],
        params: object({ id }),
        body: object({
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
          content: Type.Optional(Type.Unknown()),
          preview: Type.Optional(Type.String({ maxLength: 180000 })),
        }),
      },
    },
    async (req) => templates.update(admin(req), req.params.id, req.body),
  );
  api.delete<{ Params: { id: string } }>(
    "/api/v1/admin/templates/:id",
    {
      schema: {
        summary: "删除文档模板",
        tags: ["Admin"],
        params: object({ id }),
      },
    },
    async (req) => templates.remove(admin(req), req.params.id),
  );
}
