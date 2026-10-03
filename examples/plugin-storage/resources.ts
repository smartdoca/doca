import {
  templatesServiceToken,
  materialsServiceToken,
  type CreationResourceCard,
} from "@smartdoca/plugin-sdk/creation-resources";
import { filesServiceToken } from "@smartdoca/plugin-sdk/files";
import type { PluginLifecycleContext } from "@smartdoca/plugin-sdk";
import preview from "./preview.json";
export function registerResources(
  ctx: PluginLifecycleContext,
  pluginId: string,
) {
  const common = {
    parameters: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
    tags: [],
    updatedAt: "2026-10-03T00:00:00Z",
    license: "MIT",
    preview: preview.dataUrl,
  };
  const material: CreationResourceCard = {
    ...common,
    ref: { providerId: pluginId + ".images", id: "sample", revision: "1" },
    title: "SDK sample image",
    summary: "Imported through files.v1",
    contract: { id: "doca.material.image", version: 1 },
    contentType: { id: "image/png", version: 1 },
  };
  ctx.inject(materialsServiceToken).register({
    id: material.ref.providerId,
    pluginId,
    version: 1,
    title: { zh: "SDK 验收素材", en: "SDK acceptance materials" },
    contracts: [material.contract],
    contentTypes: [material.contentType],
    sorts: ["updated", "name"],
    async tags() {
      return [];
    },
    async search() {
      return { items: [material], nextCursor: null };
    },
    async describe(_, ref) {
      return ref.id === material.ref.id && ref.revision === "1"
        ? material
        : null;
    },
    async import(context, input) {
      const files = ctx.inject(filesServiceToken);
      const request = {
        principalId: context.principal.id,
        signal: context.signal,
      };
      const bytes = Uint8Array.from(atob(preview.dataUrl.split(",")[1]!), (c) =>
        c.charCodeAt(0),
      );
      const upload = await files.uploads.begin(request, {
        filename: "sdk-material.png",
        mime: "image/png",
        size: bytes.length,
      });
      await files.uploads.write(request, {
        uploadId: upload.id,
        offset: 0,
        bytes,
      });
      const completed = await files.uploads.complete(request, {
        uploadId: upload.id,
      });
      const file = await files.files.create(request, {
        folderId: null,
        name: "sdk-material.png",
        uploadId: upload.id,
        contentIdentity: completed.contentIdentity,
        idempotencyKey: input.operationKey,
      });
      return { fileId: file.id };
    },
  });
  const template: CreationResourceCard = {
    ...common,
    ref: { providerId: pluginId + ".templates", id: "sample", revision: "1" },
    title: "SDK template",
    summary: "Public template with registered material",
    contract: { id: "doca.document.markdown", version: 1 },
    contentType: { id: "doca.native.markdown", version: 1 },
  };
  ctx.inject(templatesServiceToken).register({
    id: template.ref.providerId,
    pluginId,
    version: 1,
    title: { zh: "SDK 验收模板", en: "SDK acceptance templates" },
    contracts: [template.contract],
    contentTypes: [template.contentType],
    sorts: ["updated", "name"],
    async tags() {
      return [];
    },
    async search(_, input) {
      return {
        items:
          !input.query ||
          template.title.toLowerCase().includes(input.query.toLowerCase())
            ? [template]
            : [],
        nextCursor: null,
      };
    },
    async describe(_, ref) {
      return ref.id === template.ref.id && ref.revision === "1"
        ? template
        : null;
    },
    async read() {
      return {
        contract: template.contract,
        contentType: template.contentType,
        content:
          "# SDK template\n\nRegistered through the public SDK.\n\n![SDK material](material:sample)",
        assets: [{ key: "sample", ref: material.ref }],
      };
    },
  });
}
