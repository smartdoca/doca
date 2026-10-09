# Doca

[详细文档](https://smartdoca.github.io/doca/#/zh-cn/) · [English](README.md)

Doca 是面向个人和小团队的开源文档与知识工作台。一次部署只有一套账号系统。

[Demo 体验](https://d.smartdoca.cc) · [插件商城](https://store.smartdoca.cc)

**Demo 数据会不定期清理，请不要存放重要数据。**

## 功能

- 富文本、Markdown、表格、幻灯片和画布文档，支持实时协同与历史记录。
- 知识库与多人共建的知识册，支持编排、来源溯源和人工审阅。
- 个人 AI 助手，支持 PDF/Office 读取、图片生成与编辑、持久附件和浏览器草稿。
- 个人文件与共享文件夹，支持本地或兼容 S3 的存储。
- 邀请、权限、分享、评论、通知、搜索和回收站。
- 密码、OIDC、Google、GitHub、微信扫码和 QQ 登录；中英文界面。
- 单服务器使用 SQLite；多副本使用共享 PostgreSQL、Redis 和文件存储。
- 通过公开 `@smartdoca/plugin-sdk` 开发业务插件。

默认镜像不安装随手记、邮箱、日历、会员或内容审核插件。模板和素材需要单独安装提供者，详见[功能与边界](https://smartdoca.github.io/doca/#/zh-cn/getting-started/features)。

## Docker 快速开始

需要 Git、Docker Engine、Docker Compose，以及通过反向代理访问的 HTTP(S) 地址。本流程在新空数据库中安装已发布的 0.1.13 镜像。已有部署更换版本前，先阅读[发行要求](https://smartdoca.github.io/doca/#/zh-cn/releases/0.1.13)并保留原数据。

```sh
# 1. 拉取对应发行版代码
git clone --branch v0.1.13 --depth 1 https://github.com/smartdoca/doca.git
cd doca

# 2. 配置环境变量
cp docker.env.example .env
# 编辑 .env，将 DOCA_ORIGIN 改成自己的 HTTP(S) 来源。
# 单机部署保留示例中的本地文件存储配置。

# 3. 拉取镜像
docker compose pull

# 4. 启动并检查健康状态
docker compose up -d
docker compose ps
# 等待状态显示 healthy，再初始化管理员

# 5. 初始化管理员账号和密码
bash scripts/bootstrap-admin.sh
```

密码至少 12 位，没有默认账号。Compose 绑定 `127.0.0.1:39120`，浏览器访问前需要配置 HTTP(S) 反向代理。SQLite、文件、插件和 AI 数据库保存在 `doca_data` 卷。

[完整快速开始](https://smartdoca.github.io/doca/#/zh-cn/getting-started/quickstart)包含 `.env`、反向代理、健康检查、管理员恢复和数据保留说明。

## 源码开发

需要 Node.js 22.12 或更新版本，以及 pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

打开 `http://127.0.0.1:39130`，通过 `bash scripts/bootstrap-admin-local.sh` 初始化管理员。`pnpm check` 执行 TypeScript 检查、测试和 Web 构建。详见[开发环境](https://smartdoca.github.io/doca/#/zh-cn/development/development)。

## 文档

- [使用指南](https://smartdoca.github.io/doca/#/zh-cn/getting-started/user-guide)
- [部署与配置](https://smartdoca.github.io/doca/#/zh-cn/operations/deployment)
- [插件开发](https://smartdoca.github.io/doca/#/zh-cn/plugins/plugin-development)
- [HTTP API](https://smartdoca.github.io/doca/#/zh-cn/reference/api)，运行中的应用还提供 `/api/openapi.json`。
- [发行记录](https://smartdoca.github.io/doca/#/zh-cn/releases/0.1.13)
- [文档源码](docs/README.zh-CN.md)

预览文档时，执行 `pnpm docs:dev` 并打开 `http://127.0.0.1:39140/#/zh-cn/`。`pnpm docs:check` 校验双语覆盖和本地链接。GitHub Pages 设置见[文档维护](docs/documentation.zh-CN.md)。

## 许可证

[MIT](LICENSE)。单独发布的富文本、表格、Markdown、画布和幻灯片编辑器采用同一许可证。
