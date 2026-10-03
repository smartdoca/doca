import { createPrivateKey } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";

const nonEmpty = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const httpsOrigin = nonEmpty.refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
});
const credentials = z
  .object({
    accessKeyId: nonEmpty,
    secretAccessKey: nonEmpty,
    sessionToken: nonEmpty.optional(),
  })
  .strict();
const cdn = z
  .object({
    domain: httpsOrigin,
    keyPairId: nonEmpty,
    privateKey: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          const key = createPrivateKey(value);
          return (
            key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "ec"
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
const store = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local"), root: nonEmpty }).strict(),
  z
    .object({
      provider: z.literal("s3"),
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
      region: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
      endpoint: httpsOrigin.optional(),
      forcePathStyle: z.boolean(),
      credentials,
      cdn: cdn.optional(),
    })
    .strict(),
]);
const configuration = z
  .object({
    version: z.literal(1),
    stores: z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), store)
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Object.keys(value).length <= 100,
      )
      .refine(
        (value) =>
          !Object.keys(value).some((key) =>
            Object.hasOwn(Object.prototype, key),
          ),
      ),
  })
  .strict();

export type FileStoreConfiguration = z.infer<typeof store>;
export interface HostFileStoreConfiguration {
  readonly currentId: string;
  readonly stores: ReadonlyMap<string, Readonly<FileStoreConfiguration>>;
}

/** Configuration failures deliberately omit input and credentials from errors. */
export class FileStoreConfigurationError extends Error {
  readonly name = "FileStoreConfigurationError";
  constructor(message: string) {
    super(message);
  }
}

/** Pure parsing; no database configuration reader or implicit local fallback. */
export function parseFileStoreEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): HostFileStoreConfiguration {
  const currentId = environment.DOCA_FILE_STORE_ID;
  const raw = environment.DOCA_FILE_STORES_JSON;
  if (!currentId || !raw)
    throw new FileStoreConfigurationError(
      "DOCA_FILE_STORE_ID and DOCA_FILE_STORES_JSON are required",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new FileStoreConfigurationError("Invalid DOCA_FILE_STORES_JSON");
  }
  const parsed = configuration.safeParse(decoded);
  if (!parsed.success)
    throw new FileStoreConfigurationError(
      "Invalid file storage configuration version or fields",
    );
  if (!Object.hasOwn(parsed.data.stores, currentId))
    throw new FileStoreConfigurationError(
      "Current file storage ID is not configured",
    );
  const stores = new Map<string, Readonly<FileStoreConfiguration>>();
  for (const [id, value] of Object.entries(parsed.data.stores)) {
    if (value.provider === "local") {
      stores.set(id, Object.freeze({ ...value, root: resolve(value.root) }));
    } else {
      stores.set(
        id,
        Object.freeze({
          ...value,
          credentials: Object.freeze(value.credentials),
          ...(value.cdn ? { cdn: Object.freeze(value.cdn) } : {}),
        }),
      );
    }
  }
  return Object.freeze({ currentId, stores });
}

/** A missing historical store is an error, never a read through the current one. */
export function configuredFileStore(
  configuration: HostFileStoreConfiguration,
  storeId: string,
) {
  const store = configuration.stores.get(storeId);
  if (!store)
    throw new FileStoreConfigurationError(
      "Referenced file storage ID is not configured",
    );
  return store;
}
