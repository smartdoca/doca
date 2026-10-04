# Host-managed plugin credentials

[中文](plugin-credentials.zh-CN.md)

Release: host 0.1.10 and SDK 0.1.9, including the credential API previously added in SDK source 0.1.8. SDK 0.1.7 does not export it. Mail plugins should declare `^0.1.9` and consume the public server token rather than importing host source or persisting passwords themselves.

```ts
import { pluginCredentialToken } from '@smartdoca/plugin-sdk/storage';

// Declare pluginCredentialToken in injections.required.
const credentials = ctx.inject(pluginCredentialToken);
const created = await credentials.create({value: JSON.stringify({password: 'example'})});
// Store created.id in the plugin database with the business account and grants.
const metadata = await credentials.inspect(created.id); // No plaintext.
const stored = await credentials.get(created.id); // Server plaintext or null.
if (stored) {
  const refreshed = await credentials.update({
    id: stored.credential.id,
    expectedRevision: stored.credential.revision,
    value: JSON.stringify({accessToken: 'new', refreshToken: 'new-refresh'}),
  });
  await credentials.remove({id: refreshed.id, expectedRevision: refreshed.revision});
}
```

Metadata is `{id, revision, createdAt, updatedAt}`. The host generates IDs; plugins cannot supply IDs, scopes, database names, or backend configuration. `get` returns `{credential: metadata, value: string} | null`; `inspect` returns metadata or null. Values are nonempty valid-Unicode strings, at most 64 KiB UTF-8. Plugins explicitly serialize OAuth objects; there is no implicit format conversion.

Updates and deletes require a positive integer `expectedRevision`. Only one concurrent update succeeds. A stale revision returns `conflict`; reread and apply business rules rather than overwriting a newer refresh token. Removing a missing record is idempotent. Invalid input returns `invalid-input`; invalid installations, corrupt records, service/database failure, or updating a missing record return `unavailable`. Errors include no inputs, SQL, connection configuration, or underlying encryption exceptions.

AES-256-GCM authenticated encryption binds records to `plugin:<pluginId>`, installation generation, UUID, and revision. The database stores encrypted records and each write uses a fresh random nonce. Other plugins cannot read/update/delete these records. Disabling or shutdown preserves them. Explicit uninstall removes that generation's credentials in the registry transaction and invalidates old handles; reinstall uses a new generation. Perform any external revocation needing plaintext before completing uninstall. The SDK does not decide business account authorization: plugins check user/account permission before reading and never return plaintext to browsers, AI context, logs, or ordinary configuration APIs.

Credential operations and plugin business transactions commit separately. If saving a business reference after credential creation fails, compensate by deleting the credential. Plugins recover external OAuth refreshes, database commits, and lost responses according to their own rules. There is no cross-service transaction, create idempotency key, general job coordinator, or automatic key rotation. See the [storage example](../examples/plugin-storage/README.md). Plugins run in a trusted Node.js process; scoped APIs are not an operating-system sandbox.

## Deployment environment

`DOCA_CREDENTIAL_MASTER_KEY` must be 32 random bytes encoded as 64 hexadecimal characters; generate it with `openssl rand -hex 32`. Set it once, retain it across restarts, and back it up separately. Invalid configuration rejects startup. The database persists a key fingerprint; a mismatched key rejects startup without re-encrypting data. Removing the final plugin does not remove this key identity. Without a key the host does not provide the service; plugins requiring it fail to start, while optional injection returns undefined. Every process sharing the database uses the same key.

Operators select database and file storage: SQLite/local files for one instance; configure shared database and cloud storage for multiple instances. The plugin API does not select deployment topology. Compose forwards database, pool, Webhook database, Redis, and instance settings; see [docker.env.example](../docker.env.example).

File storage is configured only by `DOCA_FILE_STORE_ID` and strict version 1 `DOCA_FILE_STORES_JSON`, including S3/CDN credentials. The storage admin page is read-only; old storage configuration submissions are rejected. See the [implementation record](unified-storage-implementation.md) for examples. The plugin master key and cloud-storage connection credentials are independent. Existing identity, messaging, and search platform configuration is not converted or re-encrypted by this increment.

The database baseline is `doca-2026-10-03-credentials-v2`. Under the previously agreed version policy, host databases from 0.1.9 and earlier are rejected. Preserve old databases, objects, and deployments; no automatic table repair, migration, import, or reset is provided. Use a new empty database. Rollback uses the original deployment/data and preserves new-deployment data separately. SDK 0.1.7's missing credential service must not be bypassed with self-managed local files.
