# 通用内容来源 content.v1

[English](plugin-content.md)

公开入口：`@smartdoca/plugin-sdk/content`。宿主定义契约和调用入口，插件负责业务实现；内置文档和文件也注册相同来源。此接口不会自动把全部来源交给 AI。

## 契约

- `sources(context, purpose)`：发现来源声明。
- 来源必需实现 `list`、`read`、`resolve`；可选 `search`，声明与实现严格一致。
- `list(context, {config, cursor, limit})`：返回轻量块清单 `{items,nextCursor,snapshot}`，每项包含 `ref:{sourceId,resourceId,blockId}`、`fingerprint`、`title`，可带 `order`、`anchor`、短 `excerpt`，禁止包含 `text` 正文。
- `read(context, {config,ref,fingerprint})`：只读取指定块正文，返回清单字段及 `text`，当前不可读返回 null；指纹变化返回冲突，消费端重新枚举。
- `resolve(context,ref)`：重新授权并返回 `{path,fingerprint}` 或 null，path 只能是站内路径。
- `search(context, {config,cursor,limit,query})`：返回相同轻量清单，由来源实现搜索，不自动用全文扫描替代。

服务调用 list/read/search 时另传 `sourceId` 与 `purpose`；来源回调得到真实 `principalId`、`purpose` 和 `signal`。来源必须在每次调用校验当前账号、配置范围和权限；不得信任请求体中的用户 ID。宿主调用前后检查用户状态与来源生命周期，并设置 20 秒调用超时。

```ts
const content = context.inject(contentServiceToken);
content.register({
  id: "example.tasks.content", pluginId: "example.tasks", version: 1,
  title: { zh: "待办", en: "Tasks" }, contentTypes: ["task"],
  purposes: ["analysis", "knowledge"], capabilities: { search: false },
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  list: listAuthorizedTaskBlocks,
  read: readAuthorizedTaskBlock,
  resolve: resolveAuthorizedTaskBlock,
});
```

三个回调由插件实现。不得读取宿主私有表、源代码路径或其他插件数据库。

## 对账规则

消费端保存当前身份、订阅配置对应的引用与指纹，完整枚举后比较：不变块无需读取或 AI 分析，变化块定点读取。只有完整遍历成功才可以认定旧引用消失。超时、分页失败、快照变化和权限不确定均不能当作空集合；不更新已消费指纹，后续重试。

`cursor=null` 开始，`nextCursor=null` 结束；一次遍历的 snapshot 必须一致。分页游标只用于遍历，不是持久增量日志游标。来源应在内容、范围或权限变化使遍历失去完整性时拒绝旧游标。无需实现独立 listChanges/readChanges。

宿主限制每页 100 项、单块正文 200 万字符，并验证引用、重复项、游标与取消。完整清单上限 10 万块；分析辅助器限制本次变化正文总量，超限明确失败，不截断后宣称完整。

内置来源通过段落内容寻址。未改段落不会因前方插入段落而改变身份；修改正文表现为旧块消失、新块出现。它不是原生编辑器稳定节点 ID。重复块、标题上下文和长段落切片的边界见 [内容指纹与搜索对账](content-fingerprint-reconciliation.md)。

## 宿主入口与消费端

HTTP：GET `/api/v1/content/sources?purpose=analysis`；POST `/api/v1/content/list`、`read`、`resolve`、`search`。身份来自宿主会话，响应 no-store。

全局搜索只调用声明 search 的来源。知识库/文档筛选不能套到插件业务范围时，不混入插件结果。点击再次 resolve。

原知识库保留 `knowledge_subscriptions` 和 `knowledge_source_groups.config` 的来源登记，不再创建整理任务、派生条目或消费指纹副本。POST `/api/v1/knowledge/libraries/:id/content-subscriptions` 接收 `{sourceId,config,title}`，要求来源支持 knowledge。仅贡献者可以修改提供方来源范围。

知识册独立在运行时读取完整授权清单，发布前复验。证据保留 `contentRef`、来源版本、内容哈希与精确引用片段。提供方、绑定、贡献者或原来源权限不可用时，衍生成果停止展示；保留数据不授予访问权，不建立额外完整正文存储。

来源选择器提供基础 schema 表单；复杂嵌套配置需要插件自己的配置页。编辑接口为 PUT `/api/v1/knowledge/libraries/:id/content-source-groups/:groupId`，参数同新增接口；仅订阅发起者可修改来源范围。配置变化影响后续来源读取。

现有 knowledge.sources.v1 没有自动适配为 content.v1；业务插件需实现公开标准。知识册使用新数据库基线，不提供历史转换或旧协议适配。
