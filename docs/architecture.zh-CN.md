# 架构与实现边界

[English](architecture.md)

基线：宿主 0.1.10 / SDK 0.1.9，2026-10-04 按当前源码核对。本文说明已实现的组装与边界，外部服务和设备行为需单独验收。先看[功能与边界](features.zh-CN.md)。

## 应用与模块

Doca 是 TypeScript 插件化单体。开发时 React/Vite 与 Fastify 监听不同端口，浏览器通过同一来源访问；生产由 Fastify 提供构建后的 Web 页面和 API。Cordis 管理进程内服务与生命周期，公开 SDK 定义插件边界。

```text
浏览器：React + 五种文档编辑器
  │ 同源 HTTP / WebSocket，宿主认证会话
Fastify：Host/Origin 校验、路由、安全与静态资源
  │
宿主组装：账号、文档、文件、搜索、AI、知识整理
  │ 从安装目录发现可信业务插件
Core 领域规则 / Kysely 数据库访问
  │
单机 SQLite，或共享 PostgreSQL + Redis + 文件后端
```

默认宿主包括富文本、Markdown、表格、演示文稿、画板、文档权限、发现、文件、知识整理、问答助手、认证、注册审核、安全审计和原始 AI 用量事实。随手记、邮箱、日历、会员、计费、业务配额与内容审核属于独立业务，默认不安装这些提供者。模板、素材与文档元素具备宿主接口，默认提供者为零。

## 目录

| 路径 | 职责 |
| --- | --- |
| `apps/server/src/main.ts` | 启动、监听、关闭 |
| `apps/server/src/bootstrap/config.ts` | 来源、数据库、代理与 Redis 配置 |
| `apps/server/src/app/create-app.ts` | HTTP 路由、会话与安全边界 |
| `apps/server/src/plugins/composition.ts` | 内置服务与已安装插件组装 |
| `apps/server/src/routes` | 宿主 HTTP 入口 |
| `apps/server/src/services` | 协同、搜索、AI 等应用服务 |
| `apps/web/src/app/app.tsx` | 工作台路由与功能组装 |
| `apps/web/src/features/documents/document-editor.tsx` | 五个已安装编辑器的分派 |
| `packages/core/src` | 领域规则、授权与事务 |
| `packages/db/src/create-schema.ts` | 当前空数据库基线 |
| `packages/plugin-sdk` | 公开服务端、Web 与插件接口 |
| `tests` | 隔离单元与集成检查 |

网页通过 HTTP DTO 调用，不导入数据库或密码内部模块。业务插件使用公开 SDK 服务，不导入宿主源码、不建立全局运行时桥，见[插件架构](plugin-architecture.zh-CN.md)和[实现状态](plugin-sdk-contract.zh-CN.md)。

## 身份与安全

一次部署是一套账号体系，没有组织、空间或租户表。注册和外部身份源默认关闭，不创建默认管理员。密码采用随机盐与 scrypt，数据库保存会话摘要；本站会话有效期八小时。改密码、停用账号会撤销会话。

所有请求检查配置的 Host，写入还检查同源 Origin。本站 cookie 为 HttpOnly、SameSite=Strict，HTTPS 时带 Secure。支持外部 OIDC 与社交适配，联系方式验证和账号找回已经实现，但需要验证网关。注册审批使用独立审核流程。尚不提供 OIDC 服务端、SAML 或 IdP 全局退出，见[认证](authentication.zh-CN.md)。

管理身份不授予私有内容访问权；缺少读取权限通常返回 404，可读但无操作权限返回 403。ACL、继承授权、公开、收录和分享各有规则，隐藏祖先不会泄露，见[权限](permission-inheritance.zh-CN.md)和[发现](public-resource-discovery.zh-CN.md)。

## 持久化与协同

元数据使用 HTTP 和版本检查。五种编辑器共用宿主 WebSocket 生命周期，各有 Yjs codec。服务端验证内容、复查授权，提交后才确认保存；元数据版本、正文序号、epoch、schema 和历史 ID 分别管理。五种格式均有历史读取，目前仅富文本和 Markdown 支持恢复，见[协同](collaboration.zh-CN.md)和[文档历史](document-experience.zh-CN.md)。

单机使用 SQLite、AI 和 Webhook 数据库及本地文件。PostgreSQL 使用独立 Webhook 数据库和 AI schema。多副本需要共享数据库、文件后端，以及承担事件、在线状态与限流的 Redis；未配置 Redis 时这些实现仅在进程内，已配置但故障时不静默回退。数据库任务使用租约或 outbox，不只存在进程内，见[配置](configuration.zh-CN.md)和[水平扩展](horizontal-scaling.zh-CN.md)。

对象保存稳定存储 ID 与引用，环境配置物理后端，存储管理页只读。私有下载复查授权；CDN 只提供短期授权地址，不代替存储。备份覆盖每个数据库、引用后端、插件归档和受保护配置，见[文件存储](storage.zh-CN.md)。

已安装插件使用共享注册记录和不可变归档，每实例需要启动时恢复的可写缓存目录；人工重启使目标版本生效。托管私有 SQL、对象与凭证已实现，任务排空、临时工作区和更强进程隔离尚未交付。版本和结构严格校验，不支持的基线被拒绝；本文不增加迁移或兼容适配，已有数据必须保留，见[发行要求](releases/0.1.10.zh-CN.md)。

## 当前限制与验收

评论线程和通知使用独立分页接口，文档详情不是全部评论导出。持久离线 outbox、原生设备接入、真实身份/AI 平台、生产 S3/CDN 和目标基础设施故障恢复，需要各自的实现或验收。隔离测试只证明已声明范围，构建通过不代表外部服务均可用。
