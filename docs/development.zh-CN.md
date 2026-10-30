# 开发、部署与验收

[English](development.md)

## 开发启动

Node.js 22.12+或24 LTS、pnpm 11.25.0。版本锁定pnpm-lock.yaml；better-sqlite3原生构建已在pnpm-workspace.yaml允许。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# 将 .env 中的存储 root 改为本机可写的绝对路径。
pnpm dev
```

入口 http://127.0.0.1:39130，API监听39120，通过前端同源代理访问。直接访问39120或用localhost替换127.0.0.1会与配置不符。

启动前复制 `.env.example`，文件存储变量为必填；示例的存储 root 为 Docker 使用的 `/data/storage`，源码运行前须改为本机可写的绝对路径。本地 origin 和 SQLite 路径按示例使用，不提交凭证。

`DOCA_CREDENTIAL_MASTER_KEY` 同样必填，即使开发时没有安装插件。首次使用空数据库时，用 `openssl rand -hex 32` 的输出替换公开示例值。重启保留同一个密钥，并单独备份；已有数据库必须继续使用原密钥。

## 源码环境的 PDF 渲染

富文本和 Markdown 的 PDF 导出使用独立 Python 进程中的 WeasyPrint 70.0。安装 Python 3.10+、Pango 和固定依赖：

```sh
python3 -m venv .local/pdf-renderer
.local/pdf-renderer/bin/pip install -r docker/pdf-requirements.txt
export DOCA_PDF_PYTHON="$PWD/.local/pdf-renderer/bin/python"
```

macOS 用 `brew install pango` 安装系统库；若无法找到动态库，可将 `DYLD_FALLBACK_LIBRARY_PATH` 设为 `$(brew --prefix)/lib`。Debian/Ubuntu 需要 `python3-venv`、`libpango-1.0-0`、`libpangoft2-1.0-0`、`libharfbuzz-subset0`；Dockerfile 已安装这些依赖。旧 `DOCA_PDF_CHROMIUM` 会被明确拒绝，启动前删除该配置，不回退浏览器。

AI 画板图片复用已安装 Canvas SDK 的 SVG 导出，在隔离 Node DOM 中用原生 Canvas 测量文字，再用 resvg 与随包中文字体生成 PNG。依赖变化后运行 `pnpm build:canvas-render`。PDF 读取/导入继续使用 PDF.js，Office 转换继续使用 LibreOffice。

`playwright-core` 仅用于开发验收。运行 `pnpm exec playwright-core install chromium`，或为 `scripts/qa-document-pdf.mts` 设置 `DOCA_QA_BROWSER`。该脚本执行隔离导出、重导入与视觉回归，产物默认写入 `artifacts/verification/document-pdf/`，可用 `DOCA_QA_OUTPUT` 指定 `artifacts/` 下的其他目录，不打开用户文档。见[文件交换约定](editor-file-exchange-contract.zh-CN.md#按在线样式导出-pdf-与可编辑导入)。

## 初始化管理员

没有默认账号密码。本地开发环境首次初始化时，在项目目录运行：

```sh
bash scripts/bootstrap-admin-local.sh
```

脚本只在当前终端临时传递管理员账号和密码给初始化命令，数据库中只保存密码哈希。

容器部署见 [部署 Doca](deployment.zh-CN.md)。其中包含反向代理、`DOCA_ORIGIN`、管理员初始化和重置密码。

## 忘记管理员密码

如果管理员仍绑定了已验证的手机或邮箱，可在登录页使用验证码找回。若这些方式均不可用，使用部署机器上的本地运维恢复命令；它只接受已有管理员账号，不会创建新管理员，也不会通过 HTTP 暴露：

```zsh
read "DOCA_RESET_ADMIN_LOGIN?管理员账号: "
read -s "DOCA_RESET_ADMIN_PASSWORD?新密码（至少12位）: "
export DOCA_RESET_ADMIN_LOGIN DOCA_RESET_ADMIN_PASSWORD
pnpm admin:reset-password
unset DOCA_RESET_ADMIN_LOGIN DOCA_RESET_ADMIN_PASSWORD
```

命令会校验账号确实是启用中的管理员，更新密码并撤销该账号的全部会话；密码只以哈希形式写入数据库。PostgreSQL 部署需要在同一环境中提供已有的 `DOCA_DATABASE_URL`，SQLite 则使用当前 `DOCA_SQLITE_PATH`。不要把恢复凭证写入 `.env`、shell 历史或容器镜像。

## 配置

| 变量              | 默认                   | 用途                                |
| ----------------- | ---------------------- | ----------------------------------- |
| DOCA_ORIGIN       | http://127.0.0.1:39130 | 唯一浏览器源；生产支持 HTTP(S)       |
| DOCA_HOST         | 127.0.0.1              | 监听地址                            |
| DOCA_PORT         | 39120                  | API/发布服务端口                    |
| DOCA_WEB_PORT     | 39130                  | 开发前端端口                        |
| DOCA_DATABASE     | sqlite                 | sqlite/postgres                     |
| DOCA_SQLITE_PATH  | ./data/v1/doca.db      | 配置的 SQLite 数据库路径            |
| DOCA_DATABASE_URL | 无                     | 配置的 PostgreSQL 数据库连接串      |
| DOCA_BOOK_BATCH_CHECKPOINTS | on | 仅 on/off；off 停用批次恢复并保留检查点记录及对象 |
| NODE_ENV          | 未设置                 | production 提供构建产物并禁止 dev |
| DOCA_ASSET_BASE   | 空                     | 构建资源的 HTTP(S) 前缀；空则从本机 `/assets` 提供 |

## 静态资源地址

生产页面的 HTML 始终由 Doca 返回，接口也使用页面所在的源。`DOCA_ASSET_BASE` 只改写 HTML 里的 `/assets/...` 地址。

不设置时，JS、CSS 和其他构建文件由容器从 `/assets` 读取。设置时，HTML 中的这些地址改为该前缀，例如 `https://cdn.example.com/doca/0.1.10/assets/index-abc.js`。前缀必须是没有账号、查询参数或哈希的 HTTP(S) URL；公网部署使用 HTTPS，可信内网可使用 HTTP。容器里的 `/assets` 仍然保留，样式表内部以根路径引用的字体和图片会继续回到 Doca。

推送正式版本标签 `v1.2.3` 时，GitHub Actions 会构建网页并创建 Release，附件是 `doca-web-assets-v1.2.3.tar.gz`。解压后保留其中的 `assets` 目录，再把包含该目录的 HTTP(S) 前缀写入 `DOCA_ASSET_BASE`。`v1.2.3-rc.1` 这类预发布标签不会创建 Release。推送到 `main` 也不会。浏览器不要直接使用 `github.com/.../releases/download` 作为 `DOCA_ASSET_BASE`：下载地址会跳转，也不为 ES module 提供跨源响应头。把解压出的 `assets` 目录放到允许跨源读取脚本的 CDN 或对象存储上。

## 发布模式

```sh
pnpm check
NODE_ENV=production DOCA_ORIGIN=https://docs.example.com pnpm start
```

check执行类型检查、测试和前端构建；start服务构建产物与API，不启动Vite。示例域名需替换并配置TLS反代，保留原Host/Origin，转发DOCA_PORT。

后端默认不信任任何 X-Forwarded-*，回环地址也不例外；`DOCA_TRUST_PROXY` 仅填写实际代理 IP/CIDR。当前认证按连接IP限流，反代用户可能共享配额；正式上线须结合受信代理配置完善限流，不能随意开启trustProxy。

## AI 任务日志

生产容器把 Fastify 访问日志和后台 AI 任务错误写到标准输出。Docker Compose 部署时，在部署机执行：

```sh
docker compose ps
docker compose logs -f --tail=200 doca
```

只筛选 AI 失败记录时，可以执行：

```sh
docker compose logs --since=30m doca | grep -E "AI job failed|AI 工作流|模型|图片"
```

单独使用 Docker 时，把 `doca` 换成实际容器名：

```sh
docker ps
docker logs --since=30m -f <container-name>
```

Kubernetes 部署则查看 Pod 的标准输出：

```sh
kubectl logs -f deploy/doca --tail=200
```

浏览器中的 AI 会话接口会返回 `jobs[].id`、`jobs[].status` 和 `jobs[].error`。用这个 job ID 在日志中定位对应的 `AI job failed` 记录即可；日志只记录脱敏后的错误分类，不会输出模型密钥或完整提示词。

这是可运行开发基线，尚非生产验收发布：账号找回已实现，联系方式找回需配置验证网关；OIDC 提供方尚未实现；目标基础设施监控和大规模查询优化仍需单独验收，公共[监控服务](plugin-monitoring.zh-CN.md)已实现。外部 OIDC 和社交登录适配已实现，凭据部署和真实平台联调见 [身份认证说明](authentication.zh-CN.md)，能力边界见 [架构](architecture.zh-CN.md)。

## 数据保护

- 空数据库按最新目标结构创建；受支持的已有库在启动时补齐已审定的新增项。SQLite 默认路径为 `data/v1/doca.db`。
- 静态目录仅apps/web/dist，不公开.archive、data、.env。
- 启动对比已安装结构与最新目标；需要确认或验证失败时不监听，升级事务整体回滚。正式部署前先备份并验证恢复。
- SQLite离线备份应停止全部写入进程后复制完整目录。在线需backup API，不能只复制运行中的主db而漏掉WAL。
- PostgreSQL用原生备份/恢复流程。数据库灾备由部署运维负责。
- SIGINT/SIGTERM关闭HTTP、Vite和数据库。生产使用进程管理器重启。

## 数据库改动

修改核心结构或持久化格式前，先阅读并遵守[数据库升级规范](database-schema-evolution.zh-CN.md)。这是后续统一执行的项目约定：新库与升级共用最新 DDL，`schemaEvolution` 声明已确认的新增项，普通增量变化不调整兼容代际。历史字段值、语义及破坏性变化，按 [AGENTS.md](../AGENTS.md) 先确认具体数据保留、验证和恢复方案。

数据库改动须验证隔离 SQLite 和 PostgreSQL 17、18 旧结构，覆盖已有行保留、默认值、重复与并发启动、待确认差异不发生部分写入。发布验收还须升级受影响的实际已发行旧版本创建的数据库。PostgreSQL CI 矩阵位于 `.github/workflows/database-upgrade.yml`，与默认测试互补；已确认的行为或支持范围变化须同步规范和升级说明。

## 验证

协同相关开发先读取 `skills/doca-collaboration/SKILL.md`，仓库 `AGENTS.md` 已声明触发范围。该 skill 也安装在当前机器的 Codex 全局 skills 目录，供富文本、Excel 和宿主项目复用；其他机器需要安装此目录，不能假定仓库外任务会自动读取本仓库约束。界面语言约定同样安装为 `$doca-i18n`，源文件是 `docs/i18n.md`。

`docs/collaboration-sdk-contract.md` 是规范源文件，发布 skill 时同步 `references/contract.md`。规范中“建议 API”和待落地协议不等于当前包已支持；组件更新后宿主仍须安装新产物、核对导出和 schema，并验证保存确认、重连、已有数据恢复及在线选区，不能仅替换版本号。

```sh
pnpm typecheck
pnpm test
pnpm build
```

tests/cloud.test.ts使用临时SQLite与临时账号，结束清理测试目录，不访问实际用户库。

覆盖私有隔离（含管理员）、公开阅读、权限继承/隐藏祖先、版本冲突、所有权转移、树环、移动重置授权、删除批次恢复、独立复制、评论权限、反应幂等、通知隔离、Host/Origin、注册停用、会话撤销、重启持久化与OpenAPI路由。

已用本地浏览器检查登录、主页、搜索打开文档、实际访问记录和管理员统计；新增客户端无请求体回归测试。专项浏览器和隔离 PostgreSQL 17/18 检查见[验收记录](verification/README.md)；完整浏览器端到端覆盖、目标环境 PostgreSQL、全面键盘无障碍、反代限流、负载与长期运行仍需验收，不能以 SQLite 通过代替。
