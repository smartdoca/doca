# Webhook 投递

[English](webhooks.md)

管理员在 Hook 页面登记回调地址、订阅事件和额外请求头。业务事务只把事件写入 outbox，提交后由后台 POST。请求不占用当前操作。

回调地址可以是公网、本机或内网 HTTP(S)，不能带账号密码。登记之后才会收到新事件；暂停后不再接收新事件。同一回调、同一事件只投递一次。接收方用正文里的 `id` 去重。

2xx 视为成功。其他状态或网络失败会重试，间隔依次为 15 秒、1 分钟、5 分钟、30 分钟，最多 5 次，之后记为失败。单次请求超时 8 秒，不跟随跳转。

SQLite 把订阅和投递记在主库同目录的 `webhooks.db`。PostgreSQL 使用名为 `<主库名>_webhooks` 的独立库，也可以用 `DOCA_WEBHOOK_DATABASE_URL` 指定。结构基线不一致时拒绝打开，不从旧表迁移。

## 请求

```http
POST /hook HTTP/1.1
Content-Type: application/json
Authorization: Bearer service-token
```

`Content-Type` 默认为 `application/json`。管理员填写的请求头按原样附上，同名时覆盖默认值。`Content-Length`、`Host`、`Connection`、`Transfer-Encoding`、`Keep-Alive`、`Upgrade`、`TE`、`Trailer` 不能由回调设置。

系统不生成签名密钥，也不附加 `X-Doca-Signature`。

## 正文

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

| 字段 | 含义 |
| --- | --- |
| `id` | 事件 ID，稳定不变 |
| `sequence` | 已发布事件的单调序号 |
| `type` | 事件类型，与订阅值相同 |
| `createdAt` | 事件写入时间，ISO-8601 |
| `data.version` | 载荷版本，当前为 `1` |
| `data` | 该类型的业务字段，不含文档正文、密码和密钥 |

## 事件字段

资源类事件（`document.created`、`library.created`，以及 `resource.renamed`、`resource.transferred`、`resource.arranged`、`resource.moved`、`resource.copied`、`resource.restored`、`resource.trashed`、`resource.invited`、`comment.created`、`comment.updated`、`like.added`、`like.removed`、`favorite.added`、`favorite.removed`）携带：

| 字段 | 含义 |
| --- | --- |
| `resourceId` | 资源 ID |
| `actorId` | 操作者 |
| `kind` | `document` 或 `library` |
| `path` | 站内路径，例如 `#/r/<id>` |

其余类型：

| `type` | `data` 字段 |
| --- | --- |
| `resource.purged` | `resourceId`，`actorId` |
| `resource.permissions_changed` | `resourceId`，`actorId` |
| `resource.link_changed` | `resourceId`，`actorId` |
| `resource.link_joined` | `resourceId`，`userId` |
| `access.requested` | `requestId`，`resourceId`，`userId`，`role` |
| `access.approved` / `access.rejected` / `access.cancelled` | `requestId`，`resourceId`，`userId`，`actorId`，`role`，`includeDescendants` |
| `invitation.accepted` / `invitation.rejected` | `resourceId`，`userId` |
| `invitation.cancel` / `invitation.resend` | `resourceId`，`userId`，`actorId` |
| `notification.created` | `notificationId`，`userId`，以及当时带上的 `actorId`、`resourceId`、`type`、`ticketId`、`path` |
| `ticket.changed` | `ticketId`，`resourceId` |
| `user.created` | `userId`，注册流程中还有 `status` |
| `user.updated` | `userId` |
| `user.status.changed` | `userId`，`status`，`previousStatus` |
| `ai.usage.recorded` | `callId`，`userId`，`modelId`，`jobId`，`state`，`metrics`，`units`，`provider` |

`notification.created` 的字段视来源而定：插件通知至少有 `notificationId` 和 `userId`；工单通知另有 `resourceId`、`ticketId`、`path`；社区通知另有 `actorId`、`resourceId`、`type`、`path`。
