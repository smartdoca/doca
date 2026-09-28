import {
  searchSourceKey,
  type SearchAliasSwap,
  type SearchIndexMetadata,
  type SearchProjection,
  type SearchProvider,
  type SearchProviderHit,
  type SearchProviderQuery,
  type SearchSourceDescriptor,
  type SearchTombstone,
} from "@doca/search-host";

export interface MeilisearchConnection {
  readonly endpoint: string;
  readonly index_name: string;
}

export class SearchRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail = "",
  ) {
    super(
      detail
        ? `Meilisearch 请求失败（${status}）：${detail}`
        : `Meilisearch 请求失败（${status}）`,
    );
    this.name = "SearchRequestError";
  }
}

export interface MeilisearchSearchProviderOptions<
  TConnection extends MeilisearchConnection,
> {
  readonly config: () => Promise<TConnection>;
  readonly request: (
    config: TConnection,
    path: string,
    method?: string,
    body?: unknown,
    timeoutMs?: number,
  ) => Promise<any>;
  readonly waitTask: (config: TConnection, task: any) => Promise<void>;
  readonly replicaEmbedders?: (remote: Record<string, any>) => Promise<Record<string, unknown>>;
  readonly queryEmbedder?: () => Promise<string | undefined>;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
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

/**
 * Meilisearch has atomic index swaps but no aliases. Stable active indexes
 * emulate aliases while versioned indexes retain the previous contents after
 * a swap. The configured index name remains the active document index so
 * administration and embedding configuration address the same index.
 */
export class MeilisearchSearchProvider<
  TConnection extends MeilisearchConnection,
> implements SearchProvider
{
  readonly #options: MeilisearchSearchProviderOptions<TConnection>;
  readonly #aliasDescriptors = new Map<string, SearchSourceDescriptor>();
  readonly #metadata = new Map<string, SearchSourceDescriptor>();
  readonly #configuredSources = new Set<string>();
  readonly #physicalOverrides = new Map<string, string>();
  readonly #initializedConfiguredTargets = new Set<string>();
  readonly #tombstones = new Map<string, Map<string, SearchTombstone>>();
  readonly #embedderFingerprints = new Map<string, string>();

  constructor(options: MeilisearchSearchProviderOptions<TConnection>) {
    this.#options = options;
  }

  bindAlias(
    alias: string,
    descriptor: SearchSourceDescriptor,
    options: { useConfiguredIndex?: boolean } = {},
  ): void {
    this.#aliasDescriptors.set(alias, copyDescriptor(descriptor));
    if (options.useConfiguredIndex)
      this.#configuredSources.add(searchSourceKey(descriptor));
  }

  async createIndex(
    name: string,
    descriptor: SearchSourceDescriptor,
  ): Promise<void> {
    const config = await this.#options.config();
    const target = this.#target(config);
    const sourceKey = searchSourceKey(descriptor);
    let physical = this.#physical(config, name);
    if (
      this.#configuredSources.has(sourceKey) &&
      !this.#initializedConfiguredTargets.has(target)
    ) {
      physical = config.index_name;
      this.#physicalOverrides.set(this.#logicalKey(config, name), physical);
      this.#initializedConfiguredTargets.add(target);
    }
    if (!(await this.#exists(config, physical))) {
      await this.#options.waitTask(
        config,
        await this.#options.request(config, "/indexes", "POST", {
          uid: physical,
          primaryKey: "id",
        }),
      );
    }
    await this.#configureIndex(config, physical);
    this.#metadata.set(this.#logicalKey(config, name), copyDescriptor(descriptor));
  }

  async deleteIndex(name: string): Promise<void> {
    const config = await this.#options.config();
    const physical = this.#physical(config, name);
    try {
      await this.#options.waitTask(
        config,
        await this.#options.request(
          config,
          `/indexes/${encoded(physical)}`,
          "DELETE",
        ),
      );
    } catch (error) {
      if (!this.#notFound(error)) throw error;
    }
    this.#metadata.delete(this.#logicalKey(config, name));
    this.#physicalOverrides.delete(this.#logicalKey(config, name));
  }

  async inspectIndex(
    name: string,
  ): Promise<SearchIndexMetadata | undefined> {
    const config = await this.#options.config();
    const physical = this.#physical(config, name);
    if (!(await this.#exists(config, physical))) return undefined;
    const descriptor =
      this.#metadata.get(this.#logicalKey(config, name)) ??
      this.#aliasDescriptors.get(name);
    if (!descriptor) return undefined;
    return {
      name,
      descriptor: copyDescriptor(descriptor),
      createdAt: new Date(0).toISOString(),
    };
  }

  async resolveAlias(alias: string): Promise<string | undefined> {
    const config = await this.#options.config();
    const physical = this.#physical(config, alias);
    if (!(await this.#exists(config, physical))) return undefined;
    const descriptor = this.#aliasDescriptors.get(alias);
    if (descriptor && this.#configuredSources.has(searchSourceKey(descriptor)))
      this.#initializedConfiguredTargets.add(this.#target(config));
    return alias;
  }

  async swapAlias(alias: string, indexName: string): Promise<SearchAliasSwap> {
    const config = await this.#options.config();
    const aliasPhysical = this.#physical(config, alias);
    const indexPhysical = this.#physical(config, indexName);
    const targetDescriptor = this.#metadata.get(
      this.#logicalKey(config, indexName),
    );
    if (aliasPhysical === indexPhysical) {
      if (targetDescriptor)
        this.#metadata.set(
          this.#logicalKey(config, alias),
          copyDescriptor(targetDescriptor),
        );
      return { activeIndex: alias };
    }

    const aliasExists = await this.#exists(config, aliasPhysical);
    if (!aliasExists) {
      await this.#options.waitTask(
        config,
        await this.#options.request(config, "/indexes", "POST", {
          uid: aliasPhysical,
          primaryKey: "id",
        }),
      );
      await this.#configureIndex(config, aliasPhysical);
    }
    await this.#options.waitTask(
      config,
      await this.#options.request(config, "/swap-indexes", "POST", [
        { indexes: [aliasPhysical, indexPhysical] },
      ]),
    );

    const previousDescriptor =
      this.#metadata.get(this.#logicalKey(config, alias)) ??
      this.#aliasDescriptors.get(alias);
    if (targetDescriptor)
      this.#metadata.set(
        this.#logicalKey(config, alias),
        copyDescriptor(targetDescriptor),
      );
    if (previousDescriptor)
      this.#metadata.set(
        this.#logicalKey(config, indexName),
        copyDescriptor(previousDescriptor),
      );

    if (!aliasExists) {
      await this.deleteIndex(indexName);
      return { activeIndex: alias };
    }
    return { activeIndex: alias, previousIndex: indexName };
  }

  async upsertProjections(
    indexName: string,
    projections: readonly SearchProjection[],
  ): Promise<void> {
    if (!projections.length) return;
    const config = await this.#options.config();
    const physical = this.#physical(config, indexName);
    const changed: SearchProjection[] = [];
    for (const projection of projections) {
      const contentHash = projection.metadata?.content_hash;
      if (typeof contentHash !== "string") {
        changed.push(projection);
        continue;
      }
      try {
        const indexed = await this.#options.request(
          config,
          `/indexes/${encoded(physical)}/documents/${encoded(
            projection.id,
          )}?fields=id,content_hash`,
        );
        if (indexed?.content_hash !== contentHash) changed.push(projection);
      } catch (error) {
        if (this.#notFound(error)) changed.push(projection);
        else throw error;
      }
    }
    if (!changed.length) return;
    await this.#options.waitTask(
      config,
      await this.#options.request(
        config,
        `/indexes/${encoded(physical)}/documents?primaryKey=id`,
        "POST",
        changed.map((projection) => ({
          ...(projection.metadata ?? {}),
          id: projection.id,
          text: projection.text,
        })),
      ),
    );
  }

  async deleteProjections(
    indexName: string,
    documentIds: readonly string[],
  ): Promise<void> {
    if (!documentIds.length) return;
    const config = await this.#options.config();
    const physical = this.#physical(config, indexName);
    for (const id of documentIds) {
      try {
        await this.#options.waitTask(
          config,
          await this.#options.request(
            config,
            `/indexes/${encoded(physical)}/documents/${encoded(id)}`,
            "DELETE",
          ),
        );
      } catch (error) {
        if (!this.#notFound(error)) throw error;
      }
    }
  }

  async queryIndex(
    indexName: string,
    request: SearchProviderQuery,
  ): Promise<readonly SearchProviderHit[]> {
    const config = await this.#options.config();
    const physical = this.#physical(config, indexName);
    const embedder = request.semantic
      ? await this.#options.queryEmbedder?.()
      : undefined;
    // Queries consume an already prepared index. Updating embedder settings here
    // queues indexing work after every process restart and blocks live answers.
    // Index creation/publication owns settings synchronization.
    const candidates = request.candidateIds
      ? [...new Set(request.candidateIds)]
      : undefined;
    if (candidates && !candidates.length) return [];
    const data = await this.#options.request(
      config,
      `/indexes/${encoded(physical)}/search`,
      "POST",
      {
        q: request.query,
        limit: request.limit ?? candidates?.length ?? 100,
        attributesToRetrieve: ["id"],
        ...(candidates
          ? {
              filter: `id IN [${candidates
                .map((id) => JSON.stringify(id))
                .join(",")}]`,
            }
          : {}),
        ...(embedder
          ? {
              hybrid: { embedder, semanticRatio: 0.8 },
              showRankingScore: true,
              ...(request.rankingScoreThreshold === undefined
                ? {}
                : {
                    rankingScoreThreshold: request.rankingScoreThreshold,
                  }),
            }
          : {}),
      },
    );
    if (!Array.isArray(data.hits))
      throw new Error("Meilisearch returned invalid search hits");
    return data.hits.flatMap((hit: any, index: number) => {
      if (typeof hit?.id !== "string") return [];
      const score =
        typeof hit._rankingScore === "number" &&
        Number.isFinite(hit._rankingScore)
          ? hit._rankingScore
          : data.hits.length - index;
      if (
        embedder &&
        request.rankingScoreThreshold !== undefined &&
        score < request.rankingScoreThreshold
      )
        return [];
      return [{ id: hit.id, score }];
    });
  }

  async putTombstones(
    tombstones: readonly SearchTombstone[],
  ): Promise<void> {
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
    if (!source.size) this.#tombstones.delete(sourceKey);
  }

  async listTombstones(
    sourceKey: string,
  ): Promise<readonly SearchTombstone[]> {
    return [...(this.#tombstones.get(sourceKey)?.values() ?? [])].map(
      (value) => ({ ...value }),
    );
  }

  async listDocuments(
    indexName: string,
    offset: number,
    limit: number,
  ): Promise<unknown> {
    const config = await this.#options.config();
    const physical = this.#physical(config, indexName);
    if (!(await this.#exists(config, physical)))
      return { results: [], total: 0 };
    return this.#options.request(
      config,
      `/indexes/${encoded(
        physical,
      )}/documents?offset=${offset}&limit=${limit}&fields=id,content_hash`,
    );
  }

  #target(config: TConnection): string {
    return `${config.endpoint}\n${config.index_name}`;
  }

  #logicalKey(config: TConnection, logical: string): string {
    return `${this.#target(config)}\n${logical}`;
  }

  #physical(config: TConnection, logical: string): string {
    const override = this.#physicalOverrides.get(
      this.#logicalKey(config, logical),
    );
    if (override) return override;
    const descriptor = this.#aliasDescriptors.get(logical);
    if (descriptor && this.#configuredSources.has(searchSourceKey(descriptor)))
      return config.index_name;
    return `${config.index_name}__${logical}`;
  }

  async #exists(config: TConnection, physical: string): Promise<boolean> {
    try {
      await this.#options.request(config, `/indexes/${encoded(physical)}`);
      return true;
    } catch (error) {
      if (this.#notFound(error)) return false;
      throw error;
    }
  }

  #notFound(error: unknown): boolean {
    return error instanceof SearchRequestError && error.status === 404;
  }

  async #configureIndex(
    config: TConnection,
    physical: string,
  ): Promise<void> {
    // Apply current credentials before settings changes can regenerate vectors.
    if (physical !== config.index_name)
      await this.#syncEmbedders(config, physical);
    await this.#options.waitTask(
      config,
      await this.#options.request(
        config,
        `/indexes/${encoded(physical)}/settings`,
        "PATCH",
        {
          filterableAttributes: ["id", "reader_ids"],
          searchableAttributes: ["title", "text"],
          displayedAttributes: ["id"],
          pagination: { maxTotalHits: 10000 },
        },
      ),
    );
  }

  async #syncEmbedders(
    config: TConnection,
    physical: string,
  ): Promise<void> {
    let embedders: Record<string, unknown>;
    try {
      embedders = await this.#options.request(
        config,
        `/indexes/${encoded(config.index_name)}/settings/embedders`,
      );
    } catch (error) {
      if (this.#notFound(error)) return;
      throw error;
    }
    if(this.#options.replicaEmbedders)embedders=await this.#options.replicaEmbedders(embedders);
    const fingerprint = JSON.stringify(embedders);
    const key = `${this.#target(config)}\n${physical}`;
    if (
      !Object.keys(embedders).length ||
      this.#embedderFingerprints.get(key) === fingerprint
    )
      return;
    await this.#options.waitTask(
      config,
      await this.#options.request(
        config,
        `/indexes/${encoded(physical)}/settings/embedders`,
        "PATCH",
        embedders,
      ),
    );
    this.#embedderFingerprints.set(key, fingerprint);
  }
}
