# 云端架构与实现边界

本文是当前模块结构、查询和一致性说明的入口；数据库与具体模块的实现以源码和当前建表定义为事实来源。

版本：0.1.0。本文描述本轮实际代码；桌面、DSH 和云备份仅保留产品设计，不建立运行适配层。

## 1. 决策

工作台布局：左侧依次为搜索、创作日历、主页、AI助手、随手记、知识库、回收站和可选云备份；进入知识库后左侧切换到该库自己的文档目录。个人文档打开为无侧栏独立页，知识库文档保持目录页形态。主页包含最近访问、归我所有、与我共享、收藏四个Tab，支持文档类型和时间排序。

个人信息支持昵称、预设或上传头像、修改密码。知识库支持上传封面；正文与管理页共用附件上传下载。管理员采用独立模块导航，包含概览、用户列表、登录与注册、文件存储、文档搜索、Hook。云备份和Hook入口明确显示未启用。后台统计只返回聚合数量，不给予管理员私有文档阅读权。

采用 TypeScript 插件化单体，不拆微服务。前后端同一仓库、独立目录与构建边界，开发时两个监听端口，浏览器始终访问一个同源地址；发布时后端可以直接提供前端构建产物。管理员在 `doca.config.ts` 安装可信 npm 插件；Cordis 负责进程内 Context、Service、effect 与生命周期，Doca SDK 负责稳定契约。

```text
浏览器（React / Vite）
    │ 同源 HTTP JSON / WebSocket + HttpOnly 会话 Cookie
    ▼
apps/server — Host/Origin 校验、登录、请求校验、HTTP 路由、静态文件
    ▼
PluginHost — discover、migration、mount、ready、逆序 dispose
    ├── AIHost / SearchHost（贯穿服务）
    ├── plugin-files（files.v1 基础能力）
    ├── plugin-documents（documents.v1 / KnowledgeSource 聚合）
    └── doca-mail（同级目录中的可安装、可禁用邮箱插件）
    ▼
packages/core — 账号、权限、成熟领域算法与事务边界
    ▼
packages/db — Kysely 类型、当前建表定义、SQLite / PostgreSQL 驱动
```

对熟悉 Go 的开发者：server 相当于 HTTP handler/middleware 层，core 相当于 service/domain 层，db 相当于数据库模型与访问层。TypeScript 类型用于编译时检查；TypeBox 请求 schema 用于真正运行时校验，不能只信任前端。

## 2. 目录与职责

| 路径                         | 责任                                              |
| ---------------------------- | ------------------------------------------------- |
| apps/server/src/main.ts      | 组装服务、开发代理、停止时释放连接                |
| apps/server/src/bootstrap/config.ts    | 环境配置校验与数据库连接                            |
| apps/server/src/app/create-app.ts      | API、会话和安全边界；可通过 inject 无监听端口测试 |
| apps/server/src/bootstrap/admin.ts | 运维显式初始化第一个管理员                        |
| apps/web/src/app/main.tsx   | 浏览器入口，只负责挂载根组件                      |
| apps/web/src/app/app.tsx    | 页面路由、全局状态和跨 feature 装配               |
| apps/web/src/features/documents/tree.tsx | 权限过滤后的目录树、展开、悬浮创建入口      |
| apps/web/src/features/documents/dialogs.tsx | 授权、所有权转移、移动确认                |
| apps/web/src/features/admin/admin.tsx | 用户管理、站点设置与注册开关                  |
| packages/core/src/modules/identity/passwords.ts    | 密码派生、账号创建和安全用户投影                  |
| packages/core/src/workflows/resources.ts | 资源规则、ACL、事务和审计                         |
| packages/db/src/create-schema.ts | 全新数据库的当前基线建表定义                    |
| tests/cloud.test.ts          | 临时数据库中的接口集成测试                        |

不允许 web 导入服务端数据库或密码模块；当前 web 使用专门的 HTTP DTO。后续接口规模扩大时，将 DTO/schema 提取为纯类型契约包，不向浏览器打包服务端实现。

应用代码按职责分组，但仍保持模块化单体，不拆微服务：

```text
apps/web/src/
  app/       入口和全局装配
  features/  按产品能力划分的页面、组件和本地样式
  shared/    可跨 feature 复用的 API、组件、hooks、utils
  styles/    全局样式和主题

apps/server/src/
  app/       Fastify 创建、请求上下文和安全边界
  routes/    HTTP 路由注册
  services/  AI、搜索、随手记、协同等应用服务
  adapters/  存储、身份、消息等外部适配器
  jobs/      后台任务
  bootstrap/ 启动配置和管理员初始化
```

Web、core、db 的源码导入使用 `@web/*`、`@core/*`、`@db/*` 别名，避免跨层级相对路径。`apps/*` 和 `packages/*` 均声明为独立 workspace package，但仍由根脚本统一构建和测试。

## 3. 身份、安全与权限

- 一次部署只有一套账号体系；不存在应用、空间、租户、组织表。
- 首次启动不会自动创建默认账号。管理员通过服务端命令初始化，注册默认关闭。
- 密码使用独立随机盐和 scrypt；会话 Cookie 为随机凭证，数据库只存 SHA-256 摘要，有效期 8 小时。
- 修改密码撤销全部会话；停用用户撤销会话并阻止后续访问。
- 所有请求校验配置的 Host；修改请求要求相同 Origin，Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 环境增加 Secure。
- 不接受请求体里的 owner_id、用户角色或任意字段；身份取自会话。资源创建者由服务端确定。
- 管理员并不自动获得内容访问权。无阅读权返回统一 404；有阅读权但不能执行操作返回 403。
- 单篇共享不公开祖先节点。返回的 parent_id/library_id 对无权访问的祖先置空，搜索结果先做权限过滤再分页。
- 通知只保存事件类型和资源引用，不保存可能泄露的标题/评论正文；查看资源时重新鉴权。

权限为 reader < commenter < editor < manager < owner。可见范围只提供 reader。知识库文档的 inherit 取父文档/知识库权限（上级 owner 在子文档上最多 manager），可叠加直接邀请；个人文档始终 custom，不继承普通成员。文档所有者始终拥有完整权限，知识库所有者始终保留库内文档管理权。命名用户授权来源、父子文档计算和分享撤销规则见[权限继承与统一授权方案](permission-inheritance.md)。

该知识库治理规则已按建议基线实现，UI 明示。转移文档不转移整棵树中其他文档的所有权；转移知识库会改变库级治理权，但不改写各文档 owner_id。

## 4. 一致性

- 元数据变更携带 version，服务端比较后更新。过期写入返回 409，不静默覆盖。
- 资源树、ACL、批量删除恢复操作在同一事务完成；审计、通知与业务修改同时提交或回滚。
- 业务事务不再写 settings 作为互斥锁。PostgreSQL 使用可序列化事务及冲突重试，SQLite 使用连接事务；正文确认在可靠提交后发出。
- 单篇操作加载目标与必要祖先，树修改加载受影响子树；列表在 SQL 中过滤权限后分页。用户入口、发现、最近访问与访问权独立。
- 点赞/收藏由复合主键唯一约束，并使用目标状态接口保证重复请求不重复计数。
- 移动需管理所有受影响子文档，不允许环。当前保守重置整棵移动子树的分享为独立私有、清空直接邀请，保留每篇所有者与目标知识库治理权；用户必须确认。
- 删除只进回收站，delete_batch 记录本次删除批次。恢复不复活此前已经单独删除的文档。
- 普通复制生成全新资源 ID，结构和正文资产ID重新映射、归复制者所有、独立私有；正文建立新的Yjs身份，不复制授权、评论、点赞收藏和撤销历史。

## 5. 当前能力与明确未实现

已接入真实数据：本地账号、登录退出、密码修改、注册开关、用户启停；个人文档列表、知识库树、标题搜索与类型过滤；权限、转移、移动、独立复制、回收站；全文评论/单层回复/处理状态、点赞收藏；通知列表与已读；系统配置。

仍需部署或外部联调的能力：

- 幻灯片编辑器与完整桌面离线运行时；富文本、Markdown、表格、画板及对应协同协议已接入。
- 作为 OIDC 源、SAML、账号找回；外部 OIDC 与社交登录适配已实现，真实平台凭据与部署联调待完成。
- Hook 配置/可靠投递；通知已使用WebSocket失效推送和HTTP补取。
- 生产 AI provider、MCP 外部客户端和 Meilisearch 集群联调；AI、MCP、SessionEvent、格式导入导出、正文附件及数据库降级检索已有实现。
- 桌面、DSH、设备绑定、版本化云备份与冲突解决。

评论详情当前最多返回最早 200 条；通知 API 有分页，UI 当前展示最新 50 条。目录树分页拉取当前有权访问的资源。以上是当前容量边界，不是最终产品限制。

## 6. 后续扩展顺序

先完成编辑器预览包的生产验收、账号找回、真实 SSO 联调、安全加固、评论分页、Hook outbox。云端主体稳定并完成真实部署测试后，才做桌面、DSH 和备份。

## 统一上传架构

`apps/server/src/routes/assets.ts` 负责上传校验、资源 ACL、资产记录及绑定；`storage.ts` 负责本地 / S3 读写与 CDN 签名。当前配置仅决定新上传落点，每个资产引用不可变的 storage_profile，配置切换不改变历史位置。头像、封面及未来正文图片使用同一入口。私有对象默认经后端鉴权读取，CDN 是可选的短时签名加速层，不是公开文件目录。详情见 [存储部署说明](storage.md)。

SSO 两个方向分开：当前外部身份关联唯一键为 provider_id+subject；provider 对应不可变的 type/issuer/client_id 命名空间，不按邮箱自动合并。使用 openid-client 校验 OIDC，并保留本站 Strict 会话及同源完成绑定。提供方方向尚未实现，不能靠当前登录接口冒充 OIDC。身份源、审批策略和部署细节见 [身份认证设计](authentication.md)。

管理员 `#/admin`、个人信息 `#/account`、个人偏好 `#/preferences` 均采用独立设置外壳，不渲染文档导航树。认证适配器位于 `apps/server/src/adapters/identity-providers.ts`，业务策略和安全流程在 `packages/core/src/modules/identity`，页面在 `apps/web/src/features/auth/authentication.tsx`。

正文协同走 WebSocket，元数据仍走 HTTP。服务端校验更新、鉴权、广播、持久化与生成恢复状态；不同编辑器的解析/锚点由对应包提供。元数据 version 不充当 Yjs state vector 或云备份版本。相关实现位于 `apps/server/src/services/realtime/gateway.ts`、`apps/server/src/routes/search.ts`、`apps/web/src/features/documents/document-editor.tsx`，详见 [协同与搜索实现](collaboration.md)。

未来 Hook 使用与业务事务同提交的 outbox，签名、重试、幂等和投递审计；外呼地址必须防 SSRF。不直接在业务事务内执行网络回调。
