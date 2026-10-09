# 功能与边界

[English](features.md)

本页按宿主 **0.1.10**、插件 SDK **0.1.9** 的当前源码核对，核对日期为 2026-10-04。安装业务插件前，宿主提供下表中的核心能力。某个插件的功能、版本和验收结果以该插件自己的文档为准。

## 核心能力

| 能力 | 当前状态与条件 | 使用说明 |
| --- | --- | --- |
| 富文本、Markdown、表格、幻灯片、画布 | 五种编辑器均已接入；编辑需要资源权限 | [文档与分享](document-experience.zh-CN.md) |
| 实时协同与保存确认 | 五种格式使用宿主 WebSocket 和持久化回执；多实例需要共享 PostgreSQL、Redis 和文件存储 | [实时协同](collaboration.zh-CN.md) |
| 历史、手动快照与恢复 | 五种格式可读历史；仅富文本/Markdown 可恢复，需管理权限、当前正文序号及可恢复快照 | [文档历史](document-experience.zh-CN.md#历史与恢复) |
| 知识库与权限 | 目录、邀请、继承、分享链接、转移、移动、独立复制和回收站 | [权限](permission-inheritance.zh-CN.md) |
| 发现、收录与最近访问 | 已实现；展示与访问权限分别校验 | [发现与收录](public-resource-discovery.zh-CN.md) |
| 文件与附件 | 个人文件、共享文件夹、授权上传下载；部署必须配置本地或 S3 存储 | [文件存储](storage.zh-CN.md) |
| 评论与站内通知 | 五种格式已实现，包括表格稳定行列锚点 | [评论与通知](comments-and-community.zh-CN.md) |
| 文档搜索 | 数据库基础检索可用；全文与向量索引需要配置 Meilisearch 和相应模型 | [HTTP API](api.zh-CN.md#搜索) |
| 个人 AI 助手 | 已实现会话、工具、审批和用量事实记录；需要配置可用模型及凭据 | [使用指南](user-guide.zh-CN.md) |
| 知识册与来源订阅 | 属于核心；保留文档与来源订阅，新增知识册、可编辑编排、溯源及人工反馈；旧整理与问答机器人已移除 | [知识册](knowledge-books.zh-CN.md) |
| 本地账号与外部登录 | 密码、联系方式验证码、恢复、注册审批、OIDC/OAuth 及社交适配已实现；外部服务需要实际凭据 | [身份认证](authentication.zh-CN.md) |
| Webhook | 异步投递、重试和记录已实现；需要配置接收端 | [Webhook](webhooks.zh-CN.md) |
| 插件安装和公开 SDK | 可信预构建包、安装目录发现、重启应用；托管 SQL、对象和加密凭证已实现 | [插件部署](plugin-deployment.zh-CN.md) |

## 独立插件与已移出功能

- **随手记**已移出宿主。当前宿主没有 `#/notes` 页面、`/api/v1/quick-notes` API、`quick_notes` 或 `quick_note_compilations` 表。历史说明仅保留在[研发资料](research.zh-CN.md)，不能按其中接口调用当前宿主。本仓库不提供随手记插件的安装包或当前使用承诺。
- 邮箱、日历、会员、积分、计费、业务额度和内容审核由独立业务插件提供，默认镜像不安装这些业务。注册审批与安全审计仍属于核心，和业务内容审核不同。
- 模板、素材、素材集和插件文档元素有宿主接口及选择器，但**默认没有提供者**。需要另外安装匹配 SDK 的提供者；宿主没有原来的模板管理 CRUD 页面。没有提供者时仍可创建空白文档。
- 示例包位于 [examples](../examples)，用于开发与隔离验收，默认镜像不安装，也不代表独立业务插件已验收。

## 尚未提供或需单独验证

- 持久离线编辑队列、完整桌面离线运行时、Doca 作为 OIDC 提供方、SAML 尚未提供。
- 插件临时工作区、集群业务任务排空、任意 SQL 与跨服务分布式事务尚未提供。SDK 的目标契约不等于现有导出，见[实现状态](plugin-sdk-contract.zh-CN.md)。
- 原生插件 WebView 容器已有源码协议；iOS/Android 构建、设备行为和独立插件适配需要各自验收。服务端安装不会下载执行原生 JavaScript。
- 真实 AI、SSO、验证码网关、Webhook、S3/CDN 等服务的可用性取决于部署环境。发行记录中的历史测试结果有各自范围，不能代表所有外部服务或设备已验证。

## 核对依据

核对包括 [服务组装](../apps/server/src/plugins/composition.ts)、[页面路由](../apps/web/src/app/app.tsx)、[五种编辑器分派](../apps/web/src/features/documents/document-editor.tsx)、[历史接口](../apps/server/src/routes/experience.ts)、[账号接口](../apps/server/src/routes/accounts.ts)、[当前建表定义](../packages/db/src/create-schema.ts) 和 [SDK 导出](../packages/plugin-sdk/package.json)。`bootstrap.capabilities` 和 `bootstrap.plugins` 可用于确认某次部署的宿主能力与已加载插件；前者不是完整业务功能清单。
