import type {
  SearchAliasSwap,
  SearchIndexMetadata,
  SearchProjection,
  SearchProvider,
  SearchProviderHit,
  SearchProviderQuery,
  SearchSourceDescriptor,
  SearchTombstone,
} from "./types.js";

interface MemoryIndex {
  readonly metadata: SearchIndexMetadata;
  readonly documents: Map<string, SearchProjection>;
}

export interface InMemorySearchProviderOptions {
  readonly now?: () => Date;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyDescriptor(
  descriptor: SearchSourceDescriptor,
): SearchSourceDescriptor {
  return {
    pluginId: descriptor.pluginId,
    sourceId: descriptor.sourceId,
    schemaVersion: descriptor.schemaVersion,
    renderer: { ...descriptor.renderer },
  };
}

function copyProjection(projection: SearchProjection): SearchProjection {
  return {
    id: projection.id,
    text: projection.text,
    metadata: projection.metadata ? { ...projection.metadata } : undefined,
  };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const match = haystack.indexOf(needle, offset);
    if (match < 0) break;
    count++;
    offset = match + needle.length;
  }
  return count;
}

/**
 * A deterministic provider intended for unit tests and local composition. It
 * implements the same engine-neutral lifecycle used by production adapters.
 */
export class InMemorySearchProvider implements SearchProvider {
  readonly #indices = new Map<string, MemoryIndex>();
  readonly #aliases = new Map<string, string>();
  readonly #tombstones = new Map<string, Map<string, SearchTombstone>>();
  readonly #queryFailures = new Map<string, unknown>();
  readonly #now: () => Date;

  constructor(options: InMemorySearchProviderOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async createIndex(
    name: string,
    descriptor: SearchSourceDescriptor,
  ): Promise<void> {
    if (this.#indices.has(name))
      throw new Error(`Search index already exists: ${name}`);
    this.#indices.set(name, {
      metadata: {
        name,
        descriptor: copyDescriptor(descriptor),
        createdAt: this.#now().toISOString(),
      },
      documents: new Map(),
    });
  }

  async deleteIndex(name: string): Promise<void> {
    this.#indices.delete(name);
    for (const [alias, target] of this.#aliases)
      if (target === name) this.#aliases.delete(alias);
    this.#queryFailures.delete(name);
  }

  async inspectIndex(name: string): Promise<SearchIndexMetadata | undefined> {
    const metadata = this.#indices.get(name)?.metadata;
    return metadata
      ? { ...metadata, descriptor: copyDescriptor(metadata.descriptor) }
      : undefined;
  }

  async resolveAlias(alias: string): Promise<string | undefined> {
    return this.#aliases.get(alias);
  }

  async swapAlias(
    alias: string,
    indexName: string,
  ): Promise<SearchAliasSwap> {
    if (!this.#indices.has(indexName))
      throw new Error(`Search index does not exist: ${indexName}`);
    const previous = this.#aliases.get(alias);
    this.#aliases.set(alias, indexName);
    return {
      activeIndex: indexName,
      ...(previous ? { previousIndex: previous } : {}),
    };
  }

  async upsertProjections(
    indexName: string,
    projections: readonly SearchProjection[],
  ): Promise<void> {
    const index = this.#requireIndex(indexName);
    for (const projection of projections)
      index.documents.set(projection.id, copyProjection(projection));
  }

  async deleteProjections(
    indexName: string,
    documentIds: readonly string[],
  ): Promise<void> {
    const index = this.#requireIndex(indexName);
    for (const id of documentIds) index.documents.delete(id);
  }

  async queryIndex(
    indexName: string,
    request: SearchProviderQuery,
  ): Promise<readonly SearchProviderHit[]> {
    const resolved = this.#aliases.get(indexName) ?? indexName;
    if (this.#queryFailures.has(resolved))
      throw this.#queryFailures.get(resolved);
    const index = this.#requireIndex(resolved);
    const query = request.query.normalize("NFKC").toLowerCase();
    const terms = query.trim() ? query.trim().split(/\s+/u) : [];
    const candidates = request.candidateIds
      ? new Set(request.candidateIds)
      : undefined;
    const hits: SearchProviderHit[] = [];
    for (const projection of index.documents.values()) {
      if (candidates && !candidates.has(projection.id)) continue;
      const text = projection.text.normalize("NFKC").toLowerCase();
      const score =
        terms.length === 0
          ? 1
          : terms.reduce((total, term) => total + occurrences(text, term), 0);
      if (score > 0) hits.push({ id: projection.id, score });
    }
    const ranked = hits.sort(
      (left, right) =>
        right.score - left.score || compareText(left.id, right.id),
    );
    return request.limit === undefined
      ? ranked
      : ranked.slice(0, request.limit);
  }

  async putTombstones(tombstones: readonly SearchTombstone[]): Promise<void> {
    for (const tombstone of tombstones) {
      let source = this.#tombstones.get(tombstone.sourceKey);
      if (!source) {
        source = new Map();
        this.#tombstones.set(tombstone.sourceKey, source);
      }
      source.set(tombstone.documentId, { ...tombstone });
    }
  }

  async deleteTombstones(
    sourceKey: string,
    documentIds: readonly string[],
  ): Promise<void> {
    const source = this.#tombstones.get(sourceKey);
    if (!source) return;
    for (const id of documentIds) source.delete(id);
    if (source.size === 0) this.#tombstones.delete(sourceKey);
  }

  async listTombstones(sourceKey: string): Promise<readonly SearchTombstone[]> {
    return [...(this.#tombstones.get(sourceKey)?.values() ?? [])]
      .sort((left, right) => compareText(left.documentId, right.documentId))
      .map((tombstone) => ({ ...tombstone }));
  }

  setQueryFailure(indexName: string, error?: unknown): void {
    const resolved = this.#aliases.get(indexName) ?? indexName;
    if (error === undefined) this.#queryFailures.delete(resolved);
    else this.#queryFailures.set(resolved, error);
  }

  listIndexes(): readonly string[] {
    return [...this.#indices.keys()].sort(compareText);
  }

  getProjection(
    indexName: string,
    documentId: string,
  ): SearchProjection | undefined {
    const resolved = this.#aliases.get(indexName) ?? indexName;
    const projection = this.#indices.get(resolved)?.documents.get(documentId);
    return projection ? copyProjection(projection) : undefined;
  }

  #requireIndex(name: string): MemoryIndex {
    const index = this.#indices.get(name);
    if (!index) throw new Error(`Search index does not exist: ${name}`);
    return index;
  }
}
