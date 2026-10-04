# 插件接入首页最近访问

[English](plugin-activity.md)

2026-09-30。本接口已在仓库实现，公开导出位于 `@smartdoca/plugin-sdk/platform`。使用包含本接口的 SDK 构建产物和对应宿主；这里不代表已经发布了新的 npm 版本。

## 存储与职责

插件通过 `activityServiceToken`（服务 ID `activity.v1`）注册数据源。插件定义访问记录、历史查询、当前业务权限与删除清理逻辑；持久化依赖宿主托管能力，不能自建数据库或持久目录。activity.v1 只聚合来源，不另建业务记录镜像，也不提供专用的代写访问接口。持久化使用当前公开的托管 SQL/对象服务，见[存储规范](plugin-horizontal-scaling.zh-CN.md)。

宿主已有记录继续保存在 `resource_visits`、`knowledge_assistant_users.visited_at`、`workspace_activity`，由内置来源加入汇总。没有表结构变更、历史搬迁或双写。公共资源发现页继续使用 `/workspace/recent?publicOnly=true`，其收录逻辑仅适用于内置资源；插件注册最近访问不意味着接入公共发现、收藏、搜索或 AI。

插件停用后注册随生命周期释放，列表及打开入口立即不再提供该来源；持久记录不被宿主删除。重新启用后重新查询插件当前数据。实际安装、停用仍遵循各宿主实例重启生效的插件生命周期。

## 注册接口

```ts
import {
  activityServiceToken,
  permissionsServiceToken,
  type ActivitySource,
} from "@smartdoca/plugin-sdk/platform";
```

在插件 `injections.required` 中声明 `activityServiceToken` 和 `permissionsServiceToken`。不具备 `activity.v1` 的宿主应明确拒绝加载此插件，不使用宿主私有表或旧接口降级。已有不使用此能力的插件无须修改。`register(source)` 返回注销函数；通过安装插件注入的服务注册时，宿主自动绑定 effect，停止或初始化失败时释放。

每种内容类型注册一个来源，例如 `example.mail.messages` 和 `example.mail.threads`：

| 字段 | 约定 |
| --- | --- |
| `id` | 插件 ID 加点号开头的唯一来源 ID，最长 150 字符 |
| `pluginId` | 必须等于被注入服务的插件身份 |
| `schemaVersion` | 固定为 `1`，不支持的版本拒绝注册 |
| `resourceType` | 已注册至 `permissions.v1` 的资源类型，条目 ID 即该类型的资源 ID |
| `title` | 必须包含 `en`、`zh`，每种最长 100 字符；用于首页类型筛选及来源文字 |
| `icon` | `file`、`mail`、`calendar`、`message`、`task`、`book`、`folder` 之一 |
| `list(context, input)` | 返回当前用户可读的访问记录分页 |
| `get(context, id)` | 打开前查询当前记录、标题、路径并复查权限；不存在或不可读时返回 `null` |

ID 与资源类型采用小写字母开头、字母数字及点号/连字符分段的标识。宿主每实例最多注册 64 个插件来源，重复 ID 拒绝注册。每个来源可返回任意数量的业务资源，但必须分页。

`context` 是宿主构造的 `{ principalId, signal }`。用户 ID 来源于认证会话，不能从浏览器参数中选取其他用户。响应条目为：

```ts
{
  id: "message-123",                  // 唯一资源 ID，1–500 个可见 ASCII 字符
  title: "季度预算讨论",              // 原始内容标题，非空，最长 500 字符
  visitedAt: "2026-09-30T09:20:00.000Z",
  path: "/mail/inbox?message=message-123"
}
```

`path` 必须是站内路径，以 `/` 加字母或数字开头，不含 origin、hash、反斜杠或控制字符；禁止外部地址及协议相对地址。查询值自行 URL 编码。业务标题保持原文，类型名称通过 `title.en/zh` 本地化。

## 分页协议

`list` 收到 `{ until, after, limit }`，返回 `{ items, hasMore }`：

1. 每个用户、来源、资源只返回一次最后访问记录。按 `visitedAt DESC, id ASC` 排序；ID 比较必须采用 ASCII 二进制顺序，不能按本地化排序。
2. 时间统一为带毫秒的 UTC ISO 字符串，例如 `2026-09-30T09:20:00.000Z`。只返回 `visitedAt <= until`。
3. `after` 为 `null` 时从头开始，否则应用严格边界：`visitedAt < after.visitedAt`，或时间相等且 `id > after.id`。记录被删除后仍可使用这个数值边界，不能要求边界记录仍然存在。
4. `items.length <= limit`，宿主目前最多请求 51 条。允许短页；如果还有记录，`hasMore` 必须为 `true`。`hasMore=true` 时必须至少返回一条记录，不能用空页表示“稍后重试”。
5. 插件查询先按当前用户访问记录及权限过滤。宿主仍调用 `permissions.v1` 对每项检查 `activity.read`，权限过滤后会按需续取；一次请求最多续取 20 批，包含权限检查在内的来源总耗时限制为 1.5 秒。实现应使用索引，响应取消信号，不在查询中做远端全量同步。
6. 列表查询不得更新访问时间；只有业务内容成功打开才记录访问。同一请求可能被重复调用，未被宿主当前页消费的候选也可能再次查询。

宿主每页展示 50 条，以访问时间倒序、来源 ID 正序、资源 ID 正序合并；内置来源 ID 为 `doca`，其资源排序键为 `kind:id`。下一页游标保存首次查询的 `until`、已选择来源和各来源已消费的位置，绑定用户及筛选条件。前端将游标视作不透明值，不自行拼装。

这是当前权限下的实时列表，不是冻结数据库快照。翻页期间的新访问在刷新后出现；删除、撤权或更新了访问时间的记录可能从当前翻页链消失。插件业务查询通过托管事务保证单次分页读取一致。

来源异常、超时、非法分页/跳转或权限服务缺失时，该来源本页结果全部丢弃，其他来源继续返回。失败来源在本轮后续分页中保持跳过，并通过 `unavailableSources` 提示刷新重试，避免恢复时向后续页插入更早应显示的内容。新注册来源也要刷新后进入本轮分页。

## 接入示例

以下为插件 `mount(context)` 内的来源注册示例。`mailStore` 是插件需要实现的业务服务，不是 SDK 导出；其持久化必须使用宿主托管能力。该示例只展示来源注册，不代表可独立安装的完整邮件插件；mailStore 应按当前托管存储契约实现。

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

已有权限注册器若还支持邮件读取等业务 action，应在同一个注册器内加入 `activity.read` 分支，不要为相同插件/资源类型重复注册。

在插件自己的“打开邮件”认证接口成功读到内容之后，以宿主会话中的用户 ID 更新插件访问表。删除邮件时清理插件访问表，或者查询时通过关联过滤已删除邮件；不要请求宿主清理它没有持有的记录。

## 宿主入口与权限

- `GET /api/v1/workspace/activity`：认证用户的混合列表。支持 `kind`（五种内置类型之一）、`source`（插件来源 ID）、`cursor`；`kind` 与 `source` 不能同时提供。返回 `items`、`nextCursor`、`sources`、`unavailableSources`。
- 插件条目的 `kind` 为 `plugin`，带 `sourceId`、`sourceTitle`、`icon`。渲染 key 必须包含来源 ID，不能只用资源 ID。
- 插件条目的 `href` 指向宿主 `/api/v1/workspace/activity/open?source=...&id=...`。宿主复查账号、来源及 `activity.read`，调用 `get` 获取最新路径，再复查授权并跳转；失败返回 404，不使用历史快照跳转。
- 插件目标页面和业务 API 仍须独立鉴权。最近访问不是授权入口，也不会授予附件或关联文档权限。

## 验收与回退

使用隔离数据库和临时安装目录，覆盖跨来源同时间排序、多页遍历、短页补取、资源删除、跨用户访问、撤权、注销、故障/超时、危险跳转、错误游标，以及真实安装包服务注入和 HTTP 打开流程。仓库测试为 `tests/plugin-activity.test.ts`，内置访问记录测试为 `tests/workspace-home.test.ts`。

回退宿主时无需回退数据库：本能力未新增或改变任何持久表。插件自己的历史记录继续保留；依赖 `activity.v1` 的插件在不提供该服务的宿主上拒绝加载。不要删除业务数据来实现回退。
