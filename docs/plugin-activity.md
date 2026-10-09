# Plugin recent activity

[中文](plugin-activity.zh-CN.md)

Implemented on 2026-09-30 and publicly exported from `@smartdoca/plugin-sdk/platform`. Use an SDK artifact and host containing this interface. Source availability alone does not establish a new npm publication.

## Storage and ownership

Plugins register through `activityServiceToken` (`activity.v1`). They own visit records, history queries, current business authorization, and deletion cleanup, using host-managed persistence. The service only aggregates sources; it creates no business mirror or special visit-writing endpoint. Use the [current managed storage contract](plugin-horizontal-scaling.md).

Built-in records remain in `resource_visits` and `workspace_activity`. This increment changed no table, moved no history, and introduced no dual writing. The public discovery page's `/workspace/recent?publicOnly=true` collection logic applies to built-in resources. Registering activity does not register discovery, favorites, search, or AI.

Disposal removes runtime registrations and opening/listing stops offering that source. Stored records remain. Re-enabling queries current plugin data. Actual installation/disable follows the host's restart-based lifecycle.

## Registration

```ts
import {
  activityServiceToken,
  permissionsServiceToken,
  type ActivitySource,
} from "@smartdoca/plugin-sdk/platform";
```

Declare both tokens in `injections.required`. A host without `activity.v1` rejects a plugin requiring it; private tables or old endpoints are not substitutes. Existing plugins that do not use activity need no new registration. `register(source)` returns a disposer; scoped injection binds it to plugin effects and releases it on shutdown or initialization failure.

Register one source per content type, for example `example.mail.messages` and `example.mail.threads`:

| Field | Requirement |
| --- | --- |
| `id` | Unique plugin-prefixed source ID, at most 150 characters |
| `pluginId` | Must equal the injected plugin identity |
| `schemaVersion` | Exactly `1`; unsupported versions fail registration |
| `resourceType` | Registered with `permissions.v1`; item IDs identify that type's resource |
| `title` | `en` and `zh`, at most 100 characters each, for filters/source labels |
| `icon` | `file`, `mail`, `calendar`, `message`, `task`, `book`, or `folder` |
| `list(context, input)` | Current user's readable visit page |
| `get(context, id)` | Current record/title/path with rechecked authorization, or null |

IDs and resource types begin with a lowercase letter and use alphanumeric segments separated by dots/hyphens. Each instance permits at most 64 plugin sources and rejects duplicate IDs. Business resources are unlimited but must be paged.

Host-created context is `{principalId, signal}`. The principal comes from the authenticated session rather than a browser-selected user. An item has this shape:

```ts
{
  id: "message-123",                  // 唯一资源 ID，1–500 个可见 ASCII 字符
  title: "季度预算讨论",              // 原始内容标题，非空，最长 500 字符
  visitedAt: "2026-09-30T09:20:00.000Z",
  path: "/mail/inbox?message=message-123"
}
```

`id` contains 1–500 visible ASCII characters; title is nonempty and at most 500 characters. `path` starts with slash plus a letter/digit and contains no origin, hash, backslash, or control characters. External/protocol-relative addresses are forbidden. Encode query values. Business titles keep their original content; type names use `title.en/zh`.

## Pagination

`list` takes `{until, after, limit}` and returns `{items, hasMore}`:

1. Return one latest visit per user/source/resource, ordered `visitedAt DESC, id ASC` with ASCII binary ID order.
2. Use UTC ISO strings with milliseconds, and only `visitedAt <= until`.
3. `after=null` starts. Otherwise require `visitedAt < after.visitedAt`, or equal time with `id > after.id`. The boundary remains usable after its record is deleted.
4. `items.length <= limit`; the host currently requests at most 51. Short pages are allowed. Remaining records require `hasMore=true` and at least one returned item; empty pages cannot mean retry later.
5. Filter user visits and current permission first. The host also checks `activity.read` on every item and fetches more as needed. At most 20 batches and 1.5 seconds per source, including permission checks. Use indexes, honor cancellation, and avoid remote full synchronization inside queries.
6. Listing never updates visits. Record visits only after successfully opening business content. Calls and unconsumed candidates may repeat.

The host merges pages of 50 by descending visit time, ascending source ID, then resource ID. Built-in source is `doca`, with `kind:id` resource keys. Opaque next cursors bind user/filters and retain the first `until`, selected sources, and consumed positions.

The list reflects current permission rather than a frozen database snapshot. New visits appear on refresh; deletion, revocation, or updated visit times may remove records from a paging chain. Use managed transactions for consistent individual page reads.

Failure, timeout, invalid paging/path, or missing permissions service discards that source's entire page and preserves other sources. Failed sources remain skipped for later pages of that traversal and appear in `unavailableSources`; refresh retries. Newly registered sources also require refresh.

## Example

This `mount(context)` example requires plugin-implemented `mailStore`, persisted with current host-managed services; `mailStore` is not an SDK export.

```ts
const pluginId = "example.mail";

context.inject(permissionsServiceToken).register({
  pluginId,
  resourceType: "message",
  async authorize(principalId, messageId, action) {
    if (action !== "activity.read") return false;
    return mailStore.canRead(principalId, messageId);
  },
});

const source: ActivitySource = {
  id: `${pluginId}.messages`,
  pluginId,
  schemaVersion: 1,
  resourceType: "message",
  title: { en: "Mail", zh: "邮件" },
  icon: "mail",
  async list({ principalId, signal }, { until, after, limit }) {
    // 业务实现：按用户、当前权限、until、after 过滤，再依协议排序。
    // 可读取 limit + 1 条以判断 hasMore；只返回前 limit 条。
    return mailStore.listRecent(principalId, { until, after, limit, signal });
  },
  async get({ principalId, signal }, id) {
    // 必须确认这个用户有该访问记录，资源仍存在且当前仍可读。
    return mailStore.getRecent(principalId, id, { signal });
  },
};
context.inject(activityServiceToken).register(source);
```

Add `activity.read` to an existing permission registration rather than registering the same plugin/resource type twice. After a plugin's authenticated open-mail API successfully reads content, update its visit table with the session's user ID. On deletion, clean that table or filter deleted items through joins; the host cannot clean records it does not own.

## Host entry points and authorization

- `GET /api/v1/workspace/activity`: authenticated mixed list; accepts built-in `kind`, plugin `source`, and `cursor`. `kind` and `source` are mutually exclusive. Returns `items`, `nextCursor`, `sources`, `unavailableSources`.
- Plugin items have `kind=plugin`, `sourceId`, `sourceTitle`, and `icon`. UI keys include the source ID.
- `href` points to `/api/v1/workspace/activity/open?source=...&id=...`. The host rechecks account/source/`activity.read`, invokes `get` for the current path, reauthorizes, then redirects. Failure is 404; it does not redirect using a historical snapshot.
- Target pages and business APIs independently authorize. Activity grants no attachment or associated-document access.

## Acceptance and rollback

`tests/plugin-activity.test.ts` and `tests/workspace-home.test.ts` use isolated databases/installation directories. They cover equal-time order, traversal, short-page continuation, deletion, cross-user access, revocation, unregistering, failures/timeouts, unsafe redirects, invalid cursors, real package injection, and HTTP opening.

This capability introduced no persistent table change. Plugin history remains when reverting a host; a plugin requiring `activity.v1` refuses a host that lacks it. Do not delete business data for rollback.
