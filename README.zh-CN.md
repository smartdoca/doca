# Doca

**[官方文档](https://d.smartdoca.cc/#/r/d23f269a-2726-4565-9b7d-51655625ee7e)**

[English](README.md)

Doca 是面向个人和小团队的文档与知识库。一次部署只有一套账号，没有空间、组织架构，也不拆成父应用和子应用。

已发布的容器镜像是 [docker.io/smartdoca/doca](https://hub.docker.com/r/smartdoca/doca)。

## 平台功能

- 文档和知识库。知识库有自己的目录。阅读范围可以是私有、登录可见或公开。支持权限继承或单独设置、邀请和所有权转移。
- 五种编辑器：富文本 [@smartdoca/slate](https://www.npmjs.com/package/@smartdoca/slate)、Markdown [@smartdoca/markdown](https://www.npmjs.com/package/@smartdoca/markdown)、表格 [@smartdoca/sheet](https://www.npmjs.com/package/@smartdoca/sheet)、幻灯片 [@smartdoca/slides](https://www.npmjs.com/package/@smartdoca/slides)、画布 [@smartdoca/canvas](https://www.npmjs.com/package/@smartdoca/canvas)。协同使用 Yjs，包含持久化确认、快照和断线重连。
- 知识库整理，以及绑定知识库的问答。
- AI 助手只读取当前用户有权查看的文档和文件。另有随手记。
- 个人文件夹和共享文件夹。文件可以存在本地磁盘，也可以存在兼容 S3 的存储，并可选用 CloudFront 地址。
- 评论、点赞、收藏、通知，以及移动、副本和按批次恢复的回收站。
- 搜索。管理员可以配置 Meilisearch；未配置时用数据库匹配标题和正文。
- 账号密码，以及 OIDC、Google、GitHub、微信扫码和 QQ 登录。注册可以关闭、自动通过，或交给管理员审核。没有默认账号。
- 界面语言为中文和英文。
- 单容器使用 SQLite。只有运行多个应用副本时才需要 PostgreSQL 和 Redis。见 [水平扩展](docs/horizontal-scaling.md)。

## 本地启动

需要 Node.js 22 或更新版本，以及 pnpm 11.25.0。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

打开 http://127.0.0.1:39130。API 监听 39120，由开发服务器代理。请使用 `127.0.0.1`，不要用 `localhost`。首次启动会创建 `data/v1/doca.db`。

没有默认管理员。在项目目录执行：

```sh
bash scripts/bootstrap-admin-local.sh
```

密码至少 12 位。数据库只保存密码哈希。

`pnpm check` 会做类型检查、测试和网页构建。`pnpm start` 提供构建后的网页和 API，不启动 Vite。需要改默认配置时，把 `.env.example` 复制为 `.env`。不要提交密钥。

## Docker 启动

[部署说明](docs/deployment.zh-CN.md) · [English](docs/deployment.md)

```sh
cp docker.env.example .env
docker compose pull
docker compose up -d
```

在 `.env` 里把 `DOCA_ORIGIN` 设成对外的 HTTPS 地址，不要带路径，也不要在末尾加斜杠。Compose 只把容器发布到 `127.0.0.1:39120`。在同一台机器上用反向代理终结 TLS，并转发 HTTP 和 WebSocket 路径 `/api/v1/ws`。

```sh
curl -fsS http://127.0.0.1:39120/health
bash scripts/bootstrap-admin.sh
```

健康检查返回 `{"status":"ok","version":"0.1.0"}`。SQLite、上传文件和 AI 数据库放在 `doca_data` 卷里。第一次使用的数据库必须是空的。结构不是当前基线的非空数据库会拒绝启动。

`DOCA_ASSET_BASE` 可选。留空时，JavaScript 和 CSS 由容器提供。填写后，HTML 仍由 Doca 返回，只改写其中的 `/assets/` 地址。生产环境的前缀必须是 HTTPS，并且允许跨源读取 ES module。

## 插件开发

不属于核心的业务做成插件。Doca 只从 `DOCA_PLUGINS_DIR` 加载插件。未设置时，目录是 `${DOCA_DATA_DIR:-./data}/plugins`。在该目录自己的 `package.json` 里把已构建的插件装成直接依赖，然后重启 Doca。宿主启动时不会安装包，不会扫描间接依赖，也不会从本仓库源码加载插件。

插件包指向静态清单、编译后的服务端 JavaScript，以及可选的浏览器包：

```json
{
  "name": "@example/attachments",
  "version": "1.0.0",
  "type": "module",
  "doca": {
    "manifest": "./manifest.json",
    "server": "./dist/server.js",
    "web": { "directory": "./web", "entry": "./index.js" }
  }
}
```

```json
{
  "schemaVersion": 1,
  "id": "example.attachments",
  "version": "1.0.0",
  "displayName": "Attachments",
  "sdkRange": "^0.1.0"
}
```

依赖 `@doca/plugin-sdk` 和公开服务。不要导入 `@server/*`、`@core/*`、`@web/*`、`@db/*` 或其他宿主源码。实现由宿主在运行时注入。

```ts
import { definePlugin } from "@doca/plugin-sdk";
import { httpServiceToken } from "@doca/plugin-sdk/platform";
import manifest from "../manifest.json" with { type: "json" };

export default () =>
  definePlugin({
    manifest,
    injections: { required: [httpServiceToken] },
    async mount(context) {
      await context.inject(httpServiceToken).register(manifest.id, [
        {
          method: "GET",
          path: "/items",
          async handle() {
            return { items: [] };
          },
        },
      ]);
    },
  });
```

这个路由的实际地址是 `/api/v1/plugins/example.attachments/items`，身份来自宿主会话。注册 ID 要放在插件 ID 下面。插件数据放在插件自己的数据库里。停用插件只释放运行资源，不删除已保存的用户数据。

规范、公开服务和验证要求见 [插件开发](docs/plugin-development.md) 和 [插件 SDK 契约](docs/plugin-sdk-contract.md)。安装目录见 [插件部署](docs/plugin-deployment.md)。

## 更多文档

- [架构](docs/architecture.md)
- [身份认证](docs/authentication.md)
- [协同与搜索](docs/collaboration.md)
- [编辑器集成](docs/editor-integration.md)
- [存储](docs/storage.md)
- [接口](docs/api.md)。运行中的服务还提供 `/api/openapi.json`。
- [开发环境](docs/development.md)

## 许可证

Doca 使用 [AGPL-3.0-only](LICENSE)。可以包括商业用途在内的方式使用；通过网络向用户提供修改版时，需要按 AGPL 提供对应源码。

富文本、表格、Markdown、画布和幻灯片编辑器使用同一许可证，并单独发布到 npm。
