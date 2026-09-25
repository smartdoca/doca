# 插件化部署

这是 Doca 的首次正式数据库和 `/api/v1` 基线，没有旧架构数据迁移、双写或兼容层。
开发数据不兼容时直接重建数据库。

## 全新安装

1. 安装 workspace/生产依赖。
2. 在 `doca.config.ts` 中列出受信任插件。
3. 配置数据库、对象存储、AI provider 和可选 Meilisearch。
4. 执行建库及插件 migrations。
5. 构建 Web/Mobile 静态插件入口。
6. 启动 Server；Host 完成 `discover → migrate → mount → ready` 后才接收流量。
7. 检查 `/api/v1/bootstrap` 的插件 ID/版本与客户端构建清单一致。

Cordis 固定为 `@deepseek-ai/cordis@4.0.4`。升级前必须先运行 PluginHost、effect
逆序清理、协同会话和 shutdown contract tests，不允许使用浮动版本。

## 安装邮箱插件

```sh
pnpm add @doca/plugin-mail
```

随后将 `plugin("@doca/plugin-mail")` 加入 `doca.config.ts`，执行 migration、
重新构建客户端并重启。启动成功后应同时出现：

- Server 邮箱路由与同步任务；
- Web/Mobile 邮箱入口；
- 管理员邮箱配置；
- AI intent/workflow/tool/skill/acceptance；
- 邮件 SearchSource 与 KnowledgeSource；
- 对话、搜索和知识来源 renderer。

附件与内嵌图片由 `files.v1` 保存。邮件数据库和配置不能成为身份验证码 messaging
adapter 的替代品。邮箱没有私有附件存储回退路径；缺少 `files.v1` 时插件应在启动
注入检查阶段失败。

## 禁用与移除

先从配置移除插件并重新构建客户端，再 drain 活动任务并重启 Server。Host 会按反向
依赖顺序释放 source、tool、listener、worker 和其他 effects。未安装 handler 的持久
任务变为 `blocked-plugin-missing`，由管理员选择重装、迁移或删除；不会自动重试。

默认保留插件表、对象、版本化搜索索引和 migration 记录。清理是单独、显式的运维
操作，不能在插件 dispose 中删除持久数据。

## 破坏性升级策略

当前是全新系统的首个正式基线，不提供旧版 route、表结构、双写、旧 tool ID 或
v1→v2 数据搬迁兼容层。开发环境遇到不兼容 schema 时重建隔离数据库；生产发布后
才允许通过插件 migration 前进，禁止修改已经执行的 migration。

插件 SDK、capability major、协同 codec/schema 或 SearchSource schema 发生破坏性
变化时：

1. 提升对应 manifest/capability major，并让依赖范围显式失败；
2. 为持久数据编写幂等 migration，为搜索索引建立新版本并原子切换；
3. 同一次构建更新 Server/Web/Mobile 入口，不保留静默兼容分支；
4. 对协同变更继续保留 epoch、持久 ACK、outbox 重放和 readonly 不变量；
5. 在隔离数据库与测试文档上完成全量发布门槛后再部署。

## 发布门槛

- 空数据库安装、建库、构建和启动通过；
- 邮箱启用/禁用两种组合通过；
- 全量类型检查、测试和 Web 构建通过；
- Search ACL 二次过滤、AI replay、文件 owner binding、知识游标与 provenance
  contract tests 通过；
- 协同测试使用隔离文档，验证 epoch/ACK/reconnect/readonly/presence/资源 ACL；
- shutdown 后没有活动 timer、worker、route source 或 renderer effect。
