import type { FileId } from "@smartdoca/files-capability";

export const KNOWLEDGE_SOURCE_EFFECT_VERSION = 1 as const;
export const KNOWLEDGE_SOURCE_REGISTRY_SERVICE_ID =
  "knowledge.sources.v1" as const;

export type KnowledgeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly KnowledgeJsonValue[]
  | { readonly [key: string]: KnowledgeJsonValue };

export interface KnowledgeSourceEffectRef {
  readonly ownerPlugin: string;
  readonly sourceType: string;
}

export function knowledgeSourceEffectKey(
  effect: KnowledgeSourceEffectRef,
): string {
  return JSON.stringify([effect.ownerPlugin, effect.sourceType]);
}

export interface KnowledgeSourceConfigSchema<Config> {
  /** Stable schema identifier stored with source configuration. */
  readonly id: string;
  /** Serializable schema for hosts that render or persist configuration. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(input: unknown): Config;
}

export interface KnowledgeSourceContext {
  readonly installationId: string;
  readonly principalId: string;
  readonly signal?: AbortSignal;
}

export interface KnowledgeSourceValidation<Config> {
  readonly valid: boolean;
  readonly config?: Config;
  readonly issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];
}

export interface KnowledgeSourcePreview {
  readonly title: string;
  readonly description?: string;
  readonly estimatedRecords?: number;
  readonly sampleExternalIds?: readonly string[];
}

export interface KnowledgeSourceProvenance extends KnowledgeSourceEffectRef {
  /** Stable external source identity, not a mutable title or URL. */
  readonly externalId: string;
  readonly uri?: string;
  readonly observedAt: string;
  readonly parentExternalIds?: readonly string[];
  readonly metadata?: Readonly<Record<string, KnowledgeJsonValue>>;
}

export interface KnowledgeSourceReaderMapping {
  /** Identity as reported by the external source. */
  readonly externalReaderId: string;
  /** Stable local principal ID, or null when the identity is unresolved. */
  readonly readerId: string | null;
}

/**
 * A source record is upserted by (effect, externalId). externalVersion changes
 * only when source content or source-owned authorization changes.
 */
export interface KnowledgeSourceRecord {
  readonly externalId: string;
  readonly externalVersion: string;
  readonly title: string;
  readonly payload: KnowledgeJsonValue;
  readonly provenance: KnowledgeSourceProvenance;
  readonly readers: readonly KnowledgeSourceReaderMapping[];
  /** Stable file IDs resolved through the files capability. */
  readonly fileIds: readonly FileId[];
  readonly deleted?: boolean;
}

/**
 * Persisted host cursor. The effect owns cursor payload semantics; the host
 * owns effect identity, installation identity, and the update timestamp.
 */
export interface KnowledgeSourceCursorRecord<
  Cursor extends KnowledgeJsonValue = KnowledgeJsonValue,
> {
  readonly effect: KnowledgeSourceEffectRef;
  readonly installationId: string;
  readonly cursor: Cursor;
  readonly updatedAt: string;
}

export function createKnowledgeSourceCursorRecord<
  Cursor extends KnowledgeJsonValue,
>(
  input: KnowledgeSourceCursorRecord<Cursor>,
): KnowledgeSourceCursorRecord<Cursor> {
  if (!input.installationId.trim()) {
    throw new TypeError("A knowledge source installation ID cannot be empty");
  }
  if (!input.effect.ownerPlugin.trim() || !input.effect.sourceType.trim()) {
    throw new TypeError("Knowledge source cursor identity cannot be empty");
  }
  return Object.freeze({
    ...input,
    effect: Object.freeze({
      ownerPlugin: input.effect.ownerPlugin,
      sourceType: input.effect.sourceType,
    }),
  });
}

export interface KnowledgeSourcePullPage<
  Cursor extends KnowledgeJsonValue = KnowledgeJsonValue,
> {
  readonly records: readonly KnowledgeSourceRecord[];
  /** null means there is no next page or incremental checkpoint. */
  readonly nextCursor: Cursor | null;
  readonly done: boolean;
}

export interface KnowledgeSourceEffect<
  Config = unknown,
  Cursor extends KnowledgeJsonValue = KnowledgeJsonValue,
> extends KnowledgeSourceEffectRef {
  readonly version: typeof KNOWLEDGE_SOURCE_EFFECT_VERSION;
  readonly configSchema: KnowledgeSourceConfigSchema<Config>;
  /** Host renderer/catalog identifier; it is not executable UI code. */
  readonly configRendererId: string;
  validate(
    input: { readonly config: Config },
    context: KnowledgeSourceContext,
  ): Promise<KnowledgeSourceValidation<Config>>;
  preview(
    input: { readonly config: Config },
    context: KnowledgeSourceContext,
  ): Promise<KnowledgeSourcePreview>;
  pull(
    input: {
      readonly config: Config;
      readonly cursor: KnowledgeSourceCursorRecord<Cursor> | null;
      readonly limit?: number;
    },
    context: KnowledgeSourceContext,
  ): Promise<KnowledgeSourcePullPage<Cursor>>;
}

function assertNonempty(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} cannot be empty`);
}

export function assertKnowledgeSourceCursor<Cursor extends KnowledgeJsonValue>(
  effect: KnowledgeSourceEffectRef,
  installationId: string,
  cursor: KnowledgeSourceCursorRecord<Cursor> | null,
): void {
  if (!cursor) return;
  if (
    cursor.effect.ownerPlugin !== effect.ownerPlugin ||
    cursor.effect.sourceType !== effect.sourceType
  ) {
    throw new TypeError("Knowledge source cursor belongs to another effect");
  }
  if (cursor.installationId !== installationId) {
    throw new TypeError(
      "Knowledge source cursor belongs to another installation",
    );
  }
}

export function assertKnowledgeSourceRecord(
  effect: KnowledgeSourceEffectRef,
  record: KnowledgeSourceRecord,
): void {
  assertNonempty(record.externalId, "Knowledge source external ID");
  assertNonempty(record.externalVersion, "Knowledge source external version");
  assertNonempty(record.title, "Knowledge source title");
  if (
    record.provenance.ownerPlugin !== effect.ownerPlugin ||
    record.provenance.sourceType !== effect.sourceType ||
    record.provenance.externalId !== record.externalId
  ) {
    throw new TypeError(
      "Knowledge source provenance must match its effect and external ID",
    );
  }
  assertNonempty(record.provenance.observedAt, "Knowledge source observedAt");
  const readers = new Set<string>();
  for (const reader of record.readers) {
    assertNonempty(reader.externalReaderId, "Knowledge external reader ID");
    if (reader.readerId !== null) {
      assertNonempty(reader.readerId, "Knowledge local reader ID");
    }
    if (readers.has(reader.externalReaderId)) {
      throw new TypeError(
        `Duplicate knowledge external reader: ${reader.externalReaderId}`,
      );
    }
    readers.add(reader.externalReaderId);
  }
  const fileIds = new Set<string>();
  for (const fileId of record.fileIds) {
    assertNonempty(fileId, "Knowledge file ID");
    if (fileIds.has(fileId)) {
      throw new TypeError(`Duplicate knowledge file ID: ${fileId}`);
    }
    fileIds.add(fileId);
  }
}

export function assertKnowledgeSourcePullPage<
  Cursor extends KnowledgeJsonValue,
>(
  effect: KnowledgeSourceEffectRef,
  page: KnowledgeSourcePullPage<Cursor>,
): void {
  const externalIds = new Set<string>();
  for (const record of page.records) {
    assertKnowledgeSourceRecord(effect, record);
    if (externalIds.has(record.externalId)) {
      throw new TypeError(
        `Duplicate knowledge source record: ${record.externalId}`,
      );
    }
    externalIds.add(record.externalId);
  }
}

/**
 * Wraps an effect with cursor ownership and output provenance validation.
 * Provider adapters should use this at their boundary; the registry remains
 * open to external effects implementing the same contract.
 */
export function createValidatedKnowledgeSourceEffect<
  Config,
  Cursor extends KnowledgeJsonValue,
>(
  effect: KnowledgeSourceEffect<Config, Cursor>,
): KnowledgeSourceEffect<Config, Cursor> {
  const validated: KnowledgeSourceEffect<Config, Cursor> = {
    ...effect,
    async pull(request, context) {
      assertKnowledgeSourceCursor(
        effect,
        context.installationId,
        request.cursor,
      );
      const page = await effect.pull(request, context);
      assertKnowledgeSourcePullPage(effect, page);
      return page;
    },
  };
  return Object.freeze(validated);
}

type AnyKnowledgeSourceEffect = KnowledgeSourceEffect<any, any>;

export class DuplicateKnowledgeSourceEffectError extends Error {
  constructor(readonly key: string) {
    super(`Knowledge source effect is already registered: ${key}`);
    this.name = "DuplicateKnowledgeSourceEffectError";
  }
}

export class UnknownKnowledgeSourceEffectError extends Error {
  constructor(readonly key: string) {
    super(`Knowledge source effect is not registered: ${key}`);
    this.name = "UnknownKnowledgeSourceEffectError";
  }
}

export interface KnowledgeSourceRegistration {
  readonly key: string;
  readonly effect: AnyKnowledgeSourceEffect;
  /**
   * Removes only this registration. Disposal is idempotent and cannot remove a
   * later registration that reused the same key.
   */
  dispose(): boolean;
}

export interface KnowledgeSourceRegistryV1 {
  register<Config, Cursor extends KnowledgeJsonValue>(
    effect: KnowledgeSourceEffect<Config, Cursor>,
  ): KnowledgeSourceRegistration;
  get(
    effect: KnowledgeSourceEffectRef,
  ): KnowledgeSourceEffect<any, any> | undefined;
  require(effect: KnowledgeSourceEffectRef): KnowledgeSourceEffect<any, any>;
  has(effect: KnowledgeSourceEffectRef): boolean;
  list(): readonly KnowledgeSourceEffect<any, any>[];
}

/**
 * Runtime replacement for a closed source-kind union.
 *
 * Registrations are unique by (ownerPlugin, sourceType). Duplicate
 * registration fails instead of silently replacing behavior.
 */
export class KnowledgeSourceEffectRegistry implements KnowledgeSourceRegistryV1 {
  readonly #effects = new Map<string, AnyKnowledgeSourceEffect>();

  register<Config, Cursor extends KnowledgeJsonValue>(
    effect: KnowledgeSourceEffect<Config, Cursor>,
  ): KnowledgeSourceRegistration {
    if (
      !effect.ownerPlugin.trim() ||
      !effect.sourceType.trim() ||
      !effect.configRendererId.trim() ||
      !effect.configSchema.id.trim()
    ) {
      throw new TypeError(
        "Knowledge source effect identifiers cannot be empty",
      );
    }
    if (effect.version !== KNOWLEDGE_SOURCE_EFFECT_VERSION) {
      throw new TypeError(
        `Unsupported knowledge source effect version: ${effect.version}`,
      );
    }
    const key = knowledgeSourceEffectKey(effect);
    if (this.#effects.has(key)) {
      throw new DuplicateKnowledgeSourceEffectError(key);
    }
    this.#effects.set(key, effect);

    let active = true;
    return Object.freeze({
      key,
      effect,
      dispose: () => {
        if (!active) return false;
        active = false;
        if (this.#effects.get(key) !== effect) return false;
        this.#effects.delete(key);
        return true;
      },
    });
  }

  get(effect: KnowledgeSourceEffectRef): AnyKnowledgeSourceEffect | undefined {
    return this.#effects.get(knowledgeSourceEffectKey(effect));
  }

  require(effect: KnowledgeSourceEffectRef): AnyKnowledgeSourceEffect {
    const key = knowledgeSourceEffectKey(effect);
    const registered = this.#effects.get(key);
    if (!registered) throw new UnknownKnowledgeSourceEffectError(key);
    return registered;
  }

  has(effect: KnowledgeSourceEffectRef): boolean {
    return this.#effects.has(knowledgeSourceEffectKey(effect));
  }

  list(): readonly AnyKnowledgeSourceEffect[] {
    return Object.freeze([...this.#effects.values()]);
  }
}

export function createKnowledgeSourceEffectRegistry(): KnowledgeSourceEffectRegistry {
  return new KnowledgeSourceEffectRegistry();
}
