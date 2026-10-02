import { installTemplate } from "./creation-resource-fixtures.js";
import {
  createTemplatesService,
  createMaterialsService,
} from "@core/modules/creation-resources/service.js";
import { resourceRequest } from "@core/modules/creation-resources/document-template.js";
import { openTestDatabase } from "./database.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createContent } from "@core/workflows/resources.js";
import { restoreDocument } from "@core/modules/collaboration/documents.js";
import { restoreMarkdown } from "@core/modules/documents/codecs/markdown.js";
import { restoreSurface } from "@core/modules/documents/codecs/surfaces.js";
import { readDocument } from "@smartdoca/slides/core";
import { CanvasModel } from "@smartdoca/canvas/model";
import { projectExlsxWorkbook } from "@smartdoca/sheet/model";
import * as Y from "yjs";
import {
  blankTemplateContent,
} from "@core/modules/templates/templates.js";

let db: DB, admin: Actor, member: Actor;
beforeEach(async () => {
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  admin = {
    ...(await createUser(
      db,
      {
        login: "templates-admin",
        displayName: "模板管理员",
        password: "template-admin-2026",
      },
      { bootstrap: true },
    )),
    admin: 1,
  };
  member = {
    ...(await createUser(
      db,
      {
        login: "templates-member",
        displayName: "普通用户",
        password: "template-member-2026",
      },
      { actor: admin },
    )),
    admin: 0,
  };
});
afterEach(() => db.destroy());

it("starts with empty providers and preserves retired template rows", async () => {
  await db
    .insertInto("document_templates")
    .values({
      id: crypto.randomUUID(),
      format: "markdown",
      title: "Old",
      content: JSON.stringify("old"),
      preview: "",
      created_by: admin.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  expect(
    (await createTemplatesService(db).search(resourceRequest(member), {}))
      .items,
  ).toEqual([]);
  expect(
    await createMaterialsService(db).providers(resourceRequest(member), {}),
  ).toEqual([]);
  expect(
    await db.selectFrom("document_templates").selectAll().execute(),
  ).toHaveLength(1);
  await expect(
    createContent(db).create(member, {
      kind: "document",
      format: "markdown",
      title: "Old",
      templateId: "old",
    } as any),
  ).rejects.toThrow("Legacy templates");
});
it.each([
  "markdown",
  "rich_text",
  "spreadsheet",
  "canvas",
  "presentation",
] as const)(
  "initializes a new %s document from a plugin template",
  async (format) => {
    const native =
      format === "markdown"
        ? "# 周报\n\n本周完成"
        : blankTemplateContent(format);
    const template = installTemplate(db, format, native);
    const resource = await createContent(db).create(member, {
      kind: "document",
      format,
      title: "周报",
      template: template.selection,
    });
    const state = await db
      .selectFrom("document_states")
      .selectAll()
      .where("resource_id", "=", resource.id)
      .executeTakeFirst();
    expect(state).toBeTruthy();
    if (format === "markdown") {
      const loaded = await restoreMarkdown(db, resource.id);
      try {
        expect(loaded.doc.getText("markdown").toString()).toContain("本周完成");
      } finally {
        loaded.destroy();
      }
    }
    if (format === "rich_text") {
      const loaded = await restoreDocument(db, resource.id);
      try {
        expect(loaded.runtime.getValue()).toHaveLength(1);
      } finally {
        loaded.destroy();
      }
    }
    if (format === "spreadsheet") {
      const loaded = await restoreSurface(db, resource.id, format);
      expect(
        await projectExlsxWorkbook({
          baseline: loaded.baseline!,
          update: loaded.update,
          checkpointSeq: 0,
        }),
      ).toBeTruthy();
    }
    template.dispose();
    expect(
      (await createTemplatesService(db).search(resourceRequest(member), {}))
        .items,
    ).toEqual([]);
    expect(
      await db
        .selectFrom("document_states")
        .selectAll()
        .where("resource_id", "=", resource.id)
        .executeTakeFirst(),
    ).toBeTruthy();
  },
);
it("rejects incompatible templates and leaves no partial document", async () => {
  const template = installTemplate(db, "markdown", "hello");
  await expect(
    createContent(db).create(member, {
      kind: "document",
      format: "rich_text",
      title: "Wrong",
      template: template.selection,
    }),
  ).rejects.toThrow("format");
  expect(
    await db
      .selectFrom("resources")
      .selectAll()
      .where("title", "=", "Wrong")
      .execute(),
  ).toEqual([]);
});
