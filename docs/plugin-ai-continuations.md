# Background task continuation

Implemented in SDK source **0.1.10**, server capability `ai.continuations.v1`, exported from `@smartdoca/plugin-sdk/ai`. npm publication and deployment are not implied. This is shared by all installed server plugins; knowledge books use the same host mechanism.

Declare `aiContinuationsServiceToken` as a required injection and `sdkRange: "^0.1.10"`. A host without this capability rejects initialization. There is no adapter through `ai.v1` or automatic registration of historical business tasks.

Plugins own business jobs, current authorization, durable results, stable operation IDs and notification/outbox delivery. Store those through public host-managed storage. The host owns assistant identity, persisted wait tickets, cancellation, model continuation and technical limits. A wake does not authorize a business action or approve a human task.

1. Register a source during mount. Its `id` must start with `<pluginId>.` and its `pluginId` must equal the installation identity. Registration is automatically removed on disposal.
2. `read(context, {operationId})` rechecks current business permission and returns a version 1 snapshot, or null for denied/unavailable work. It receives freshly read host identity and an abort signal; return no secrets. The operation ID identifies one durable job, never a user-supplied principal.
3. In a currently executing registered AI tool, call `wait(pluginId, context, {sourceId, operationId})` with the exact context supplied by the host. Copied, forged or retained contexts are rejected. Start the business job idempotently before waiting. The tool returns the receipt.
4. Commit the result before calling `wake(pluginId, {sourceId, operationId})`. Repeated notifications can claim one stored assistant checkpoint only once. A notification before parking is safe: periodic reconciliation and startup recovery read the durable source again.

A snapshot has `version: 1`, `state`, `revision`, `summary` and optional JSON `result`. States are `running`, `waiting_input`, `completed`, `failed`, `cancelled`. Change `revision` when the actionable result or human decision changes. Running heartbeats do not wake the model. A transition to human input wakes it once; the assistant can explain the pending task and keeps waiting for another decision. Terminal snapshots resume the original task with result facts. Terminal job results must remain stable; a new business execution needs a new operation ID.

The host saves only complete tool exchanges. While waiting it releases the execution slot, retains the original task/checkpoint and does not spend abnormal recovery attempts. Reads are reauthorized at registration, notification and execution. Revoked permission, disabled users, removed sources and invalid records stop continuation with a visible error and preserve the checkpoint. Cancelling the assistant removes its ability to resume; cancelling the business task is a separate plugin action.

Limits: 20 dependencies per assistant turn, source IDs 120 characters, operation IDs/revisions 200 characters, summaries 2,000 characters, serialized snapshot 24,000 characters and 20-second source-read deadline. Reconciliation uses keyset pages and bounded parallel reads; one slow source does not occupy normal model execution slots. Startup reconciliation waits for plugin composition to finish.

## Integration example

The `jobs` object below is the plugin's own repository backed by `storage.sql.v1`, **not an SDK export**. `startOnce` must use a durable business idempotency key; `readAuthorized` checks live resource permission and returns the current snapshot. Worker notification follows its committed business transaction.

```ts
import { aiServiceToken, aiContinuationsServiceToken } from "@smartdoca/plugin-sdk/ai";

// Inside mount(context):
const pluginId = "example.reports";
const sourceId = `${pluginId}.jobs`;
const ai = context.inject(aiServiceToken);
const continuations = context.inject(aiContinuationsServiceToken);
continuations.registerSource({
  id: sourceId, pluginId,
  read: (request, { operationId }) => jobs.readAuthorized(request, operationId),
});
ai.registerTool({
  id: `${pluginId}.generate`, description: "Generate a report",
  inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"], additionalProperties: false },
  async execute(input, request) {
    const operationId = await jobs.startOnce(request, input.reportId);
    return continuations.wait(pluginId, request, { sourceId, operationId });
  },
});

// In the plugin worker, after its durable result commit:
await continuations.wake(pluginId, { sourceId, operationId });
```

## Persistence and rollback

Only newly explicit waits write a strict version 1 checkpoint. The existing `ai_jobs` state constraint remains unchanged: dependency waits use its parked state and expose `awaiting_dependency` in the API/UI. There is no schema migration, dual write, inferred old ticket, missing-field conversion or historical task wakeup. Malformed new tickets are rejected and retained for diagnosis.

Rollback stops new registrations/writes and retains checkpoints, business results and audit records. An older host does not resume this new protocol; do not run it over active version 1 waiters without first cancelling those assistant waits or stopping workers and restoring a matching host. No data reset is part of rollback.

Knowledge-book progress uses existing audit storage, with compact versioned node/batch/model/retry counters. No model body is copied into those logs. The run drawer refreshes status, heartbeat, current error and the latest 200 recorded events. Historical events are not fabricated; retained older events remain in storage.
