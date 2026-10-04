# Single instance and horizontal scaling

[中文](horizontal-scaling.zh-CN.md)

Doca keeps a single-instance mode with no extra infrastructure. SQLite, a local upload directory, and an in-process realtime bus fit a person, a small team, or a trial. Configure PostgreSQL, shared object storage, and Redis only when more than one application replica is running. Both modes use the same business protocol. There is no migration from an older deployment and no dual-write path.

## Capability matrix

| Capability | Single instance | Multiple replicas |
| --- | --- | --- |
| Database | SQLite or PostgreSQL | PostgreSQL; every replica uses the same database |
| Document collaboration and notifications | In-process broadcast and presence | Redis Pub/Sub and Redis presence |
| Login, upload, and public-bot rate limits | In-process counters | Redis counters |
| Files | Local persistent directory | S3-compatible storage, or a filesystem truly shared by every replica |
| CDN | Optional | Optional. It only accelerates reads and does not replace shared storage |
| Background jobs | Database leases | The same leases; any replica may claim a job, and a failure can be retried |
| Mobile push | Database outbox | The same outbox and leases; do not keep the queue only in one process |
| Schema | The first start creates the current baseline | One instance creates the empty baseline before the first deployment |
| Health | `/live` and `/ready` | `/ready` also checks the database and Redis |

## Single instance

When `DOCA_REDIS_URL` is unset, realtime events, presence, and rate limits stay in the process. Redis is not required. `pnpm dev`, `pnpm start`, and a single Compose container create the current baseline on an empty database, then only check the schema.

Do not run two replicas in this mode. Sticky WebSockets on a load balancer hide the problem for a while. Notifications, permission revocation, online users, and global limits are still split.

## Minimum multi-replica configuration

Every replica needs the same settings:

```dotenv
DOCA_DATABASE=postgres
DOCA_DATABASE_URL=postgresql://user:password@postgres:5432/doca
DOCA_DATABASE_POOL_MAX=10
DOCA_REDIS_URL=redis://redis:6379
DOCA_REDIS_PREFIX=doca-production
DOCA_TRUST_PROXY=10.0.0.10/32
```

The orchestrator may set `DOCA_INSTANCE_ID` to the pod or container name. Otherwise each process generates a random id. `DOCA_REDIS_PREFIX` must separate environments that share one Redis. `DOCA_TRUST_PROXY` lists only the reverse proxy addresses or CIDRs. A wider range lets clients forge IPs and break audit and rate limits.

Release order:

1. Start one instance against an empty database so it creates the baseline. Do not let several replicas initialize an empty database together.
2. Start the other replicas. A schema mismatch fails startup. Nothing is upgraded or rewritten.
3. The load balancer uses `/ready` for traffic and `/live` for process health. WebSocket upgrades and a normal drain must be allowed.
4. A rolling update removes readiness first, then waits for HTTP and WebSocket connections to close within the stop grace period.

Once Redis is configured it is required. A failed startup connection, a later outage, or a failed readiness check does not silently fall back to the local bus. That avoids splitting the cluster into several single instances that still look healthy.

## Consistency

A collaboration update is stored in a PostgreSQL transaction and acknowledged, then Redis tells the other replicas. Redis is not the document log. Duplicate events are removed by the protocol. A short loss is repaired from the database after reconnect. Presence expires, so a crashed instance disappears.

File recognition, text extraction, knowledge curation, and mobile push use database jobs and leases. An occurrence key makes sure several replicas scanning together create only one business occurrence. Handlers must be idempotent, because another replica may retry after a lease expires.

## Capacity

- Total database connections are about replicas × `DOCA_DATABASE_POOL_MAX`. Stay under the PostgreSQL or pooler limit, and leave room for operations and background jobs.
- Local disk cannot hold uploads for several hosts. A CDN only caches reads. Objects stay in S3 or on a shared filesystem. Storage named by an existing `storage_profile` must remain available.
- Meilisearch, S3, and message gateways must show every replica the same configuration and the same data. Credentials live in the shared database. Network access, allowlists, and keys are still the deployment's job.
- The shared database records desired plugin releases and references immutable ZIPs in shared storage. Each replica needs its own writable installation/cache directory (`DOCA_PLUGINS_DIR`); startup validates and restores it from the archive. Operations take effect after manual restart of every replica. Keep running versions consistent; see [plugin deployment](plugin-deployment.md).
- Redis should use authentication, TLS or a private network, a memory limit, and alerts. The database and object storage still need their own backups. Losing Redis must not lose document text, but it stops realtime delivery, presence, and global limits.
- `/ready` only proves that this replica can reach the database and the realtime cluster. It does not replace end-to-end checks of collaboration, object storage, search, and messaging.

## Still needs an external rehearsal

The code covers document updates, cursors, presence, shared limits, and database leases or outboxes across two application instances. Before production, rehearse PostgreSQL, managed Redis, S3, WebSocket drain, and rolling updates on the target infrastructure. Inject failures: pause Redis, kill the replica running a job, revoke access during an edit, present a mismatched database baseline, and time out object storage.
