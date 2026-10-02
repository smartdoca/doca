import type { DB } from "@db/index.js";
import type {
  JsonValue,
  CreationResourceCard,
} from "@smartdoca/plugin-contracts";
import type { TemplateProvider } from "@smartdoca/plugin-sdk/creation-resources";
import { createTemplatesService } from "@core/modules/creation-resources/service.js";
import {
  documentTemplateType,
  nativeTemplateType,
} from "@core/modules/creation-resources/document-template.js";
export function installTemplate(
  db: DB,
  format: string,
  content: unknown,
  id = "example.templates.source",
) {
  const card: CreationResourceCard = {
    ref: { providerId: id, id: "template", revision: "1" },
    title: "Template",
    summary: "Test",
    preview:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    tags: ["doca.tag.report"],
    updatedAt: "2026-10-02T00:00:00Z",
    contract: documentTemplateType(format),
    contentType: nativeTemplateType(format),
    parameters: { type: "object", properties: {}, additionalProperties: false },
    license: "Test only",
  };
  const provider: TemplateProvider = {
    id,
    pluginId: "example.templates",
    version: 1,
    title: { zh: "测试", en: "Test" },
    contracts: [card.contract],
    contentTypes: [card.contentType],
    sorts: ["updated", "name"],
    async tags() {
      return [{ id: "doca.tag.report", title: { zh: "汇报", en: "Report" } }];
    },
    async search() {
      return { items: [card], nextCursor: null };
    },
    async describe() {
      return card;
    },
    async read() {
      return {
        contract: card.contract,
        contentType: card.contentType,
        content: content as JsonValue,
        assets: [],
      };
    },
  };
  const dispose = createTemplatesService(db).register(provider);
  return {
    selection: { ref: card.ref, parameters: {} },
    provider,
    card,
    dispose,
  };
}
