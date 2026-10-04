# 文档维护

[English](documentation.md)

文档站使用 Docsify 5.0.0。Markdown 源文件放在 `docs/`，`docs/site/navigation.json` 定义公开页面及阅读顺序。技术契约源文件保留原路径，供仓库和编辑器技能引用。

## 结构

| 分组 | 内容 |
| --- | --- |
| 入门 | 快速开始、配置、使用指南、排障 |
| 使用指南 | 文档、分享、权限、随手记、知识整理 |
| 部署运维 | Docker、存储、扩展、认证、服务凭据、Webhook |
| 开发 | 源码环境、架构、编辑器、协同、界面语言 |
| 插件 | 开发、安装、公共服务、扩展贡献 |
| 技术参考 | API、数据库、SDK 与编辑器契约 |
| 发行记录 | 各版本变更、要求和验证 |
| 项目 | 文档维护及原始研发、验收资料 |

每篇公开页面都有范围一致的英文 `name.md` 和中文 `name.zh-CN.md`。研发与验收资料保留原文和原始语言，单独索引。实现清单区分已导出接口、提案，以及尚未验证的外部服务或设备行为。

## 检查与预览

```sh
pnpm install --frozen-lockfile
pnpm docs:check
pnpm docs:dev
```

打开 `http://127.0.0.1:39140/#/en/` 或 `http://127.0.0.1:39140/#/zh-cn/`。预览只读取文档，不启动 Doca，也不连接其数据库。源文件变更后，重新运行命令生成发布目录。

`pnpm docs:build` 生成 `.cache/docs-site/`，其中包含 `en/getting-started/`、`zh-cn/operations/` 等分组目录。它复制 Markdown 并改写链接，由 Docsify 在浏览器中渲染；不构建应用代码，也不将 Markdown 预渲染成 HTML。生成目录由 Git 忽略。

普通公开页面链接留在当前语言，明确的 English/中文链接切换语言。源码、示例和研发资料链接打开对应 GitHub 文件。每页附带编辑源文件和查看译文的链接。缺少译文时检查失败，不替换成其他语言。检查还覆盖本地目标、公开页面锚点和根目录两份 README 的对应语言链接。

## GitHub Pages

`.github/workflows/docs.yml` 在拉取请求中检查文档，并发布 `main` 的变更。在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。工作流使用 `github-pages` 部署环境及其审批规则，也可在 Actions 中手动运行。

预定入口为：

- 英文：<https://smartdoca.github.io/doca/#/en/>
- 中文：<https://smartdoca.github.io/doca/#/zh-cn/>

工作流成功部署后，这些地址才可访问。README 指向对应语言入口。文档站使用 GitHub Pages 默认域名，无需配置自定义域名 DNS 或仓库 CNAME 文件。

部署到其他静态服务时，提供 `.cache/docs-site/` 的内容。hash 路由支持仓库子路径和直接刷新，无需服务端路由重写。生成的 `.nojekyll` 用于 Pages 托管时保留以下划线开头的导航文件。

## 资源与更新

Docsify 运行库、搜索插件、亮色/暗色样式及 MIT 许可证随站点保存于 `docs/site/assets/vendor/docsify/`。`README.txt` 记录版本及校验过的上游 npm 包完整性，这些资源从文档站自身加载。Mermaid 图按需加载 `site.js` 固定的 ESM 版本，需要能够访问该 CDN。

新增公开页面时，创建双语文件，登记到 `navigation.json`，执行 `pnpm docs:check`。代码示例和版本要求保持一致。修改契约时遵循仓库相应技能，并按要求同步打包引用。运行库和额外插件需明确选择版本并完成浏览器验证。
