# 通用内容来源 content.v1

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

知识库 content 订阅复用 `knowledge_subscriptions`、`knowledge_source_groups.config`、现有整理任务；配置中只存来源配置、身份和已消费块指纹，不保存额外完整邮件正文。新订阅入口为 POST `/api/v1/knowledge/libraries/:id/content-subscriptions`，参数 `{sourceId,config,title}`。来源必须支持 knowledge。整理逐块读取和分析变化正文，成功事务才确认指纹；草稿引用携带 contentRef。

来源删除、解绑或撤权的用户确认策略：暂停衍生结果访问和检索，保留内容供管理员处理。新文档读取、资源列表（含搜索候选）和问答快照均按当前来源清单与指纹过滤。来源失败同样阻止本次返回，不删除内容。管理端保留条目。既有已打开协作连接的即时踢出和已下发内容撤回不在本次实现保证内。

外部来源复验在事务前完成；事务内只提交配置 CAS、订阅状态和消费指纹。资源预检只在本次操作内复用，绑定读取者和条目引用签名；缺少预检的事务读取保守阻止派生内容。单文档或指定库查询限制预检范围，跨库列表检查候选派生条目。

来源选择器提供基础 schema 表单；复杂嵌套配置需要插件自己的配置页。编辑接口为 PUT `/api/v1/knowledge/libraries/:id/content-source-groups/:groupId`，参数同新增接口；仅订阅发起者可修改来源范围。配置变化后重新对账，保留既有内容供复核。

现有 knowledge.sources.v1 没有自动适配为 content.v1；业务插件需实现公开标准。未新增数据库结构、历史数据转换或旧协议兼容代码。
