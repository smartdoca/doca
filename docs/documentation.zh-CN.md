# 文档维护

[English](documentation.md)

文档站使用 Docsify 5.0.0。Markdown 源文件放在 `docs/`，`docs/site/navigation.json` 定义公开页面及阅读顺序。技术契约源文件保留原路径，供仓库和编辑器技能引用。

## 结构

| 分组 | 内容 |
| --- | --- |
| 入门 | 快速开始、配置、使用指南、排障 |
| 使用指南 | 文档、分享、权限、评论、知识整理 |
| 部署运维 | Docker、存储、扩展、认证、服务凭据、Webhook |
| 开发 | 源码环境、架构、编辑器、协同、界面语言 |
| 插件 | 开发、安装、公共服务、扩展贡献 |
| 技术参考 | API、数据库、SDK 与编辑器契约 |
| 发行记录 | 各版本变更、要求和验证 |
| 项目 | 文档维护及原始研发、验收资料 |

每篇公开页面都有范围一致的英文 `name.md` 和中文 `name.zh-CN.md`。研发与验收资料保留原始语言、日期和验收范围，单独索引。已退出的实现和被替代的提案在源文件顶部注明状态。实现清单区分已导出接口、提案，以及尚未验证的外部服务或设备行为。

## 检查与预览

```sh
pnpm install --frozen-lockfile
pnpm docs:check
pnpm docs:dev
```

打开 `http://127.0.0.1:39140/#/en/` 或 `http://127.0.0.1:39140/#/zh-cn/`。预览只读取文档，不启动 Doca，也不连接其数据库。源文件变更后，重新运行命令生成发布目录。

`pnpm docs:build` 生成 `.cache/docs-site/`，其中包含 `en/getting-started/`、`zh-cn/operations/` 等分组目录。它复制 Markdown 并改写链接，由 Docsify 在浏览器中渲染；不构建应用代码，也不将 Markdown 预渲染成 HTML。生成目录由 Git 忽略。

普通公开页面链接留在当前语言，明确的 English/中文链接切换语言。源码、示例和研发资料链接打开对应 GitHub 文件。每页附带编辑源文件和查看译文的链接。缺少译文时检查失败，不替换成其他语言。

`docs:check` 通过 Git 收集全仓库 Markdown，包括未被忽略的新文件，排除 `tests/fixtures/`。检查 Markdown/HTML 链接及标题目标，也检查指向本仓库 main 分支的链接；不读取被忽略的产物，不联网抓取外站或历史标签 URL。公开页面另按 Docsify 规则校验锚点。检查还比对当前发行入口、双语编辑器版本矩阵、全部数据库表/字段（含 Schema 继承接口）及五份 skill 引用与源文档的一致性。读取 TypeScript 类型时不打开应用数据库。外站可用性和每条语义说明仍须审阅。

运行 `pnpm test:docs` 验证检查器回归用例。修改契约后运行 `node scripts/sync-docs-skills.mjs`，保留原文并将相对链接改为可在仓库外使用的地址；可额外传入已安装 skills 目录，同步安装副本，例如 `node scripts/sync-docs-skills.mjs /absolute/path/to/installed/skills`。按对应 skill 的维护规则保持各安装副本同步。

## GitHub Pages

`.github/workflows/docs.yml` 在拉取请求中检查文档，并发布 `main` 的变更。在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。工作流使用 `github-pages` 部署环境及其审批规则，也可在 Actions 中手动运行。

预定入口为：

- 英文：<https://smartdoca.github.io/doca/#/en/>
- 中文：<https://smartdoca.github.io/doca/#/zh-cn/>

工作流成功部署后，这些地址才可访问。README 指向对应语言入口。文档站使用 GitHub Pages 默认域名，无需配置自定义域名 DNS 或仓库 CNAME 文件。

部署到其他静态服务时，提供 `.cache/docs-site/` 的内容。hash 路由支持仓库子路径和直接刷新，无需服务端路由重写。生成的 `.nojekyll` 用于 Pages 托管时保留以下划线开头的导航文件。

## 资源与更新

需要保留的验收摘要与文档附件放在 [`docs/verification/`](verification/README.md)，按验收主题或发行版本分目录；可复用的脚本输入放在 `tests/fixtures/`。自动生成的日志、截图、报告与缓存统一写入 `artifacts/`，该目录由 Git 整体忽略。新增保留资料无需调整忽略规则。

Docsify 运行库、搜索插件、亮色/暗色样式及 MIT 许可证随站点保存于 `docs/site/assets/vendor/docsify/`。`README.txt` 记录版本及校验过的上游 npm 包完整性，这些资源从文档站自身加载。Mermaid 图按需加载 `site.js` 固定的 ESM 版本，需要能够访问该 CDN。

新增公开页面时，创建双语文件，登记到 `navigation.json`，执行 `pnpm docs:check` 和 `pnpm docs:build`。非公开技术或设计记录进入[研发索引](research.zh-CN.md)，审阅后的验收摘要进入[验收索引](verification/README.md)。代码示例和版本要求保持一致。修改契约时遵循仓库相应技能，并按要求同步打包引用。运行库和额外插件需明确选择版本并完成浏览器验证。
