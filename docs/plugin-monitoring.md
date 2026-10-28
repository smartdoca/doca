# Monitoring and telemetry

[简体中文](plugin-monitoring.zh-CN.md)

Implemented in SDK source **0.1.11**. Import `monitoringServiceToken` (`monitoring.v1`), `telemetryServiceToken` (`telemetry.v1`) and their types from `@smartdoca/plugin-sdk/monitoring`. SDK 0.1.11 npm verification is recorded in the publication section below; production deployment remains separate.

## Installation and access

Declare each service you use in `injections.required` and an SDK range starting at 0.1.11, for example `sdkRange: "^0.1.11"`. A missing service or an older SDK range fails explicitly. New services have no old-host adapter. Existing methods, `events.v1`, database structure and stored formats retain their prior behavior.

Installed server plugins are trusted code, installed by an administrator. A required monitoring injection grants the server plugin access to site operational facts for background collection. Injection does not grant an ordinary user access to those records. Plugins must authorize their own routes, jobs and AI tools; never send global logs or audit data to ordinary users or model prompts automatically.

Inject monitoring during mount to activate the plugin's Web access. `host.platform.monitoring` calls the same fixed method set through `/api/v1/plugin-platform/<pluginId>/monitoring.<method>`. The host verifies a live monitoring scope and re-reads the account's active administrator status on each browser call. A nonexistent/inactive installation is rejected by the existing platform gate. No generic service dispatch or browser telemetry-write endpoint is provided. Disposal revokes the scope and retained service handles. Telemetry writes are bound to the installation ID.

```ts
import { definePlugin } from "@smartdoca/plugin-sdk";
import { monitoringServiceToken, telemetryServiceToken } from "@smartdoca/plugin-sdk/monitoring";
import { httpServiceToken } from "@smartdoca/plugin-sdk/platform";
import manifest from "../manifest.json" with { type: "json" };

export default () => definePlugin({
  manifest, // sdkRange: "^0.1.11"; package.json also declares doca.storage: "host"
  injections: { required: [monitoringServiceToken, telemetryServiceToken, httpServiceToken] },
  async uninstall() {},
  async mount(context) {
    const monitoring = context.inject(monitoringServiceToken);
    const telemetry = context.inject(telemetryServiceToken);
    telemetry.log(manifest.id, { level: "info", module: manifest.id, message: "Collector started" });
    await context.inject(httpServiceToken).register(manifest.id, [{
      method: "GET", path: "/metrics", admin: true,
      handle: request => monitoring.metrics({ scope: "cluster", windowSeconds: 60 }, { signal: request.signal }),
    }]);
  },
});
```

The Web bundle can read `await host.platform.monitoring.stats({})` or `await host.platform.monitoring.logs({cursor})`. It receives typed DTOs, including coverage and gaps. SDK call options accept an AbortSignal; queries check cancellation before and after I/O, without promising cancellation of an already submitted database statement.

## Read methods

| Method | Facts and limits |
| --- | --- |
| `stats({})` | Shared database counts: non-deleted documents, libraries and files; all/active accounts; logical file bytes; registered file storage objects and bytes. Logical file bytes may count references to the same object. Registered object bytes are inventory, not filesystem/bucket capacity; private plugin objects, release archives and unregistered objects are outside this total. |
| `online({offset?,limit?})` | Fresh realtime connections; people deduplicated by user ID, connection count, active document count and a page of user IDs/document IDs. Default 100, maximum 200. Scope is instance for local presence and cluster for Redis. Never consults the old heartbeat alternative; unavailable realtime fails. |
| `metrics({scope?,windowSeconds?})` | HTTP completed requests, 4xx, 5xx, aborted requests, in-flight requests, QPS, 5xx error rate and duration histograms; route-template groups and plugin metric series. Default 60 seconds, supported 1–300. Default scope cluster; without configured Redis the actual returned scope is instance. |
| `logs({scope?,cursor?,limit?,level?,pluginId?,module?,requestId?,since?})` | Buffered structured operational logs. Preserve each epoch's sequence and merge instance heads by time; clock reversal never advances past unprocessed entries. Default 100, maximum 200. Filters are exact, level is not a minimum threshold. Cursor maximum 64 KiB. Always save the returned cursor, even on empty pages. |
| `audit({source,...})` | Existing durable security or resource audit. Required `source: "security" \| "resource"`; optional exact action/actorId and source-specific userId/resourceId, ISO since/until, cursor and limit. Source-inapplicable filters fail. Security details are redacted; unreadable/non-object details are `null` with `detailsValid:false`. No records are rewritten. |
| `jobs({})` | Shared database AI/projection/file-extract status groups, expired AI/projection leases, and private objects pending deletion. Projection kinds include the tasks already using that queue. This does not claim every business plugin uses a host queue. |
| `jobErrors({source,limit?})` | Latest bounded AI/projection/file-extract errors; no prompts, payloads or results. This is a recent diagnostic sample, not a full paginated error archive; `nextCursor` is always null. Projection records have no reliable error-update timestamp, so `updatedAt` is null and ordering uses available_at. |
| `aiUsage({...})` | Shared ledger snapshot pages, exact userId/modelId/state, ISO since/until. Call/job/model IDs, state, rated tokens and original provider numeric metrics. Unknown usage is null, never estimated from old SQL numeric columns. Confirmed entries not matching the current representation are `usageStatus:"invalid"`, retained unchanged. Secrets, raw vendor responses and model snapshots are omitted. |
| `health({scope?})` | Version, instances, process RSS/heap/cumulative CPU/event-loop P95, database read probe and realtime/cache readiness. Storage/search/AI network probes are explicitly `not-probed`. A health read does not call a paid model or write a storage test object. |

Audit and usage paging default to 100 and allow 200 records. Their cursor fixes an upper time boundary, includes the query fingerprint, and orders by created_at then ID; malformed/mismatched cursors fail. These reads are inventories, not change feeds. For durable AI settlement consumption, use existing `events.v1` / `ai.usage.recorded`; a previously pending call can settle after its creation-time page was read. All original audit and usage interfaces remain available with their original behavior.

## Request metrics and custom metrics

HTTP metrics count all normal HTTP routes, including administrator/platform/health requests. WebSocket handshakes/messages are excluded; use realtime presence for their connections. Aborts count separately from completed responses. Error rate is 5xx/completed responses and is null for an empty window. QPS sums instance request rates over their actual covered window, clipped to startup. Snapshots report sampling time and startup, so consumers can assess sampling lag.

Durations use exclusive millisecond buckets at 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000 and unbounded. P50/P95/P99 are bucket upper-bound estimates, clipped to observed maximum; cluster percentiles merge bucket counts rather than average instance percentiles. The empty distribution has null min/max/quantiles. Route labels use registered route templates, never query strings or dynamic resource URLs. The first 64 route/method groups are retained per process epoch; additional groups share `[other-routes]`.

```ts
telemetry.record(manifest.id, {
  name: manifest.id + ".sync.completed", kind: "counter", value: 1,
  labels: { source: "mail" },
});
telemetry.record(manifest.id, {
  name: manifest.id + ".sync.duration_ms", kind: "histogram", value: 120,
});
```

Metric names start with the owning plugin ID and a dot. Kinds are counter (nonnegative increments), gauge (latest finite value), and histogram (nonnegative observations, using the same numeric buckets). Kind and label-key changes under one name fail with 409. Up to six labels, 100 characters/value, 200 series/plugin and 1,000 custom series/instance; new excess series fail with 429 and increment rejectedMetricSeries. Secret-like labels and numeric overflow fail. Use bounded categories rather than user/request/document IDs. Custom series are returned per instance/epoch; counter reset and gauge aggregation remain explicit consumer decisions. Their values are since-start cumulative/latest, independent of the HTTP rolling window. Plugin authors can expose their own dependency/job facts through custom metrics.

## Logs, retention and cluster coverage

Host logs include structured Fastify application logs when host logging is enabled, plus HTTP errors/aborts/requests taking at least two seconds regardless of stdout logging. Ordinary successful request lines are represented by metrics. Plugin logs carry a host-bound pluginId, epoch, instanceId, sequence, creation time and optional requestId. Sensitive keys, request bodies, prompts, payloads, model snapshots and error stacks are removed/redacted; URL userinfo/query/hash and common credential strings are scrubbed. Logging arbitrary secret text cannot be made safe by pattern matching: authors must never put secrets or document bodies in message/module/requestId/fields.

Each instance keeps at most 2,000 records and 2 MiB of serialized log data. Count/byte eviction increases the sequence watermark and dropped count. A saved cursor behind that watermark reports an explicit eviction gap, including the lost count. Instances have a fresh epoch on restart, even if instanceId is reused. A missing previous epoch reports an instance-unavailable gap; malformed new cache representations are marked unavailable, retained until expiry, and never adapted or returned as content.

With configured Redis, hosts publish version 1 snapshots every five seconds in a separate `monitoring:v1` key namespace. Closed instances or snapshots older than 15 seconds are stale and excluded from current metric totals, while retained logs can still be drained. Snapshots and known-instance records expire after one hour; stale/missing/malformed instances make `complete:false`. A cluster read refreshes the responding instance and reads the other snapshots. Up to 128 retained epochs and 16 MiB/snapshot; larger inventories fail explicitly. Redis failures do not downgrade a configured cluster request to local data. Local scope remains an explicit diagnostic choice. This cache is ephemeral and is not a guarantee of durable delivery or mixed-version fleet discovery: hosts without the new publisher are not in its inventory.

Monitoring plugins store historical aggregates, log records, cursors, gap markers and alert state through host-managed storage. Deduplicate logs by id, commit records with their cursor in one plugin transaction, and acknowledge/report gaps as gaps. Sampling does not reconstruct a lost request window. The host keeps security audit and original AI usage facts; plugins cannot delete them through this SDK.

## Upgrade, rollback and verification

This addition changes no host database table, baseline, audit format, AI ledger format or existing plugin data structure. Existing online-heartbeat and AI historical-reading alternatives remain confined to their original paths. New runtime facts begin on upgraded process startup; historical stdout is not imported. New plugins require SDK 0.1.11 and fail on older hosts. Rolling back code preserves existing persistent data and plugin historical records; deactivate plugins requiring new services before starting an older host. Monitoring cache may expire without affecting authoritative data.

Tests use isolated databases/documents and a unique Redis namespace. Acceptance covers request/histogram merging, user deduplication, filters/paging/cursor eviction, secret redaction, ordinary-user and revoked-administrator denial, namespace/version/lifecycle enforcement, stale/missing/invalid cache and restart epochs, plus SDK build and an independent JavaScript/declaration consumer. npm publication, a production monitoring plugin and production deployment are separate deliveries.

## SDK publication — 2026-10-13

`@smartdoca/plugin-sdk@0.1.11` is published on npm. The registry dependency consumer imports all 16 public entrypoints and verifies monitoring/telemetry tokens and the exact SDK version. This does not establish a production monitoring plugin or native-device acceptance.
