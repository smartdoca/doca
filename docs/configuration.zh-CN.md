# 配置说明

[English](configuration.md)

Docker 部署从 `docker.env.example` 开始，源码开发从 `.env.example` 开始。把相应示例复制为仓库根目录的 `.env`，Compose 和源码启动程序会读取该文件。不要提交密钥。

## Docker 必填配置

| 变量 | 用途 | 单机示例 |
| --- | --- | --- |
| `DOCA_ORIGIN` | 浏览器访问的精确来源；生产环境必须 HTTPS | `https://doca.example.com` |
| `DOCA_FILE_STORE_ID` | 接收新对象的存储 ID | `local` |
| `DOCA_FILE_STORES_JSON` | version 1 文件存储配置，包含物理位置和凭据 | 见下方 |

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

单引号将 JSON 保留为一个环境变量值。Compose 把 `doca_data` 卷挂载到 `/data`；没有安排其他持久挂载时，不要把持久文件放到该卷之外。对象写入后，存储 ID 和物理位置需保持稳定。详见[文件存储](storage.zh-CN.md)。

## 可选后端

| 变量 | 使用场景 |
| --- | --- |
| `DOCA_DATABASE`、`DOCA_DATABASE_URL` | 选择 PostgreSQL，替代默认 SQLite |
| `DOCA_DATABASE_POOL_MAX` | 每进程最大连接数，默认 10 |
| `DOCA_WEBHOOK_DATABASE_URL` | 显式指定 Webhook 投递的 PostgreSQL 数据库 |
| `DOCA_REDIS_URL`、`DOCA_REDIS_PREFIX`、`DOCA_INSTANCE_ID` | 分布式事件、在线状态和限制 |
| `DOCA_TRUST_PROXY` | 连接来自非回环代理时，配置可信代理 IP/CIDR |
| `DOCA_CREDENTIAL_MASTER_KEY` | 需要 `storage.credentials.v1` 的插件；32 字节，编码为 64 位十六进制 |
| `DOCA_PLUGINS_DIR` | 持久化安装与缓存目录，容器默认 `/data/plugins` |
| `DOCA_PLUGIN_STORE_URL` | 插件商店 HTTPS 来源，默认 `https://store.smartdoca.cc` |
| `DOCA_PLUGIN_NPM_REGISTRY` | 提供完整预构建插件包的公共仓库 |
| `DOCA_ASSET_BASE` | 对应版本 Web 构建资源的可选 HTTPS 前缀 |

生成凭证主密钥时，在本地执行 `openssl rand -hex 32`，将结果放入受保护的部署配置。只生成一次，单独备份，全部副本和重启都使用同一个值。不要每次启动重新生成。详见[托管凭证](plugin-credentials.zh-CN.md)。

多副本需要共享 PostgreSQL、Redis 和文件存储。只修改 `DOCA_DATABASE` 不会转移已有数据库。请阅读[水平扩展](horizontal-scaling.zh-CN.md)及[当前发行要求](releases/0.1.10.zh-CN.md)。

## 管理员配置

管理员在相应管理页面配置注册、身份源、验证码网关、文档搜索、AI 模型和 Webhook 订阅。文件后端凭据属于环境配置，存储页面只读。平台服务凭据与插件托管加密凭证使用不同的接口和存储职责，详见[服务凭据](service-credentials.zh-CN.md)。

## 应用变更

检查 `.env` 时不要把密钥写入日志。`docker compose config --quiet` 可校验 Compose 配置而不输出解析后的环境变量。执行 `docker compose up -d` 应用变更；它可能重建应用容器，不复制或迁移存储数据。

[部署说明](deployment.zh-CN.md)介绍 TLS、管理员恢复、备份和发版变更；[开发环境](development.zh-CN.md)介绍本地端口和源码专用配置。
