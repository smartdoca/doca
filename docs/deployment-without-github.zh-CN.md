# 无需访问 GitHub 的部署

[English](deployment-without-github.md)

业务服务器无需拉取源码，也无需安装 Git、Node.js 或 pnpm。准备好 Docker Engine、Docker Compose 插件、Bash 和 OpenSSL 后，复制部署文件、准备镜像、启动并初始化管理员即可。本指南用于全新单机安装 Doca 0.2.15，采用 SQLite 和本地文件存储；已有部署先阅读[发行要求](releases/0.2.15.zh-CN.md)，保留原数据库、文件、配置和凭证主密钥。

## 1. 转交部署文件

由能访问仓库的一方，在与镜像一致的发行版检出中执行：

```sh
node scripts/pack-deployment.mjs
```

把生成的 `doca-deploy-v0.2.15.tar.gz` 和同名 `.sha256` 校验文件，通过企业文件服务、内网下载地址或移动存储转交给业务方。打包只读取公开部署文件，不包含本机 `.env`、用户数据或镜像。正式标签的 Release 工作流也会附上部署包和校验文件；这项工作流变更需要随新标签发布，已有 Release 不会自动补包。

在业务服务器上将两个文件放到同一目录，校验并解压：

```sh
sha256sum -c doca-deploy-v0.2.15.tar.gz.sha256
tar -xzf doca-deploy-v0.2.15.tar.gz
cd doca-deploy-v0.2.15
```

macOS 校验可用 `shasum -a 256 -c doca-deploy-v0.2.15.tar.gz.sha256`。部署目录如下，后续命令均在此目录执行：

```text
doca-deploy-v0.2.15/
  compose.yaml
  docker.env.example
  README.zh-CN.md
  README.md
  LICENSE
  docker/
    chromium-seccomp.json
    chromium-seccomp.md
    chromium-seccomp.LICENSE
  scripts/
    bootstrap-admin.sh
    reset-admin-password.sh
```

部署包中的 Compose 从该版本仓库文件生成，保留环境变量、持久卷和 Chromium 安全设置，去除源码构建项，并使用 `pull_policy: missing`，已加载镜像时无需访问镜像仓库。不能只拷贝 `compose.yaml` 和 `.env`：必须同时提供上述 `docker/` 和 `scripts/` 文件，且保持相对路径。seccomp 策略必须原样转交，不要关闭 Chromium 沙箱；宿主机内核还需允许用户命名空间。

### 手动复制 Compose 和 .env

如果通过文字交付，可将以下单机配置保存为 `compose.yaml`，并由交付方另外提供同版本的 `docker/` 和 `scripts/` 文件。部署包提供更完整的可选配置；下面的配置只使用 SQLite 和本地存储。

```yaml
services:
  doca:
    image: docker.io/smartdoca/doca:0.2.15
    pull_policy: missing
    restart: unless-stopped
    init: true
    security_opt:
      - seccomp=./docker/chromium-seccomp.json
    shm_size: "1gb"
    stop_grace_period: 30s
    environment:
      NODE_ENV: production
      DOCA_ORIGIN: "${DOCA_ORIGIN:?Set DOCA_ORIGIN in .env}"
      DOCA_HOST: 0.0.0.0
      DOCA_PORT: "39120"
      DOCA_DATABASE: sqlite
      DOCA_SQLITE_PATH: /data/doca.db
      DOCA_BOOK_BATCH_CHECKPOINTS: "${DOCA_BOOK_BATCH_CHECKPOINTS-on}"
      DOCA_AI_SQLITE_PATH: /data/ai.db
      DOCA_DATA_DIR: /data
      DOCA_FILE_STORE_ID: "${DOCA_FILE_STORE_ID:?Set DOCA_FILE_STORE_ID in .env}"
      DOCA_FILE_STORES_JSON: "${DOCA_FILE_STORES_JSON:?Set DOCA_FILE_STORES_JSON in .env}"
      DOCA_CREDENTIAL_MASTER_KEY: "${DOCA_CREDENTIAL_MASTER_KEY:?Generate and set the key in .env}"
    ports:
      - "127.0.0.1:39120:39120"
    volumes:
      - doca_data:/data

volumes:
  doca_data:
```

保存以下内容为 `.env`，将来源改成实际浏览器地址，并填入下一步生成的主密钥：

```dotenv
DOCA_ORIGIN=https://docs.example.com
DOCA_CREDENTIAL_MASTER_KEY=
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

## 2. 配置与代理

使用部署包时先执行；已经手动创建 `.env` 的跳过复制：

```sh
cp docker.env.example .env
openssl rand -hex 32
chmod 600 .env
```

把生成的 64 位十六进制值写入 `.env` 的 `DOCA_CREDENTIAL_MASTER_KEY`，替换公开示例值；把 `DOCA_ORIGIN` 改成业务方实际访问的 HTTP(S) 来源。主密钥生成一次并单独安全备份，重启时保留同一个值。保留本地存储根目录 `/data/storage`。不要把管理员账号或密码写进 `.env`。

Compose 默认仅绑定 `127.0.0.1:39120`，需要同机反向代理。公网 HTTPS 可配置 Caddy：

```caddyfile
docs.example.com {
    reverse_proxy 127.0.0.1:39120
}
```

域名解析指向服务器，代理需能获取证书，也可使用业务方已有证书。无外网的可信内网可设 `DOCA_ORIGIN=http://doca.internal`，配置内网 DNS 或客户端 hosts，并使用以下 HTTP 代理，不需要申请公网证书：

```caddyfile
http://doca.internal {
    reverse_proxy 127.0.0.1:39120
}
```

使用其他代理时保留 `Host`，转发 HTTP 和 `/api/v1/ws` 的 WebSocket 升级请求。Docker、反向代理及其安装包由业务环境提前提供，部署包不包含它们。

## 3. 准备镜像

### 能访问 Docker Hub

服务器不能访问 GitHub，但能访问 Docker Hub 时直接拉取已构建镜像：

```sh
docker compose pull doca
```

### 镜像仓库也无法访问

由交付方在可拉取镜像的机器上准备镜像文件。先确认业务服务器的 CPU 架构；以下以 Linux x86-64（`linux/amd64`）为例，ARM64 服务器把平台改为 `linux/arm64`，并在交付文件名中相应标明：

```sh
docker pull --platform linux/amd64 docker.io/smartdoca/doca:0.2.15
docker image inspect docker.io/smartdoca/doca:0.2.15 --format '{{.Os}}/{{.Architecture}}'
docker save -o doca-image-v0.2.15-linux-amd64.tar docker.io/smartdoca/doca:0.2.15
sha256sum doca-image-v0.2.15-linux-amd64.tar > doca-image-v0.2.15-linux-amd64.tar.sha256
```

把镜像 `.tar` 和校验文件一起转交。业务方在这两个文件所在目录执行：

```sh
sha256sum -c doca-image-v0.2.15-linux-amd64.tar.sha256
docker load -i doca-image-v0.2.15-linux-amd64.tar
docker image inspect docker.io/smartdoca/doca:0.2.15 --format '{{.Os}}/{{.Architecture}}'
```

确认导入的标签是 `smartdoca/doca:0.2.15`，架构与目标服务器一致，再回到部署目录。内网镜像仓库也是可选交付方式：交付方推送同版本镜像，业务方将 Compose 的 `image` 改为内网镜像完整地址并拉取；部署包、镜像和初始化脚本保持同一版本。

## 4. 启动与数据库初始化

镜像已拉取或加载后，在部署目录执行：

```sh
docker compose config --quiet
docker compose up -d --pull never --no-build
docker compose ps
```

`--pull never --no-build` 明确使用本机镜像；若镜像缺失则报错，不尝试在线下载或源码构建。首次启动会在空的 `doca_data` 持久卷内创建当前版本的数据库表，以及文件和 AI 数据目录，无需手动执行 SQL 或安装数据库。非空旧数据库不会自动升级。

等待 `docker compose ps` 显示 `healthy`。手动健康检查使用 `.env` 来源的 Host；非标准端口也需包含在 Host 中：

```sh
curl -fsS -H 'Host: docs.example.com' http://127.0.0.1:39120/health
```

应返回 `{"status":"ok","version":"0.2.15"}`。内网站点改用 `Host: doca.internal`。裸回环请求会被 Host 校验拒绝。启动失败可运行 `docker compose logs --tail=100 doca` 查看日志。

## 5. 初始化管理员

健康后在同一部署目录执行：

```sh
bash scripts/bootstrap-admin.sh
```

依次输入管理员账号、至少 12 位的密码，并确认密码；密码输入隐藏。脚本使用已准备的镜像启动一次性容器，连接同一持久卷，只在没有管理员时创建账号，数据库只保存密码哈希。没有默认账号或密码。随后打开 `DOCA_ORIGIN` 所设地址登录。

以后需要重置已有管理员密码时执行：

```sh
bash scripts/reset-admin-password.sh
```

这不会创建新账号。若数据库被锁住，先 `docker compose stop`，重置后再 `docker compose up -d --pull never --no-build`。

## 数据保留与后续交付

日常重启使用 `docker compose restart`，保留部署目录和 Compose 项目名，以继续使用同一个 `doca_data` 卷；不要通过改目录或项目名意外启动另一个空站点。备份覆盖持久卷中的全部数据库、文件存储以及受保护的 `.env` 和主密钥。`docker compose down -v` 会删除卷，不用于普通重启或升级。

后续升级先确认[发行要求](releases/0.2.15.zh-CN.md)，交付匹配版本的部署包和镜像；本流程只初始化全新站点，不转换已有数据。基础密码登录和本地文档服务无需 GitHub；AI、外部登录、插件安装及云存储等配置的外部服务仍需业务网络可达。文档导出还需在目标宿主机验证渲染器，应用健康不等于 Chromium 沙箱已可用，见 [Docker 文档渲染器](docker-rendering.zh-CN.md)。
