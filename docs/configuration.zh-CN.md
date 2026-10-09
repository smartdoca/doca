# 配置说明

[English](configuration.md)

Compose 使用 `docker.env.example`，源码开发使用 `.env.example`，复制到仓库根目录 `.env`。两份示例的来源地址和数据库路径不同；文件存储均示例为容器持久数据卷中的 `/data/storage`。源码开发时把存储 root 改为本机可写的绝对路径，不要混用来源地址，也不要提交密钥。

## Compose 必填配置

| 变量 | 要求 | 单机示例 |
| --- | --- | --- |
| `DOCA_ORIGIN` | 必须显式填写 HTTP(S) 来源 | `https://doca.example.com` |
| `DOCA_FILE_STORE_ID` | 非空，且必须对应 JSON 中的存储项 | `local` |
| `DOCA_FILE_STORES_JSON` | 非空，合法的 version 1 物理存储配置 | 见下方 |
| `DOCA_CREDENTIAL_MASTER_KEY` | 每次启动必填；严格 64 个十六进制字符（32 字节） | 用 `openssl rand -hex 32` 生成 |

```dotenv
DOCA_ORIGIN=https://doca.example.com
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

首次单机安装时，**修改公网来源地址，并用 `openssl rand -hex 32` 的输出替换公开的示例凭证密钥**；必填存储值已经提供。PostgreSQL、Redis、模型密钥和 SSO 凭据按需配置。已有部署必须保留原凭证主密钥。

来源必须为 HTTP(S) origin，不能带账号密码、子路径、查询参数或片段；根路径末尾斜杠会被规范化。生产环境同时支持 HTTP 和 HTTPS。代理须保留配置的 `Host`，只按 `127.0.0.1` 地址访问会被 Host 校验拒绝，见[健康检查](deployment.zh-CN.md#启动)。

## 不同启动方式的默认值

| 启动方式 | 来源地址 | 数据库与文件 | 凭证主密钥 |
| --- | --- | --- | --- |
| 仓库 Compose | `.env` 必填 | SQLite `/data/doca.db`；文件 ID/JSON 在 `.env` 必填；`doca_data` 挂载到 `/data` | 必填，使用持久部署密钥 |
| 单独运行发布镜像 | 须提供 HTTP(S) 来源 | 镜像显式提供 `/data` 下的 SQLite 与本地存储默认值；自行挂载持久 `/data` | 必填，使用持久部署密钥 |
| 源码开发 | `http://127.0.0.1:39130` | SQLite `./data/v1/doca.db`；文件 ID/JSON 必填，`.env.example` 已提供 | 必填，替换公开示例值 |

源码存储解析器没有隐式默认值，镜像的默认值来自 Dockerfile 的显式环境配置。本地存储根目录必须可写且持久化。S3 必填 `bucket`、`region`、布尔值 `forcePathStyle` 和显式 `credentials:{accessKeyId,secretAccessKey,sessionToken?}`；可选 endpoint 必须为 HTTP(S) 根来源，不带账号密码、子路径、查询参数或片段。显式 HTTP 端点支持 RustFS 等可信内网对象存储，网络访问由部署者控制，站点、静态资源和 CDN 地址也支持 HTTP(S)。AWS shell 环境凭据不能代替这些 JSON 字段，RustFS 配置示例见[文件存储](storage.zh-CN.md)。

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
| `DOCA_PLUGINS_DIR` | 可写的安装与缓存目录；Compose 默认 `/data/plugins` |
| `DOCA_PDF_CHROMIUM` | 富文本/Markdown PDF 导出的可选 Chromium 路径；不设置时须安装匹配的 Playwright 浏览器，沙箱保持启用 |
| `DOCA_PLUGIN_STORE_URL` | HTTP(S) 来源，默认 `https://store.smartdoca.cc` |
| `DOCA_PLUGIN_NPM_REGISTRY` | 预构建包的注册表，默认 `https://registry.npmjs.org` |
| `DOCA_ASSET_BASE` | 可选的构建资源前缀；空值由 Doca 提供 `/assets` |
| `DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE` | 每来源页已提交的付费图片请求上限；未设置时默认 5。只接受十进制正安全整数，0、空字符串或非法值会导致启动失败 |
| `DOCA_AI_IMAGE_SEGMENT_PROFILE` | 可选的可信本地 SAM2 严格 version 1 profile 绝对路径；未设置时关闭分割。显式配置无效会拒绝启动，已校验运行环境不可用时不开放工具；见[本地分割](ai-image-segmentation.md) |

图片请求上限在服务启动时固定。例如在源码或 Compose 的 `.env` 设置 `DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE=10`，重启服务或重建容器后生效；所有副本须使用相同上限。重试、续跑、修改提示词或重新登记批次都不会清零累计次数，已提交但结果或费用待核对的请求也计数，原样导出和本地重合成不计数。原图片、请求记录与费用事实保持不变。降低上限后，后续付费请求以及序号超过新上限的付费回执复用会明确拒绝，不跳过、转换或删除原记录。批次 version 3 和 paid-attempt version 1 保持不变；旧批次格式仍拒绝，不迁移。

缺失、空值或格式错误的主密钥均拒绝启动，即使没有安装插件也一样。运行时没有默认密钥；首次安装必须替换 example 中公开的示例值。用 `openssl rand -hex 32` 生成一次并独立备份，各实例和重启必须使用同一密钥，见[托管凭证](plugin-credentials.zh-CN.md)。

Webhook 投递始终使用独立数据库。SQLite 在主库旁创建 `webhooks.db`。PostgreSQL 默认使用 `<主库名>_webhooks`，缺少该库时尝试创建；账号没有建库权限时，须预建独立库并授权，或设置 `DOCA_WEBHOOK_DATABASE_URL` 指向有权限的独立库。AI 存储在 Compose 中使用 `ai.db`，PostgreSQL 使用主库的 `doca_ai` schema，账号须有初始化权限。即使未配置外部模型，这些存储也需备份。

多副本需要共享 PostgreSQL、Redis 和文件存储；修改变量不搬运已有数据，见[水平扩展](horizontal-scaling.zh-CN.md)与[发行要求](releases/0.1.10.zh-CN.md)。

## Compose 环境变量传递

`.env` 用于 Compose 插值，不会自动把每个变量传入容器。只有 `compose.yaml` 中声明的项生效；容器监听地址、端口和 SQLite/AI/数据目录在当前文件中固定。需要改这些项时同时调整 Compose 的 environment、端口映射与持久挂载。

扩展环境变量需在 Compose 服务的 environment 中显式传递，并在部署目录的 `.env` 设置。

## 管理配置与生效

注册、身份源、验证网关、搜索、AI 模型和 Webhook 订阅通过对应管理页配置。文件后端凭据位于环境，存储管理页只读；平台服务凭据与插件加密凭证是不同服务，见[服务凭据](service-credentials.zh-CN.md)。

`docker compose config --quiet` 检查变量插值且不打印已解析密钥；不会校验应用 JSON、连接数据库或确认云凭据有效。通过 `docker compose up -d` 应用后，检查日志和健康状态，再实际验证已配置服务，见[部署](deployment.zh-CN.md)和[开发](development.zh-CN.md)。

## 登录有效期

`DOCA_SESSION_TTL_SECONDS` 配置浏览器、扫码登录和 WebView 会话，同时控制数据库到期时间和登录 Cookie 的 `Max-Age`，默认 `86400` 秒（24 小时）。`DOCA_MOBILE_SESSION_TTL_SECONDS` 配置手机 Bearer 会话及既有续期流程，默认 `15552000` 秒（180 天）。两项均接受 1 到 2147483647 的十进制整数；空值、0、负数或非法值拒绝启动。Compose 显式传入这两个变量。

```dotenv
DOCA_SESSION_TTL_SECONDS=86400
DOCA_MOBILE_SESSION_TTL_SECONDS=15552000
```

修改后重启服务。已签发的浏览器会话保留数据库中原有到期时间，新登录使用新期限，手机续期使用配置的手机期限；不转换会话记录或持久格式。登录和认证流程 Cookie 在 HTTPS 下加 `Secure`，HTTP 下保留 `HttpOnly` 和原有 SameSite 规则。HTTP 站点实时连接使用 `ws`。

经明确同意的 HTTP 浏览器适配在 `crypto.randomUUID` 缺失时通过 `crypto.getRandomValues` 提供 UUID v4；在 `crypto.subtle` 缺失时通过固定版本的 `@noble/hashes` 仅提供 SHA-256 `digest`。存在原生实现时继续使用原生接口；摘要与原生字节一致，不转换已有 ID、表格校验值或文档格式，也不提供其他 WebCrypto 加密操作。

文本复制按钮使用同一个共享入口。原生 Clipboard 可用时直接调用；缺失时经已同意的 HTTP 适配，通过临时文本框和 `document.execCommand("copy")` 复制，恢复焦点和选区，并明确报告失败；不读取系统剪贴板，也不将失败当作成功。
