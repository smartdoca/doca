export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type PluginRuntimePhase =
  "discover" | "initialize" | "migrate" | "mount" | "ready" | "dispose";

export type PluginRuntimeErrorCode =
  | "INVALID_MANIFEST"
  | "INVALID_CONFIG"
  | "DUPLICATE_PLUGIN"
  | "MISSING_DEPENDENCY"
  | "INCOMPATIBLE_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "MISSING_INJECTION"
  | "DUPLICATE_PROVIDER"
  | "CONTRIBUTION_COLLISION"
  | "CONTEXT_DISPOSED"
  | "LIFECYCLE_FAILED";

export class PluginContractError extends Error {
  readonly name = "PluginContractError";

  constructor(
    readonly code: PluginRuntimeErrorCode,
    message: string,
    readonly path = "$",
  ) {
    super(`${path}: ${message}`);
  }
}

export interface StringConfigSchema {
  readonly type: "string";
  readonly description?: string;
  readonly default?: string;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface NumberConfigSchema {
  readonly type: "number" | "integer";
  readonly description?: string;
  readonly default?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanConfigSchema {
  readonly type: "boolean";
  readonly description?: string;
  readonly default?: boolean;
}

export interface NullConfigSchema {
  readonly type: "null";
  readonly description?: string;
  readonly default?: null;
}

export interface ArrayConfigSchema {
  readonly type: "array";
  readonly description?: string;
  readonly default?: readonly JsonValue[];
  readonly items: DocaConfigSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ObjectConfigSchema {
  readonly type: "object";
  readonly description?: string;
  readonly default?: JsonObject;
  readonly properties?: Readonly<Record<string, DocaConfigSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/**
 * The deliberately small configuration schema understood by the Doca runtime.
 * It is not JSON Schema; unsupported keywords are rejected.
 */
export type DocaConfigSchema =
  | StringConfigSchema
  | NumberConfigSchema
  | BooleanConfigSchema
  | NullConfigSchema
  | ArrayConfigSchema
  | ObjectConfigSchema;

export interface PluginDependency {
  readonly id: string;
  /** Supported forms are `*`, an exact semver, `^x.y.z`, or `~x.y.z`. */
  readonly range: string;
  readonly optional?: boolean;
}

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  /** Doca SDK versions supported by this package. Uses the same range subset as dependencies. */
  readonly sdkRange?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly dependencies?: readonly PluginDependency[];
  readonly config?: ObjectConfigSchema;
  readonly contributions?: readonly PluginContributionDeclaration[];
}

export interface PluginContributionDeclaration {
  readonly id: string;
  readonly kind: string;
  readonly target?: "server" | "web" | "mobile";
}

export interface DocaPluginPackage {
  readonly package: string;
  readonly enabled?: boolean;
  readonly config?: JsonObject;
  readonly targets?: readonly ("server" | "web" | "mobile")[];
}

export interface DocaSystemConfig {
  readonly plugins: readonly DocaPluginPackage[];
}

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const configKeyPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const dependencyRangePattern =
  /^(?:\*|[\^~]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

function fail(
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
  path: string,
  message: string,
): never {
  throw new PluginContractError(code, message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function objectAt(
  value: unknown,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
): Record<string, unknown> {
  if (!isRecord(value)) fail(code, path, "expected an object");
  return value;
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
) {
  const set = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !set.has(key));
  if (unexpected) fail(code, `${path}.${unexpected}`, "unknown field");
}

function stringAt(
  value: unknown,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
  options: { nonempty?: boolean } = {},
) {
  if (
    typeof value !== "string" ||
    (options.nonempty && value.trim().length === 0)
  )
    fail(code, path, "expected a non-empty string");
  return value;
}

function finiteAt(
  value: unknown,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
) {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(code, path, "expected a finite number");
  return value;
}

function nonNegativeIntegerAt(
  value: unknown,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
) {
  const number = finiteAt(value, path, code);
  if (!Number.isInteger(number) || number < 0)
    fail(code, path, "expected a non-negative integer");
  return number;
}

function optionalDescription(
  value: Record<string, unknown>,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
) {
  if (value.description !== undefined)
    stringAt(value.description, `${path}.description`, code, {
      nonempty: true,
    });
}

function assertConfigSchema(value: unknown, path: string): DocaConfigSchema {
  const schema = objectAt(value, path, "INVALID_MANIFEST");
  const type = stringAt(
    schema.type,
    `${path}.type`,
    "INVALID_MANIFEST",
  ) as DocaConfigSchema["type"];
  const common = ["type", "description", "default"];
  optionalDescription(schema, path, "INVALID_MANIFEST");

  if (type === "string") {
    allowedKeys(
      schema,
      [...common, "enum", "minLength", "maxLength", "pattern"],
      path,
      "INVALID_MANIFEST",
    );
    if (schema.enum !== undefined) {
      if (
        !Array.isArray(schema.enum) ||
        schema.enum.some((item) => typeof item !== "string")
      )
        fail("INVALID_MANIFEST", `${path}.enum`, "expected string array");
      if (new Set(schema.enum).size !== schema.enum.length)
        fail("INVALID_MANIFEST", `${path}.enum`, "contains duplicate values");
    }
    const min =
      schema.minLength === undefined
        ? undefined
        : nonNegativeIntegerAt(
            schema.minLength,
            `${path}.minLength`,
            "INVALID_MANIFEST",
          );
    const max =
      schema.maxLength === undefined
        ? undefined
        : nonNegativeIntegerAt(
            schema.maxLength,
            `${path}.maxLength`,
            "INVALID_MANIFEST",
          );
    if (min !== undefined && max !== undefined && min > max)
      fail("INVALID_MANIFEST", path, "minLength cannot exceed maxLength");
    if (schema.pattern !== undefined) {
      const pattern = stringAt(
        schema.pattern,
        `${path}.pattern`,
        "INVALID_MANIFEST",
      );
      try {
        new RegExp(pattern);
      } catch {
        fail(
          "INVALID_MANIFEST",
          `${path}.pattern`,
          "invalid regular expression",
        );
      }
    }
  } else if (type === "number" || type === "integer") {
    allowedKeys(
      schema,
      [...common, "minimum", "maximum"],
      path,
      "INVALID_MANIFEST",
    );
    const minimum =
      schema.minimum === undefined
        ? undefined
        : finiteAt(schema.minimum, `${path}.minimum`, "INVALID_MANIFEST");
    const maximum =
      schema.maximum === undefined
        ? undefined
        : finiteAt(schema.maximum, `${path}.maximum`, "INVALID_MANIFEST");
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      fail("INVALID_MANIFEST", path, "minimum cannot exceed maximum");
  } else if (type === "boolean" || type === "null") {
    allowedKeys(schema, common, path, "INVALID_MANIFEST");
  } else if (type === "array") {
    allowedKeys(
      schema,
      [...common, "items", "minItems", "maxItems"],
      path,
      "INVALID_MANIFEST",
    );
    assertConfigSchema(schema.items, `${path}.items`);
    const min =
      schema.minItems === undefined
        ? undefined
        : nonNegativeIntegerAt(
            schema.minItems,
            `${path}.minItems`,
            "INVALID_MANIFEST",
          );
    const max =
      schema.maxItems === undefined
        ? undefined
        : nonNegativeIntegerAt(
            schema.maxItems,
            `${path}.maxItems`,
            "INVALID_MANIFEST",
          );
    if (min !== undefined && max !== undefined && min > max)
      fail("INVALID_MANIFEST", path, "minItems cannot exceed maxItems");
  } else if (type === "object") {
    allowedKeys(
      schema,
      [...common, "properties", "required", "additionalProperties"],
      path,
      "INVALID_MANIFEST",
    );
    const properties =
      schema.properties === undefined
        ? {}
        : objectAt(schema.properties, `${path}.properties`, "INVALID_MANIFEST");
    for (const [key, child] of Object.entries(properties)) {
      if (!configKeyPattern.test(key))
        fail(
          "INVALID_MANIFEST",
          `${path}.properties.${key}`,
          "property names must be stable alphanumeric identifiers",
        );
      assertConfigSchema(child, `${path}.properties.${key}`);
    }
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((item) => typeof item !== "string")
      )
        fail("INVALID_MANIFEST", `${path}.required`, "expected string array");
      if (new Set(schema.required).size !== schema.required.length)
        fail(
          "INVALID_MANIFEST",
          `${path}.required`,
          "contains duplicate values",
        );
      for (const key of schema.required)
        if (!Object.hasOwn(properties, key))
          fail(
            "INVALID_MANIFEST",
            `${path}.required`,
            `unknown required property ${key}`,
          );
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    )
      fail(
        "INVALID_MANIFEST",
        `${path}.additionalProperties`,
        "expected boolean",
      );
  } else {
    fail(
      "INVALID_MANIFEST",
      `${path}.type`,
      `unsupported configuration type ${String(type)}`,
    );
  }

  if (schema.default !== undefined)
    readConfigValue(
      schema as unknown as DocaConfigSchema,
      schema.default,
      `${path}.default`,
      "INVALID_MANIFEST",
    );
  return schema as unknown as DocaConfigSchema;
}

function readJson(
  value: unknown,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG",
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(code, path, "numbers must be finite");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      readJson(item, `${path}[${index}]`, code),
    );
  const object = objectAt(value, path, code);
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      readJson(item, `${path}.${key}`, code),
    ]),
  );
}

function readConfigValue(
  schema: DocaConfigSchema,
  input: unknown,
  path: string,
  code: "INVALID_MANIFEST" | "INVALID_CONFIG" = "INVALID_CONFIG",
): JsonValue {
  if (input === undefined) {
    if (schema.default !== undefined)
      return readConfigValue(schema, schema.default, path, code);
    fail(code, path, "value is required");
  }

  if (schema.type === "string") {
    if (typeof input !== "string") fail(code, path, "expected string");
    if (schema.minLength !== undefined && input.length < schema.minLength)
      fail(code, path, `must contain at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && input.length > schema.maxLength)
      fail(code, path, `must contain at most ${schema.maxLength} characters`);
    if (schema.enum && !schema.enum.includes(input))
      fail(code, path, "is not an allowed value");
    if (schema.pattern && !new RegExp(schema.pattern).test(input))
      fail(code, path, "does not match the required pattern");
    return input;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof input !== "number" || !Number.isFinite(input))
      fail(code, path, "expected finite number");
    if (schema.type === "integer" && !Number.isInteger(input))
      fail(code, path, "expected integer");
    if (schema.minimum !== undefined && input < schema.minimum)
      fail(code, path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && input > schema.maximum)
      fail(code, path, `must be at most ${schema.maximum}`);
    return input;
  }
  if (schema.type === "boolean") {
    if (typeof input !== "boolean") fail(code, path, "expected boolean");
    return input;
  }
  if (schema.type === "null") {
    if (input !== null) fail(code, path, "expected null");
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(input)) fail(code, path, "expected array");
    if (schema.minItems !== undefined && input.length < schema.minItems)
      fail(code, path, `must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && input.length > schema.maxItems)
      fail(code, path, `must contain at most ${schema.maxItems} items`);
    return input.map((item, index) =>
      readConfigValue(schema.items, item, `${path}[${index}]`, code),
    );
  }
  const objectSchema = schema as ObjectConfigSchema;
  const inputObject = objectAt(input, path, code);
  const properties = objectSchema.properties ?? {};
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of Object.entries(properties)) {
    if (Object.hasOwn(inputObject, key))
      result[key] = readConfigValue(
        child,
        inputObject[key],
        `${path}.${key}`,
        code,
      );
    else if (child.default !== undefined)
      result[key] = readConfigValue(
        child,
        child.default,
        `${path}.${key}`,
        code,
      );
    else if (objectSchema.required?.includes(key))
      fail(code, `${path}.${key}`, "value is required");
  }
  for (const [key, value] of Object.entries(inputObject)) {
    if (Object.hasOwn(properties, key)) continue;
    if (!objectSchema.additionalProperties)
      fail(code, `${path}.${key}`, "unknown configuration field");
    result[key] = readJson(value, `${path}.${key}`, code);
  }
  return { ...result };
}

export function validatePluginManifest(input: unknown): PluginManifest {
  const manifest = objectAt(input, "$", "INVALID_MANIFEST");
  allowedKeys(
    manifest,
    [
      "schemaVersion",
      "id",
      "version",
      "sdkRange",
      "displayName",
      "description",
      "dependencies",
      "config",
      "contributions",
    ],
    "$",
    "INVALID_MANIFEST",
  );
  if (manifest.schemaVersion !== 1)
    fail(
      "INVALID_MANIFEST",
      "$.schemaVersion",
      "only schema version 1 is supported",
    );
  const id = stringAt(manifest.id, "$.id", "INVALID_MANIFEST", {
    nonempty: true,
  });
  if (!identifierPattern.test(id))
    fail(
      "INVALID_MANIFEST",
      "$.id",
      "expected a stable lowercase dotted or dashed identifier",
    );
  const version = stringAt(manifest.version, "$.version", "INVALID_MANIFEST", {
    nonempty: true,
  });
  if (!semverPattern.test(version))
    fail("INVALID_MANIFEST", "$.version", "expected a semantic version");
  if (manifest.sdkRange !== undefined) {
    const sdkRange = stringAt(
      manifest.sdkRange,
      "$.sdkRange",
      "INVALID_MANIFEST",
      { nonempty: true },
    );
    if (!dependencyRangePattern.test(sdkRange))
      fail(
        "INVALID_MANIFEST",
        "$.sdkRange",
        "unsupported semantic version range",
      );
  }
  stringAt(manifest.displayName, "$.displayName", "INVALID_MANIFEST", {
    nonempty: true,
  });
  if (manifest.description !== undefined)
    stringAt(manifest.description, "$.description", "INVALID_MANIFEST", {
      nonempty: true,
    });
  if (
    manifest.dependencies !== undefined &&
    !Array.isArray(manifest.dependencies)
  )
    fail("INVALID_MANIFEST", "$.dependencies", "expected an array");
  const seenDependencies = new Set<string>();
  const dependencies = (manifest.dependencies ?? []).map(
    (inputDependency, index) => {
      const path = `$.dependencies[${index}]`;
      const dependency = objectAt(inputDependency, path, "INVALID_MANIFEST");
      allowedKeys(
        dependency,
        ["id", "range", "optional"],
        path,
        "INVALID_MANIFEST",
      );
      const dependencyId = stringAt(
        dependency.id,
        `${path}.id`,
        "INVALID_MANIFEST",
        { nonempty: true },
      );
      if (!identifierPattern.test(dependencyId))
        fail("INVALID_MANIFEST", `${path}.id`, "invalid plugin identifier");
      if (dependencyId === id)
        fail(
          "INVALID_MANIFEST",
          `${path}.id`,
          "plugin cannot depend on itself",
        );
      if (seenDependencies.has(dependencyId))
        fail("INVALID_MANIFEST", `${path}.id`, "duplicate dependency");
      seenDependencies.add(dependencyId);
      const range = stringAt(
        dependency.range,
        `${path}.range`,
        "INVALID_MANIFEST",
        { nonempty: true },
      );
      if (!dependencyRangePattern.test(range))
        fail(
          "INVALID_MANIFEST",
          `${path}.range`,
          "unsupported semantic version range",
        );
      if (
        dependency.optional !== undefined &&
        typeof dependency.optional !== "boolean"
      )
        fail("INVALID_MANIFEST", `${path}.optional`, "expected boolean");
      return {
        id: dependencyId,
        range,
        ...(dependency.optional === undefined
          ? {}
          : { optional: dependency.optional }),
      };
    },
  );
  const config =
    manifest.config === undefined
      ? undefined
      : structuredClone(assertConfigSchema(manifest.config, "$.config"));
  if (config && config.type !== "object")
    fail(
      "INVALID_MANIFEST",
      "$.config",
      "plugin config root must be an object",
    );
  if (
    manifest.contributions !== undefined &&
    !Array.isArray(manifest.contributions)
  )
    fail("INVALID_MANIFEST", "$.contributions", "expected an array");
  const contributionIds = new Set<string>();
  const contributions = (manifest.contributions ?? []).map(
    (inputContribution, index) => {
      const path = `$.contributions[${index}]`;
      const contribution = objectAt(
        inputContribution,
        path,
        "INVALID_MANIFEST",
      );
      allowedKeys(
        contribution,
        ["id", "kind", "target"],
        path,
        "INVALID_MANIFEST",
      );
      const contributionId = stringAt(
        contribution.id,
        `${path}.id`,
        "INVALID_MANIFEST",
        { nonempty: true },
      );
      if (!identifierPattern.test(contributionId))
        fail(
          "INVALID_MANIFEST",
          `${path}.id`,
          "invalid contribution identifier",
        );
      if (!contributionId.startsWith(`${id}.`))
        fail(
          "INVALID_MANIFEST",
          `${path}.id`,
          `contribution must use the "${id}." namespace`,
        );
      if (contributionIds.has(contributionId))
        fail(
          "INVALID_MANIFEST",
          `${path}.id`,
          "duplicate contribution identifier",
        );
      contributionIds.add(contributionId);
      const kind = stringAt(
        contribution.kind,
        `${path}.kind`,
        "INVALID_MANIFEST",
        { nonempty: true },
      );
      if (
        contribution.target !== undefined &&
        !["server", "web", "mobile"].includes(
          contribution.target as string,
        )
      )
        fail(
          "INVALID_MANIFEST",
          `${path}.target`,
          "expected server, web, or mobile",
        );
      return {
        id: contributionId,
        kind,
        ...(contribution.target === undefined
          ? {}
          : {
              target: contribution.target as
                | "server"
                | "web"
                | "mobile",
            }),
      };
    },
  );
  return {
    schemaVersion: 1,
    id,
    version,
    ...(manifest.sdkRange === undefined
      ? {}
      : { sdkRange: manifest.sdkRange as string }),
    displayName: manifest.displayName as string,
    ...(manifest.description === undefined
      ? {}
      : { description: manifest.description as string }),
    ...(dependencies.length ? { dependencies } : {}),
    ...(config ? { config: config as ObjectConfigSchema } : {}),
    ...(contributions.length ? { contributions } : {}),
  };
}

export function validatePluginConfig<T extends JsonObject = JsonObject>(
  manifest: PluginManifest,
  input: unknown,
): T {
  const config = input === undefined ? (manifest.config?.default ?? {}) : input;
  if (!manifest.config) {
    const object = objectAt(config, "$config", "INVALID_CONFIG");
    if (Object.keys(object).length)
      fail(
        "INVALID_CONFIG",
        "$config",
        `plugin ${manifest.id} does not declare configuration`,
      );
    return {} as T;
  }
  return readConfigValue(manifest.config, config, "$config") as T;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

function parseSemver(version: string): ParsedSemver | undefined {
  const match = semverPattern.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string, right: string) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined)
    return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

function compareSemver(left: ParsedSemver, right: ParsedSemver) {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference) return difference;
  }
  if (!left.prerelease.length && right.prerelease.length) return 1;
  if (left.prerelease.length && !right.prerelease.length) return -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index++
  ) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const difference = compareIdentifiers(leftPart, rightPart);
    if (difference) return difference;
  }
  return 0;
}

export function satisfiesPluginVersion(version: string, range: string) {
  if (range === "*") return !!parseSemver(version);
  const prefix = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const minimum = parseSemver(prefix ? range.slice(1) : range);
  const candidate = parseSemver(version);
  if (!minimum || !candidate) return false;
  if (!prefix) return compareSemver(candidate, minimum) === 0;
  if (candidate.prerelease.length && !minimum.prerelease.length) return false;
  if (compareSemver(candidate, minimum) < 0) return false;
  const maximum =
    prefix === "~"
      ? {
          major: minimum.major,
          minor: minimum.minor + 1,
          patch: 0,
          prerelease: [],
        }
      : minimum.major > 0
        ? {
            major: minimum.major + 1,
            minor: 0,
            patch: 0,
            prerelease: [],
          }
        : minimum.minor > 0
          ? {
              major: 0,
              minor: minimum.minor + 1,
              patch: 0,
              prerelease: [],
            }
          : {
              major: 0,
              minor: 0,
              patch: minimum.patch + 1,
              prerelease: [],
            };
  return compareSemver(candidate, maximum) < 0;
}

export type MaybePromise<T> = T | Promise<T>;
export type EffectCleanup = () => MaybePromise<void>;
export type EffectDisposer = () => Promise<void>;

declare const serviceType: unique symbol;
export interface ServiceToken<T> {
  readonly id: string;
  readonly [serviceType]?: T;
}

export type DispatchMode =
  "emit" | "parallel" | "serial" | "bail" | "waterfall";
export type NonWaterfallDispatchMode = Exclude<DispatchMode, "waterfall">;
export type WaterfallNext<Result> = () => Result;
declare const eventPayload: unique symbol;
declare const eventResult: unique symbol;
export interface EventToken<
  Payload,
  Result = void,
  Mode extends DispatchMode = "emit",
> {
  readonly id: string;
  readonly mode: Mode;
  readonly [eventPayload]?: Payload;
  readonly [eventResult]?: Result;
}

export type EventHandler<
  Payload,
  Result,
  Mode extends DispatchMode,
> = Mode extends "waterfall"
  ? (payload: Payload, next: WaterfallNext<Result>) => Result
  : Mode extends "bail"
    ? (payload: Payload) => Result | false | null | undefined
    : Mode extends "serial"
      ? (payload: Payload) => MaybePromise<Result | false | null | undefined>
      : (payload: Payload) => MaybePromise<Result>;

export type DispatchResult<
  Result,
  Mode extends DispatchMode,
> = Mode extends "emit"
  ? void
  : Mode extends "parallel"
    ? Promise<void>
    : Mode extends "serial"
      ? Promise<Awaited<Result> | undefined>
      : Mode extends "bail"
        ? Result | undefined
        : Result;

declare const contributionType: unique symbol;
export interface ContributionPoint<T> {
  readonly id: string;
  readonly [contributionType]?: T;
}

export interface ContributionRecord<T> {
  readonly point: string;
  readonly id: string;
  readonly pluginId: string;
  readonly value: T;
}

export interface DocaContributionRegistry {
  register<T>(
    point: ContributionPoint<T>,
    id: string,
    value: T,
  ): EffectDisposer;
  get<T>(
    point: ContributionPoint<T>,
    id: string,
  ): ContributionRecord<T> | undefined;
  list<T>(point: ContributionPoint<T>): readonly ContributionRecord<T>[];
}

export interface DocaContext {
  readonly scopeId: string;
  readonly disposed: boolean;
  provide<T>(token: ServiceToken<T>, value: T): EffectDisposer;
  inject<T>(token: ServiceToken<T>): T;
  injectOptional<T>(token: ServiceToken<T>): T | undefined;
  has(token: ServiceToken<unknown>): boolean;
  effect(setup: () => EffectCleanup | void): EffectDisposer;
  effectAsync(
    setup: () => Promise<EffectCleanup | void>,
  ): Promise<EffectDisposer>;
  child(scopeId?: string): DocaContext;
  on<Payload, Result, Mode extends DispatchMode>(
    event: EventToken<Payload, Result, Mode>,
    handler: EventHandler<Payload, Result, Mode>,
  ): EffectDisposer;
  dispatch<Payload, Result>(
    event: EventToken<Payload, Result, "waterfall">,
    payload: Payload,
    next: WaterfallNext<Result>,
  ): Result;
  dispatch<Payload, Result, Mode extends NonWaterfallDispatchMode>(
    event: EventToken<Payload, Result, Mode>,
    payload: Payload,
  ): DispatchResult<Result, Mode>;
  dispose(): Promise<void>;
}

export interface PluginLifecycleContext<
  Config extends JsonObject = JsonObject,
> extends DocaContext {
  readonly manifest: PluginManifest;
  readonly config: Config;
  readonly contributions: DocaContributionRegistry;
}

export interface PluginInjections {
  readonly required?: readonly ServiceToken<unknown>[];
  readonly optional?: readonly ServiceToken<unknown>[];
}

export interface DocaPlugin<Config extends JsonObject = JsonObject> {
  readonly manifest: PluginManifest;
  readonly injections?: PluginInjections;
  discover?(context: PluginLifecycleContext<Config>): MaybePromise<void>;
  /** Runs on every start, including when the package version has not changed. */
  initialize?(context: PluginLifecycleContext<Config>): MaybePromise<void>;
  migrate?(
    context: PluginLifecycleContext<Config>,
    fromVersion: string | undefined,
  ): MaybePromise<void>;
  mount?(context: PluginLifecycleContext<Config>): MaybePromise<void>;
  ready?(context: PluginLifecycleContext<Config>): MaybePromise<void>;
  dispose?(context: PluginLifecycleContext<Config>): MaybePromise<void>;
}
