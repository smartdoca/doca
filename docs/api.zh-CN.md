# HTTP API

[English](api.md)

本页为宿主 0.1.10 的主要接口索引。运行中的 `/api/openapi.json` 提供已注册路由及 schema，服务端代码是授权、未标注字段和行为限制的最终依据。旧接口记录见[研发资料](research.zh-CN.md)，不能据此调用当前发行版。

## 通用约定

下表路径以 `/api/v1` 为前缀。浏览器使用 HttpOnly 会话 Cookie；写请求要求配置的 Host 和同源 Origin。原生客户端使用宿主认证 Bearer 会话，插件 WebView 使用受限的插件会话。公开资源只开放其实际允许的读入口。

元数据 `version`、配置 `revision`、正文 `seq`/`epochId` 各有职责；读取最新值后提交。409 表示冲突或协议/状态不支持，不自动强制覆盖。分页参数因接口而异，按 `nextCursor` 或 `nextOffset` 继续。无内容阅读权通常返回 404，系统管理权不会授予私有正文访问。

## 账号与管理

| 接口 | 用途与权限 |
| --- | --- |
| `GET /bootstrap` | 当前用户、站点、能力和已加载插件；不返回密钥 |
| `POST /auth/login`、`POST /auth/logout` | 密码登录 / 退出 |
| `POST /auth/register` | 按站点准入规则注册；pending 不发会话 |
| `GET /me` | 本人资料和偏好 |
| `GET /auth/providers` | 可用身份源 |
| `GET /admin/users` | 管理员用户查询，支持 status/q/cursor |
| `PATCH /admin/users/:id` | `{status:active\|disabled}`，启停普通用户；pending 必须走注册审批 |
| `GET /admin/registration-reviews` | 管理员审批列表 |
| `POST /admin/registration-reviews/:id` | `{decision:approved\|rejected,message?}`，独立审批 |
| `GET /admin/stats` | 聚合统计，不授予内容权限 |

联系方式验证码、恢复、身份绑定、安全验证、账号策略和外部身份回调见[身份认证](authentication.zh-CN.md)。服务凭据见[凭据说明](service-credentials.zh-CN.md)，插件凭证使用独立[加密服务](plugin-credentials.zh-CN.md)。

## 文档、权限与历史

| 接口 | 用途 |
| --- | --- |
| `GET /resources`、`GET /resources/:id` | 经过权限过滤的列表 / 详情 |
| `POST /resources` | 创建文档或知识库；文档格式为 rich_text/markdown/spreadsheet/presentation/canvas |
| `PATCH /resources/:id` | 带 version 修改元数据 |
| `PUT /resources/:id/permissions` | 带 version 配置权限 |
| `POST /resources/:id/transfer`、`POST /resources/:id/move` | 所有权转移 / 移动 |
| `POST /resources/:id/copy` | 创建独立副本 |
| `POST /resources/:id/trash`、`POST /resources/:id/restore` | 回收站删除 / 恢复 |
| `GET /resources/:id/versions`、`POST /resources/:id/versions` | 历史列表 / 手动快照 |
| `GET /resources/:id/versions/:versionId` | 预览；表格、幻灯片、画布的 canRestore 为 false |
| `POST /resources/:id/versions/:versionId/restore` | `{expectedSeq}`，管理者恢复富文本/Markdown |
| `POST /share/redeem` | 登录后预览或接受文档/问答链接 |

正文编辑使用 `/api/v1/ws`，见[协同](collaboration.zh-CN.md)。权限字段、来源和继承见[权限](permission-inheritance.zh-CN.md)；分享及历史见[文档指南](document-experience.zh-CN.md)。

## 评论、通知与发现

评论创建使用 `POST /resources/:id/comments`，请求为 `{richBody,parentId,anchor?}`。`richBody` 是 version 1 的结构化评论，不接受旧纯文本 `body` 请求。修改使用 `PATCH /resources/:id/comments/:commentId`，带评论 version 及 richBody/deleted/resolved 操作。单层回复、图片、提及和锚点限制见[评论与通知](comments-and-community.zh-CN.md)。

通知使用 `GET /notifications`、`POST /notifications/read`、`POST /notifications/read-all`。WebSocket 失效事件触发重新读取；列表重新鉴权。发现、收录、最近访问和邀请接口见[发现说明](public-resource-discovery.zh-CN.md)；引用和附件下载见[编辑器集成](editor-integration.zh-CN.md)。

## 搜索

`GET /search/documents` 查询当前有权访问的文档。关键词模式可降级到数据库并返回 notice；向量模式需要可用的 Meilisearch 和模型。结果仍按当前权限校验，不从索引直接授予权限。

管理接口为 `GET/PUT /admin/search`、`POST /admin/search/reindex`、`POST /admin/search/reconcile`，以及 `/admin/search/embeddings`、`/admin/search/embeddings/status` 和 `/admin/search/relevance`。索引配置任务返回 202 只表示排队，需查询结果；模型或密钥变化后需重新应用。图片识别策略目前只保存配置，不能声称启用后已接入搜索 OCR 流水线。

## 文件与存储

资产上传：`POST /assets?purpose=&filename=&resourceId=`，支持 avatar/cover/attachment/comment_image，按用途校验权限。下载：`GET /assets/:id/content`；强制下载加 `?download=1`。头像/封面/评论图片最大 5 MiB，正文附件最大 20 MiB。普通平台文件通过 `/files` 系列接口上传，使用独立限额及分片流程。

正文附件和 AI 附件创建同时返回素材 `id` 与实际文件 `fileId`。附件内容和生图引用使用素材 ID，`/files/items/:id` 操作使用文件 ID。`POST /files/items/:id/attach` 也返回这两个 ID；无需再搜索全局目录找回上传文件的 ID。

`GET /admin/storage` 只读展示部署后端；`PUT /admin/storage` 返回 405。后端和凭据通过环境变量配置，详见[文件存储](storage.zh-CN.md)。

## AI、知识与插件

AI 会话和任务位于 `/ai`，模型工具受会话范围、真实资源权限和审批约束。`POST /ai/jobs/:id/approval` 接受 `{approvalId,approved}`，仅任务所属用户可决定；审批不改变用户原有资源权限。

知识整理、机器人 API/MCP、独立密钥和流式回答见[知识整理](knowledge-studio.zh-CN.md)；统一来源在 `/content`，见[内容协议](plugin-content.zh-CN.md)。已安装插件业务路由为 `/plugins/:pluginId/...`，实际可用性取决于当前加载的包。宿主没有随手记或邮箱专用业务 API，见[功能与边界](features.zh-CN.md)。

## 健康与源码

`GET /health`、`GET /live`、`GET /ready` 不带 `/api/v1` 前缀；响应报告宿主版本。ready 检查数据库及已配置的 Redis，不代替完整外部服务验收。

路由来源：[应用](../apps/server/src/app/create-app.ts)、[路由目录](../apps/server/src/routes)、[历史接口](../apps/server/src/routes/experience.ts)、[实时网关](../apps/server/src/services/realtime/gateway.ts)。
