import { vi } from "vitest";
import type {
  MaterialCard,
  MaterialCollectionCard,
  MaterialFilter,
  ResourceFilter,
  CreationResourceRef,
} from "@smartdoca/plugin-contracts";
import type { MaterialProvider } from "@smartdoca/plugin-sdk/creation-resources";
import type { DB } from "@db/index.js";
import { createMaterialsService } from "@core/modules/creation-resources/service.js";

export function installMaterialCollections(
  db: DB,
  providerId = "example.palette.library",
) {
  const ref = (id: string): CreationResourceRef => ({
    providerId,
    id,
    revision: "1",
  });
  const contract = { id: "doca.material.image", version: 1 };
  const contentType = { id: "image/png", version: 1 };
  const groups: MaterialCollectionCard[] = [
    "Warm palette",
    "Summer palette",
  ].map((title, i) => ({
    ref: ref("group" + i),
    title,
    summary: "Palette theme",
    tags: ["doca.tag.theme"],
    updatedAt: "2026-10-03T00:00:00Z",
    contracts: [contract],
    contentTypes: [contentType],
    count: i === 0 ? 2 : 1,
  }));
  const cards: MaterialCard[] = ["Red", "Orange", "Standalone"].map(
    (title, i) => ({
      ref: ref("asset" + i),
      title,
      summary: "Palette color",
      tags: ["doca.tag.color"],
      updatedAt: "2026-10-03T00:00:00Z",
      contract,
      contentType,
      parameters: { type: "object" },
      license: "Fixture only",
      collections:
        i === 0 ? groups.map((g) => g.ref) : i === 1 ? [groups[0]!.ref] : [],
    }),
  );
  const hidden = new Set<string>();
  const matches = (
    card: MaterialCard | MaterialCollectionCard,
    f: MaterialFilter,
  ) =>
    !hidden.has(card.ref.id) &&
    (!f.query ||
      (card.title + " " + card.summary)
        .toLowerCase()
        .includes(f.query.toLowerCase())) &&
    (!f.tags || f.tags.every((tag) => card.tags.includes(tag))) &&
    (!f.collectionRefs ||
      ("collections" in card &&
        f.collectionRefs.some((r) =>
          card.collections.some(
            (x) => x.id === r.id && x.revision === r.revision,
          ),
        )));
  const visible = <T extends MaterialCard | MaterialCollectionCard>(
    list: T[],
    f: MaterialFilter,
  ) =>
    list
      .filter((c) => matches(c, f))
      .sort((a, b) =>
        f.sort === "name"
          ? a.title.localeCompare(b.title)
          : a.ref.id.localeCompare(b.ref.id),
      );
  const page = <T extends MaterialCard | MaterialCollectionCard>(
    list: T[],
    f: MaterialFilter & { cursor: string | null; limit: number },
  ) => {
    const rows = visible(list, f),
      start = Number(f.cursor ?? 0),
      end = start + Math.min(2, f.limit);
    return {
      items: rows.slice(start, end),
      nextCursor: end < rows.length ? String(end) : null,
    };
  };
  const materialHit = ({
    preview: _preview,
    parameters: _parameters,
    license: _license,
    updatedAt: _updatedAt,
    ...hit
  }: MaterialCard) => hit;
  const groupHit = ({
    preview: _preview,
    updatedAt: _updatedAt,
    ...hit
  }: MaterialCollectionCard) => hit;
  const materialSearch = vi.fn(async (_c, f) => page(cards, f));
  const groupSearch = vi.fn(async (_c, f) => page(groups, f));
  const materialRetrieve = vi.fn(async (_c, f) => {
    const rows = visible(cards, f);
    return {
      items: rows.slice(0, f.topK).map(materialHit),
      mode: "keyword" as const,
      hasMore: rows.length > f.topK,
    };
  });
  const groupRetrieve = vi.fn(async (_c, f) => {
    const rows = visible(groups, f);
    return {
      items: rows.slice(0, f.topK).map(groupHit),
      mode: "keyword" as const,
      hasMore: rows.length > f.topK,
    };
  });
  const importer = vi.fn(async () => ({ fileId: crypto.randomUUID() }));
  const provider: MaterialProvider = {
    id: providerId,
    pluginId: "example.palette",
    version: 2,
    title: { zh: "主题素材库", en: "Palette library" },
    description: { zh: "测试来源", en: "Fixture source" },
    contracts: [contract],
    contentTypes: [contentType],
    sorts: ["updated", "name"],
    retrieval: { modes: ["keyword"] },
    search: materialSearch,
    retrieve: materialRetrieve,
    describe: async (_c, r) =>
      hidden.has(r.id) ? null : (cards.find((x) => x.ref.id === r.id) ?? null),
    tags: async (_c, f) =>
      visible(cards, f).length
        ? [{ id: "doca.tag.color", title: { zh: "颜色", en: "Color" } }]
        : [],
    collections: {
      retrieval: { modes: ["keyword"] },
      search: groupSearch,
      retrieve: groupRetrieve,
      describe: async (_c, r) =>
        hidden.has(r.id)
          ? null
          : (groups.find((x) => x.ref.id === r.id) ?? null),
      tags: async (_c, f: ResourceFilter) =>
        visible(groups, f).length
          ? [{ id: "doca.tag.theme", title: { zh: "主题", en: "Theme" } }]
          : [],
    },
    import: importer,
  };
  const dispose = createMaterialsService(db).register(provider);
  return {
    provider,
    cards,
    groups,
    hidden,
    dispose,
    materialSearch,
    groupSearch,
    materialRetrieve,
    groupRetrieve,
    importer,
  };
}
