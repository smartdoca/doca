import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type {
  PluginCredentialMetadata,
  PluginCredentialServiceV1,
} from "@smartdoca/plugin-sdk/storage";
import {
  CredentialCryptoError,
  type CredentialCipher,
} from "./credential-cipher.js";

export class PluginCredentialError extends Error {
  readonly name = "PluginCredentialError";
  constructor(
    readonly code: "invalid-input" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
const invalid = () =>
  new PluginCredentialError("invalid-input", "Invalid plugin credential input");
const unavailable = () =>
  new PluginCredentialError(
    "unavailable",
    "Plugin credential storage is unavailable",
  );
const idParser = z.string().uuid();
const revisionParser = z.number().int().min(1).max(2147483647);
const valueParser = z.string().min(1);
function parse<T>(parser: z.ZodType<T>, input: unknown): T {
  const result = parser.safeParse(input);
  if (!result.success) throw invalid();
  return result.data;
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginCredentialError) throw error;
    if (
      error instanceof CredentialCryptoError &&
      error.code === "invalid-credential"
    )
      throw invalid();
    throw unavailable();
  }
}
/** Durable key identity; a different replica key cannot silently create a second set of secrets. No rotation or conversion. */
export async function verifyCredentialKey(db: DB, cipher: CredentialCipher) {
  await safe(() =>
    transact(db, async (tx) => {
      await tx
        .insertInto("plugin_credential_keys")
        .values({
          id: "global",
          fingerprint: cipher.fingerprint,
          created_at: new Date().toISOString(),
        })
        .onConflict((c) => c.column("id").doNothing())
        .execute();
      const row = await tx
        .selectFrom("plugin_credential_keys")
        .selectAll()
        .where("id", "=", "global")
        .executeTakeFirstOrThrow();
      if (row.fingerprint !== cipher.fingerprint)
        throw new PluginCredentialError(
          "unavailable",
          "DOCA_CREDENTIAL_MASTER_KEY does not match credential storage; retain the original key",
        );
    }),
  );
}

/** Only the host supplies namespace, generation and the installation guard. No selector for another plugin or backend. */
export function bindPluginCredentials(
  db: DB,
  cipher: CredentialCipher,
  pluginId: string,
  namespace: string,
  generation: number,
  current: (tx: DB, lock?: boolean) => Promise<unknown>,
): PluginCredentialServiceV1 {
  const metadata = (
    row: Schema["plugin_credentials"],
  ): PluginCredentialMetadata => {
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.revision > 2147483647
    )
      throw unavailable();
    return Object.freeze({
      id: row.id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  };
  const binding = (id: string, revision: number) => ({
    pluginId: namespace,
    credentialId: `${generation}:${id}`,
    revision,
  });
  const rowFor = (tx: DB, id: string) =>
    tx
      .selectFrom("plugin_credentials")
      .selectAll()
      .where("plugin_id", "=", pluginId)
      .where("namespace", "=", namespace)
      .where("generation", "=", generation)
      .where("id", "=", id)
      .executeTakeFirst();
  const open = (row: Schema["plugin_credentials"]) => {
    metadata(row);
    return cipher.open(binding(row.id, row.revision), JSON.parse(row.sealed));
  };
  const updateParser = z
    .object({
      id: idParser,
      value: valueParser,
      expectedRevision: revisionParser,
    })
    .strict();
  const removeParser = z
    .object({ id: idParser, expectedRevision: revisionParser })
    .strict();
  const conflict = () =>
    new PluginCredentialError(
      "conflict",
      "Plugin credential revision changed; read the current credential before retrying",
    );
  return Object.freeze<PluginCredentialServiceV1>({
    create: (input) =>
      safe(async () => {
        const { value } = parse(
          z.object({ value: valueParser }).strict(),
          input,
        );
        const id = randomUUID();
        return transact(db, async (tx) => {
          await current(tx, true);
          const now = new Date().toISOString();
          const row = {
            plugin_id: pluginId,
            namespace,
            generation,
            id,
            revision: 1,
            sealed: JSON.stringify(cipher.seal(binding(id, 1), value)),
            created_at: now,
            updated_at: now,
          };
          await tx.insertInto("plugin_credentials").values(row).execute();
          return metadata(row);
        });
      }),
    inspect: (id) =>
      safe(async () => {
        parse(idParser, id);
        return transact(db, async (tx) => {
          await current(tx, true);
          const row = await rowFor(tx, id);
          return row ? metadata(row) : null;
        });
      }),
    get: (id) =>
      safe(async () => {
        parse(idParser, id);
        return transact(db, async (tx) => {
          await current(tx, true);
          const row = await rowFor(tx, id);
          return row ? { credential: metadata(row), value: open(row) } : null;
        });
      }),
    update: (input) =>
      safe(async () => {
        const { id, value, expectedRevision } = parse(updateParser, input);
        return transact(db, async (tx) => {
          await current(tx, true);
          const row = await rowFor(tx, id);
          if (!row) throw unavailable();
          if (row.revision !== expectedRevision || row.revision === 2147483647)
            throw conflict();
          // Authenticate the old record before replacing it; do not mask corruption or a wrong key.
          open(row);
          const next = {
            ...row,
            revision: row.revision + 1,
            updated_at: new Date().toISOString(),
            sealed: JSON.stringify(
              cipher.seal(binding(id, row.revision + 1), value),
            ),
          };
          const result = await tx
            .updateTable("plugin_credentials")
            .set({
              revision: next.revision,
              updated_at: next.updated_at,
              sealed: next.sealed,
            })
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("generation", "=", generation)
            .where("id", "=", id)
            .where("revision", "=", expectedRevision)
            .executeTakeFirst();
          if (Number(result.numUpdatedRows) !== 1) throw conflict();
          return metadata(next);
        });
      }),
    remove: (input) =>
      safe(async () => {
        const { id, expectedRevision } = parse(removeParser, input);
        await transact(db, async (tx) => {
          await current(tx, true);
          const row = await rowFor(tx, id);
          if (!row) return;
          if (row.revision !== expectedRevision) throw conflict();
          await tx
            .deleteFrom("plugin_credentials")
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("generation", "=", generation)
            .where("id", "=", id)
            .where("revision", "=", expectedRevision)
            .execute();
        });
      }),
  });
}
