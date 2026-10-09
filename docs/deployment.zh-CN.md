# 部署 Doca

[English](deployment.md)

一台服务器可以运行已发布镜像 `docker.io/smartdoca/doca:0.1.13`。单个容器使用 SQLite，不需要 PostgreSQL 或 Redis。只有运行多个应用副本时才需要它们。见 [单实例与水平扩展部署](horizontal-scaling.zh-CN.md)。

## 条件

- Docker Engine 和 Docker Compose 插件。
- 公开站点的域名和 TLS 证书。
- 与容器在同一台机器上的反向代理。Compose 只把 Doca 发布在 `127.0.0.1:39120`。

代理需要转发 HTTP，以及 WebSocket 路径 `/api/v1/ws`。保留原始 `Host` 头。

## 文件

在服务器上使用本仓库的检出。镜像里没有 `scripts/bootstrap-admin.sh` 和 `scripts/reset-admin-password.sh`。这两个脚本留在宿主机上，用来启动一次性容器。

```sh
cp docker.env.example .env
```

第一次启动前先修改 `.env`。

## 必填配置

文件存储还需要 `DOCA_FILE_STORE_ID` 和 `DOCA_FILE_STORES_JSON`，示例见 `docker.env.example`。后端路径和密钥通过环境变量提供，管理页只读展示。见[文件存储](storage.zh-CN.md)。

0.1.13 使用新数据库基线 `doca-2026-10-08-knowledge-books-v2`，拒绝 0.1.12 及更早版本的数据库，不提供自动迁移、转换或重置。保留原部署、数据库、文件和配置；新版本使用独立空数据库与独立存储。回滚使用旧代码及未改动的旧数据库，新版产生的数据同样保留。见[发行要求](releases/0.1.13.zh-CN.md)。

`DOCA_ORIGIN` 是用户在浏览器里打开的地址。生产环境拒绝不是 HTTPS 的值。不要加子路径、查询参数或片段；根路径末尾斜杠会被规范化。

```text
DOCA_ORIGIN=https://docs.example.com
```

Docker 示例已经提供必填存储值；首次单机部署修改来源即可，PostgreSQL、Redis 和插件凭证密钥是条件配置。默认值、S3 必填字段及独立 Webhook/AI 存储见[配置说明](configuration.zh-CN.md)。

## 启动

```sh
docker compose pull
docker compose up -d
```

`docker compose up -d` 会拉取 `docker.io/smartdoca/doca:0.1.13`。只有要从当前检出构建镜像时才加 `--build`。

检查容器：

```sh
docker compose ps
curl -fsS -H 'Host: docs.example.com' http://127.0.0.1:39120/health
```

将 `docs.example.com` 替换为配置来源的主机名，非标准端口也需带上。镜像内置探针已经携带正确 Host，等待 `docker compose ps` 显示 `healthy`。直接以回环地址 curl 会返回 421。

健康的进程返回 `{"status":"ok","version":"0.1.13"}`。

文档渲染还需实际部署检查：当前检出新增 LibreOffice 和启用沙箱的 Chromium，可选 SAM 另需可信 Linux 运行环境。组件边界、内置 Chromium seccomp 策略和显式 SAM 挂载见 [Docker 文档渲染器](docker-rendering.zh-CN.md)，服务健康不代表这些工具已经可用。

SQLite、上传文件和 AI 数据库保存在 `doca_data` 卷。首次启动时数据库必须是空的。非空且结构不是当前基线的数据库会被拒绝。不要删除已经有用户的数据库。

## 反向代理

在同一台机器上用 Caddy 或 Nginx 终止 TLS，并转发到 `127.0.0.1:39120`。

```caddyfile
docs.example.com {
	reverse_proxy 127.0.0.1:39120
}
```

Caddy 默认代理 WebSocket 升级。Nginx 需要在 `/api/v1/ws` 上设置 `Upgrade` 和 `Connection` 头。

`DOCA_TRUST_PROXY` 默认空值，不信任任何转发头，回环连接也不例外。需要审计和限流识别真实客户端 IP 时，只配置应用实际看到的代理 IP/CIDR。Docker 桥接可能让宿主机代理表现为桥接网关，而非 `127.0.0.1`，应先核对网络。未配置时代理后的用户可能共享代理 IP 的限流额度。

如果另一台机器上的负载均衡器连到这台主机，把容器端口发布到内网接口，而不是只绑定回环地址，并把 `DOCA_TRUST_PROXY` 设为该负载均衡器的 IP 段。不要信任整个公网。

## 创建管理员

没有默认账号或密码。容器健康之后，在存放 `compose.yaml` 的目录执行：

```sh
bash scripts/bootstrap-admin.sh
```

脚本会询问账号和密码。密码至少 12 位。它只传给这一次容器命令。数据库保存哈希。已经有管理员时，命令会停止，不会修改当前密码。

## 修改密码

已登录用户打开 `#/account`，选择「修改密码」。新密码至少 12 位。保存后，该账号的全部会话都会退出。

管理员无法登录时，在部署目录重置已有账号：

```sh
bash scripts/reset-admin-password.sh
```

这不会创建账号，也不能通过 HTTP 调用。如果数据库文件被锁住，先执行 `docker compose stop`，重置密码，再执行 `docker compose up -d`。不要把账号或密码写进 `.env`。

## 静态资源

HTML 页面和接口留在 `DOCA_ORIGIN`。`DOCA_ASSET_BASE` 只改写这份 HTML 里的 `/assets/...` 地址。

留空时，JavaScript、CSS 和其他构建文件由容器从 `/assets` 提供。填写时使用没有账号信息、查询参数、哈希或末尾斜杠的 HTTPS 前缀：

```text
DOCA_ASSET_BASE=https://cdn.example.com/doca/0.1.11
```

页面里原来的 `/assets/index-abc.js` 会变成：

```text
https://cdn.example.com/doca/0.1.11/assets/index-abc.js
```

把整个 `apps/web/dist/assets` 目录发布到这个前缀下，并保留 `assets` 这一层。文件名包含内容哈希，必须和同一个镜像里的 HTML 一致。接口请求仍发往 `DOCA_ORIGIN`。

正式标签 `v1.2.3` 会构建网页，并把 `doca-web-assets-v1.2.3.tar.gz` 附到 GitHub Release。解压后保留 `assets` 目录，放到会为 ES module 发送跨源响应头的 CDN 上。不要把 `github.com/.../releases/download` 当作 `DOCA_ASSET_BASE`。推送到 `main`，或 `v1.2.3-rc.1` 这类预发布标签，不会创建这个 Release。

容器仍保留自己的 `/assets` 文件。样式表里用根路径引用的字体和图片继续从 Doca 加载。

`index.html` 使用 `Cache-Control: no-cache`，发版后重新打开会拿到新页面。`/assets/` 下带哈希的文件使用 `Cache-Control: public, max-age=31536000, immutable`，缓存一年。内容变化时文件名会变，所以拿到新 HTML 之后不会继续用旧脚本。`DOCA_ASSET_BASE` 前面的 CDN 也要对这些带哈希的文件使用同样的长期缓存。

本版宿主 0.1.11 / SDK 0.1.9 提供托管插件凭证，仅安装要求凭证服务的插件时才需设置 `DOCA_CREDENTIAL_MASTER_KEY`，核心启动不需要该项；credentials-v2 数据库基线拒绝 0.1.9 和更早的库，不自动迁移，保留原部署和数据并使用新空数据库。Compose 转发数据库与云存储环境变量，见 [配置示例](../docker.env.example)、[凭证部署说明](plugin-credentials.md)和[发行说明](releases/0.1.11.zh-CN.md)。
