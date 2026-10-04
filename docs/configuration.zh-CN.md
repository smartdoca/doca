# 配置说明

[English](configuration.md)

Compose 使用 `docker.env.example`，源码开发使用 `.env.example`，复制到仓库根目录 `.env`。两份示例的来源地址和物理路径不同，不要混用，也不要提交密钥。

## Compose 必填配置

| 变量 | 要求 | 单机示例 |
| --- | --- | --- |
| `DOCA_ORIGIN` | 必须显式填写，生产环境必须 HTTPS | `https://doca.example.com` |
| `DOCA_FILE_STORE_ID` | 非空，且必须对应 JSON 中的存储项 | `local` |
| `DOCA_FILE_STORES_JSON` | 非空，合法的 version 1 物理存储配置 | 见下方 |

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

首次单机安装时，**Docker 示例中只需要修改公网来源地址**，另外两项必填值已经提供。核心启动不需要 PostgreSQL、Redis、模型密钥、SSO 凭据或插件凭证主密钥；启用相应功能时再配置。

来源必须为 HTTP(S) origin，不能带账号密码、子路径、查询参数或片段；根路径末尾斜杠会被规范化。生产环境拒绝 HTTP。代理须保留配置的 `Host`，只按 `127.0.0.1` 地址访问会被 Host 校验拒绝，见[健康检查](deployment.zh-CN.md#启动)。

## 不同启动方式的默认值

| 启动方式 | 来源地址 | 数据库与文件 | 凭证主密钥 |
| --- | --- | --- | --- |
| 仓库 Compose | `.env` 必填 | SQLite `/data/doca.db`；文件 ID/JSON 在 `.env` 必填；`doca_data` 挂载到 `/data` | 空值可以启动核心 |
| 单独运行发布镜像 | 须提供 HTTPS 来源 | 镜像显式提供 `/data` 下的 SQLite 与本地存储默认值；自行挂载持久 `/data` | 需要凭证的插件才必填 |
| 源码开发 | `http://127.0.0.1:39130` | SQLite `./data/v1/doca.db`；文件 ID/JSON 必填，`.env.example` 已提供 | 可选 |

源码存储解析器没有隐式默认值，镜像的默认值来自 Dockerfile 的显式环境配置。本地存储根目录必须可写且持久化。S3 必填 `bucket`、`region`、布尔值 `forcePathStyle` 和显式 `credentials:{accessKeyId,secretAccessKey,sessionToken?}`；可选 endpoint 必须为 HTTPS 根来源。AWS shell 环境凭据不能代替这些 JSON 字段，见[文件存储](storage.zh-CN.md)。

写入对象后，存储 ID 和物理位置必须持续可用。当前存储 ID 必须与已记录的启用 ID 一致；修改 ID、路径或桶不会搬运数据，不能用这些配置变更绕过迁移。

## 条件必填与可选后端

| 变量 | 使用条件与默认值 |
| --- | --- |
| `DOCA_DATABASE=postgres`、`DOCA_DATABASE_URL` | 选择 PostgreSQL 时连接 URL 必填；默认 SQLite |
| `DOCA_DATABASE_POOL_MAX` | 每进程主数据库连接数，默认 10 |
| `DOCA_WEBHOOK_DATABASE_URL` | 可选的独立 PostgreSQL 投递库；未填写时按下方规则生成 |
| `DOCA_REDIS_URL` | 跨实例事件、在线状态、限流需要；空值使用进程内实现 |
| `DOCA_REDIS_PREFIX`、`DOCA_INSTANCE_ID` | 前缀默认 `doca`；实例 ID 默认每进程随机生成 |
| `DOCA_TRUST_PROXY` | 逗号分隔的可信代理 IP/CIDR；**默认不信任任何代理，回环地址也不例外** |
| `DOCA_CREDENTIAL_MASTER_KEY` | 仅要求 `storage.credentials.v1` 的插件必填；严格 64 位十六进制（32 字节） |
| `DOCA_PLUGINS_DIR` | 可写的安装与缓存目录；Compose 默认 `/data/plugins` |
| `DOCA_PLUGIN_STORE_URL` | HTTPS 来源，默认 `https://store.smartdoca.cc` |
| `DOCA_PLUGIN_NPM_REGISTRY` | 预构建包的注册表，默认 `https://registry.npmjs.org` |
| `DOCA_ASSET_BASE` | 可选的构建资源前缀；空值由 Doca 提供 `/assets` |

没有主密钥时核心可以启动，凭证服务不注册，声明为必需注入的插件无法启用。填写格式错误的密钥会导致启动失败。用 `openssl rand -hex 32` 生成一次并独立备份，各实例和重启必须使用同一密钥，见[托管凭证](plugin-credentials.zh-CN.md)。

Webhook 投递始终使用独立数据库。SQLite 在主库旁创建 `webhooks.db`。PostgreSQL 默认使用 `<主库名>_webhooks`，缺少该库时尝试创建；账号没有建库权限时，须预建独立库并授权，或设置 `DOCA_WEBHOOK_DATABASE_URL` 指向有权限的独立库。AI 存储在 Compose 中使用 `ai.db`，PostgreSQL 使用主库的 `doca_ai` schema，账号须有初始化权限。即使未配置外部模型，这些存储也需备份。

多副本需要共享 PostgreSQL、Redis 和文件存储；修改变量不搬运已有数据，见[水平扩展](horizontal-scaling.zh-CN.md)与[发行要求](releases/0.1.10.zh-CN.md)。

## Compose 环境变量传递

`.env` 用于 Compose 插值，不会自动把每个变量传入容器。只有 `compose.yaml` 中声明的项生效；容器监听地址、端口和 SQLite/AI/数据目录在当前文件中固定。需要改这些项时同时调整 Compose 的 environment、端口映射与持久挂载。

例如跨站嵌入问答页面的 `DOCA_KNOWLEDGE_EMBED_ORIGINS` 已由宿主支持，但 0.1.10 Compose 尚未传递。需在部署目录创建 `compose.override.yaml`：

```yaml
services:
  doca:
    environment:
      DOCA_KNOWLEDGE_EMBED_ORIGINS: "${DOCA_KNOWLEDGE_EMBED_ORIGINS:-}"
```

再在 `.env` 设置逗号分隔的完整来源，例如 `DOCA_KNOWLEDGE_EMBED_ORIGINS=https://portal.example.com`，执行 `docker compose up -d`。默认仅允许同源嵌入；普通页面仍禁止 iframe。仅配置可信嵌入来源，授权与机器人渠道设置仍独立校验。

## 管理配置与生效

注册、身份源、验证网关、搜索、AI 模型和 Webhook 订阅通过对应管理页配置。文件后端凭据位于环境，存储管理页只读；平台服务凭据与插件加密凭证是不同服务，见[服务凭据](service-credentials.zh-CN.md)。

`docker compose config --quiet` 检查变量插值且不打印已解析密钥；不会校验应用 JSON、连接数据库或确认云凭据有效。通过 `docker compose up -d` 应用后，检查日志和健康状态，再实际验证已配置服务，见[部署](deployment.zh-CN.md)和[开发](development.zh-CN.md)。
