# 开发、部署与验收

[English](development.md)

## 开发启动

Node.js 22.12+或24 LTS、pnpm 11。版本锁定pnpm-lock.yaml；better-sqlite3原生构建已在pnpm-workspace.yaml允许。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

入口 http://127.0.0.1:39130，API监听39120，通过前端同源代理访问。直接访问39120或用localhost替换127.0.0.1会与配置不符。

默认配置即可运行，需调整时参照.env.example创建本地.env，不提交凭证。

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
| DOCA_ORIGIN       | http://127.0.0.1:39130 | 唯一浏览器源；部署为HTTPS域名       |
| DOCA_HOST         | 127.0.0.1              | 监听地址                            |
| DOCA_PORT         | 39120                  | API/发布服务端口                    |
| DOCA_WEB_PORT     | 39130                  | 开发前端端口                        |
| DOCA_DATABASE     | sqlite                 | sqlite/postgres                     |
| DOCA_SQLITE_PATH  | ./data/v1/doca.db      | 新版独立数据库                      |
| DOCA_DATABASE_URL | 无                     | PostgreSQL连接串，专用新数据库      |
| NODE_ENV          | 未设置                 | production强制HTTPS Origin并禁止dev |
| DOCA_ASSET_BASE   | 空                     | 构建资源的 HTTPS 前缀；空则从本机 `/assets` 提供 |

## 静态资源地址

生产页面的 HTML 始终由 Doca 返回，接口也使用页面所在的源。`DOCA_ASSET_BASE` 只改写 HTML 里的 `/assets/...` 地址。

不设置时，JS、CSS 和其他构建文件由容器从 `/assets` 读取。设置时，HTML 中的这些地址改为该前缀，例如 `https://cdn.example.com/doca/0.1.0/assets/index-abc.js`。前缀必须是没有账号、查询参数或哈希的 HTTP(S) URL；生产环境必须是 HTTPS。容器里的 `/assets` 仍然保留，样式表内部以根路径引用的字体和图片会继续回到 Doca。

推送正式版本标签 `v1.2.3` 时，GitHub Actions 会构建网页并创建 Release，附件是 `doca-web-assets-v1.2.3.tar.gz`。解压后保留其中的 `assets` 目录，再把包含该目录的 HTTPS 前缀写入 `DOCA_ASSET_BASE`。`v1.2.3-rc.1` 这类预发布标签不会创建 Release。推送到 `main` 也不会。浏览器不要直接使用 `github.com/.../releases/download` 作为 `DOCA_ASSET_BASE`：下载地址会跳转，也不为 ES module 提供跨源响应头。把解压出的 `assets` 目录放到允许跨源读取脚本的 CDN 或对象存储上。

## 发布模式

```sh
pnpm check
NODE_ENV=production DOCA_ORIGIN=https://docs.example.com pnpm start
```

check执行类型检查、测试和前端构建；start服务构建产物与API，不启动Vite。示例域名需替换并配置TLS反代，保留原Host/Origin，转发DOCA_PORT。

后端不信任任意X-Forwarded-*，默认loopback。当前认证按连接IP限流，反代用户可能共享配额；正式上线须结合受信代理配置完善限流，不能随意开启trustProxy。

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

这是可运行开发基线，尚非生产验收发布：缺账号找回、OIDC 提供方、完整安全审计/监控、大规模查询优化等。外部 OIDC 和社交登录适配已实现，凭据部署和真实平台联调见 [身份认证说明](authentication.zh-CN.md)，能力边界见 [架构](architecture.zh-CN.md)。

## 数据保护

- 数据库按当前基线从零创建，默认路径为data/v1/doca.db。
- 静态目录仅apps/web/dist，不公开.archive、data、.env。
- 启动自动创建当前 schema，建表失败不监听；正式部署前先备份并验证恢复。
- SQLite离线备份应停止全部写入进程后复制完整目录。在线需backup API，不能只复制运行中的主db而漏掉WAL。
- PostgreSQL用原生备份/恢复流程。数据库灾备由部署运维负责。
- SIGINT/SIGTERM关闭HTTP、Vite和数据库。生产使用进程管理器重启。

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

已用本地浏览器检查登录、主页、搜索打开文档、实际访问记录和管理员统计；新增客户端无请求体回归测试。仍需完整浏览器端到端覆盖、真实PostgreSQL、全面键盘无障碍、反代HTTPS/限流、负载与长期运行验收，不能以SQLite通过代替。
