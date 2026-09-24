# Doca

面向个人与小团队的轻量文档知识库。已从旧版重建，不含空间、根应用/子应用、组织架构。

## 当前版本

已落地可运行的云端管理基线：

- 账号登录、修改密码；按账号密码/SSO/第三方入口分别设置关闭注册、自动注册或管理员审核；用户启停与审批。
- 独立后台、个人资料与偏好页；OIDC SSO、Google、GitHub、微信网站扫码、QQ 适配，多身份显式绑定与解绑保护。真实平台需部署方配置应用，详见 [身份认证说明](docs/authentication.md)。
- 主页文档列表、知识库目录树、标题搜索与类型筛选。
- 私有/本站登录可见/公开阅读、邀请角色、知识库内权限继承与独立设置、所有权转移。
- 移动、独立副本、回收站及批次恢复。
- 全文评论/回复、点赞收藏、通知列表及已读。
- React 前端、Fastify 后端、Kysely 直接建表与 SQLite/PostgreSQL 驱动。
- 飞书式工作台：全局弹框搜索，主页四个 Tab 只列文档，独立知识库目录页；个人资料、头像上传、持久化偏好及管理员聚合统计。
- 统一文件存储：头像、知识库封面、文档附件上传；本地磁盘 / S3 兼容云存储、可选 CloudFront 签名 CDN。管理员管理中心包含统计、用户、登录与注册、文件存储分区。

- 本地打包 Slate 编辑器：富文本、正文图片/附件、Yjs 增量协同、持久化 ACK、快照、重连同步；选区评论在右侧管理。
- WebSocket 复用文档协作、通知失效推送、去重在线人数；所有用户展示统一头像。
- 管理员可配置 Meilisearch；关闭或不可用时回退数据库标题/正文匹配。

表格/幻灯片预留独立类型，编辑器暂未接入。SSO 已实现客户端接入；作为 OIDC 身份源、SAML、Hook、AI、桌面、DSH、云备份仍未实现。编辑器使用上游协同预览包，尚不能将当前版本等同生产认证。详见 [协同与搜索接入说明](docs/collaboration.md)、[存储部署说明](docs/storage.md)。

## 启动

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问 http://127.0.0.1:39130。首次启动会按当前基线创建 `data/v1/doca.db`。没有默认账号，先按 [初始化管理员](docs/development.md) 设置自己的账号密码。

```sh
pnpm check
```

## Docker 部署

生产容器配置见 [compose.yaml](compose.yaml)。先复制 [docker.env.example](docker.env.example) 为 `.env`，填写 HTTPS 域名，再构建并启动：

```sh
cp docker.env.example .env
docker compose up -d --build
```

Doca 对外监听宿主机 `127.0.0.1:39120`，由外部 HTTPS 反向代理转发；代理需要支持 `/api/v1/ws` WebSocket。SQLite 数据库、AI 会话和本地上传文件都保存在 `doca_data` 卷。首次启动后运行 `bash scripts/bootstrap-admin.sh` 创建管理员账号。项目没有默认账号或密码，初始化时由部署者临时输入，凭据不会写入仓库：

```sh
bash scripts/bootstrap-admin.sh
```

初始化成功后，密码只以哈希形式保存在数据库中，无法从容器或后台查看明文。

检查类型、接口集成测试与前端构建。SQLite 与隔离 PostgreSQL 实库均运行完整回归；容量和真实第三方服务联调另行验收。

## 文档

- [整体前后端架构与开发边界](docs/architecture.md)
- [编辑器、协同、内容评论与搜索](docs/collaboration.md)
- [数据库结构](docs/database.md)
- [接口文档](docs/api.md)；运行时请求契约 /api/openapi.json
- [开发、部署和验收](docs/development.md)
- [产品设计基线](docs/product-design.md)

当前版本从全新数据库基线开始，不提供旧数据库迁移兼容。
