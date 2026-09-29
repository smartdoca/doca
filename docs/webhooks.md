# Webhook delivery

[中文](webhooks.zh-CN.md)

An administrator registers a callback URL, the events it receives, and any extra request headers. The business transaction only writes an outbox row. After commit, a background worker POSTs the event. The request does not block the action that caused it.

The URL may be public, on the same machine, or on a private network. It must be HTTP or HTTPS without credentials. A callback receives only events published after it is registered. A paused callback receives nothing new. Each callback receives each event once. Receivers deduplicate with `id`.

Any 2xx response is success. Other statuses and network failures retry after 15 seconds, 1 minute, 5 minutes, and 30 minutes, up to 5 attempts, then the delivery is marked failed. Each attempt times out after 8 seconds and does not follow redirects.

SQLite stores subscriptions and deliveries in `webhooks.db` beside the main database. PostgreSQL uses a separate database named `<main>_webhooks`, or `DOCA_WEBHOOK_DATABASE_URL`. A mismatched schema baseline is refused. There is no migration from an older webhook database.

## Request

```http
POST /hook HTTP/1.1
Content-Type: application/json
Authorization: Bearer service-token
```

`Content-Type` defaults to `application/json`. Headers entered by the administrator are sent as entered and override that default when the name matches. `Content-Length`, `Host`, `Connection`, `Transfer-Encoding`, `Keep-Alive`, `Upgrade`, `TE`, and `Trailer` cannot be set on a callback.

Doca does not generate a signing secret and does not send `X-Doca-Signature`.

## Body

```json
{
  "id": "6f1c2a40-1b7e-4d2a-9c31-0a5b8e2d44f1",
  "sequence": 12,
  "type": "document.created",
  "createdAt": "2026-09-29T03:00:00.000Z",
  "data": {
    "version": 1,
    "resourceId": "8b2e1c55-7a10-4f3e-9d22-11c0a9e5b731",
    "actorId": "2c91aa10-88d4-4e55-b0a1-77e4d2c88a19",
    "kind": "document",
    "path": "#/r/8b2e1c55-7a10-4f3e-9d22-11c0a9e5b731"
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable event id |
| `sequence` | Monotonic sequence of published events |
| `type` | Event type, the same value used when subscribing |
| `createdAt` | When the event was written, ISO-8601 |
| `data.version` | Payload version, currently `1` |
| `data` | Fields for that type. No document body, password, or secret |

## Event fields

Resource events (`document.created`, `library.created`, `resource.renamed`, `resource.transferred`, `resource.arranged`, `resource.moved`, `resource.copied`, `resource.restored`, `resource.trashed`, `resource.invited`, `comment.created`, `comment.updated`, `like.added`, `like.removed`, `favorite.added`, `favorite.removed`) include:

| Field | Meaning |
| --- | --- |
| `resourceId` | Resource id |
| `actorId` | Actor |
| `kind` | `document` or `library` |
| `path` | In-app path, such as `#/r/<id>` |

Other types:

| `type` | `data` fields |
| --- | --- |
| `resource.purged` | `resourceId`, `actorId` |
| `resource.permissions_changed` | `resourceId`, `actorId` |
| `resource.link_changed` | `resourceId`, `actorId` |
| `resource.link_joined` | `resourceId`, `userId` |
| `access.requested` | `requestId`, `resourceId`, `userId`, `role` |
| `access.approved` / `access.rejected` / `access.cancelled` | `requestId`, `resourceId`, `userId`, `actorId`, `role`, `includeDescendants` |
| `invitation.accepted` / `invitation.rejected` | `resourceId`, `userId` |
| `invitation.cancel` / `invitation.resend` | `resourceId`, `userId`, `actorId` |
| `notification.created` | `notificationId`, `userId`, plus whichever of `actorId`, `resourceId`, `type`, `ticketId`, `path` that source recorded |
| `ticket.changed` | `ticketId`, `resourceId` |
| `user.created` | `userId`, and `status` when registration recorded it |
| `user.updated` | `userId` |
| `user.status.changed` | `userId`, `status`, `previousStatus` |
| `ai.usage.recorded` | `callId`, `userId`, `modelId`, `jobId`, `state`, `metrics`, `units`, `provider` |
