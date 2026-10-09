# 快速开始

[English](quickstart.md)

本指南使用已发布的 Docker 镜像，在一台服务器上安装 Doca 0.1.10，数据库采用 SQLite，文件存储采用本地目录。需要 Git、Docker Engine、Docker Compose 插件，以及指向服务器的域名。同机反向代理可以提供 HTTPS，可信内网也支持 HTTP。运行镜像不需要安装 Node.js 或 pnpm。

这是全新安装流程。已有部署请先阅读[发行要求](releases/0.1.10.zh-CN.md)：本版拒绝旧数据库基线，不提供自动迁移。保留已有数据库、文件和配置。

## 1. 拉取代码

检出与镜像一致的版本，确保 Compose 和管理员脚本与发行版本匹配：

```sh
git clone --branch v0.1.10 --depth 1 https://github.com/smartdoca/doca.git
cd doca
```

## 2. 配置 .env

```sh
cp docker.env.example .env
```

编辑 `.env`，把示例域名改成自己的 HTTP(S) 站点地址：

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

站点地址不要带子路径、查询参数或片段；根路径末尾斜杠会被规范化。保留容器持久卷中的 `/data/storage` 路径。`docker.env.example` 用于 Docker 部署；`.env.example` 用于[源码开发](development.zh-CN.md)。

在同一台服务器配置反向代理。以 Caddy 为例：

```caddyfile
doca.example.com {
    reverse_proxy 127.0.0.1:39120
}
```

Caddy 终止 TLS，并转发 HTTP 和 WebSocket。域名解析需指向这台服务器，代理需能够获取证书。使用其他代理时，保留 `Host` 头，并转发 `/api/v1/ws` 的 WebSocket 升级请求。详见[部署说明](deployment.zh-CN.md)。

## 3. 拉取镜像

```sh
docker compose pull
```

Compose 使用 `docker.io/smartdoca/doca:0.1.10`。这一步下载已构建镜像，不构建检出的源码。

## 4. 启动

```sh
docker compose up -d
docker compose ps
```

等待容器健康，健康检查应返回：

```json
{"status":"ok","version":"0.1.10"}
```

启动失败时，用 `docker compose logs --tail=100 doca` 查看日志。Compose 端口绑定在 `127.0.0.1`，浏览器通过反向代理访问配置的 HTTP(S) 地址。

## 5. 初始化管理员密码

在存放 `compose.yaml` 的同一目录执行：

```sh
bash scripts/bootstrap-admin.sh
```

依次输入管理员账号、至少 12 位的密码，并再次确认密码。当前脚本使用中文提示，密码输入不显示。Doca 没有默认账号或密码。脚本启动一次性容器，连接同一个数据库，数据库只保存密码哈希。已有管理员时，初始化会停止，不修改该账号。

打开 `https://doca.example.com` 并登录。不要把管理员账号或密码写入 `.env`。恢复已有管理员账号请使用[密码重置](deployment.zh-CN.md#修改密码)。

## 后续配置

- 按[使用指南](user-guide.zh-CN.md)创建文档和知识库。
- 开放注册或接入 SSO 前，阅读[身份认证](authentication.zh-CN.md)。
- 修改存储或准备备份前，阅读[配置说明](configuration.zh-CN.md)、[文件存储](storage.zh-CN.md)和[部署运维](deployment.zh-CN.md)。
- 只有部署多个副本时，才需要[水平扩展](horizontal-scaling.zh-CN.md)。

SQLite、上传文件、插件和 AI 数据库使用 `doca_data` 卷。重启时保留它，备份应覆盖全部数据库、被引用的文件存储和受保护的配置。`docker compose down -v` 会删除该卷，不用于普通重启或升级。
