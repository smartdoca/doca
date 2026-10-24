# Doca 0.2.14 发布验收

2026-10-24 完成发布验收。Doca **0.2.14**、浏览器扩展 **0.2.3** 已发布到 [GitHub](https://github.com/smartdoca/doca/releases/tag/v0.2.14) 和 [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags)。正式 tag 固定指向 `a013f5829777eabaf56bd69e0fcc151c90d44278`，[PR91](https://github.com/smartdoca/doca/pull/91) 已合并；此发布回执不移动 tag。

## 功能及回归

收录确认气泡使用 Doca 共用下拉框，隐藏浏览器原生选择器。收起/展开按钮与其他图标同列，位于设置下方；收起后保留加深的拖拽把手和向下展开箭头，仍可上下拖动。收起/展开保持垂直锚点，位置继续使用既有本机 `dockPosition` 数字缓存。

- 完整回归为 324 个文件、3355 项通过，3 个文件及 11 项按配置跳过，无失败，耗时 236.61 秒。同列按钮布局调整后再次通过 111 项定向扩展测试。
- TypeScript、正式 Web/扩展/Canvas 构建、编辑器 npm 来源、89 页双语文档及部署打包通过。
- 最终同列按钮版本在真实 Chromium MV3 连续三轮通过，每轮 11 次收录请求、2 次消息提交，无浏览器或合成服务错误。覆盖真实第二条规则收录、鼠标与键盘、Escape、390px、原生 200% 缩放、同列几何边界、折叠拖拽、缓存保存失败、刷新、完整重启浏览器及新页面恢复。三轮缓存位置均为 0.33098591549295775，在 1280×900 恢复到 top 223.5px。
- 窗口调整后的自动化点击已等待两帧布局，避免测量与点击之间工具条重新定位。100%、窄屏、200%、展开/折叠和重启截图由主 Agent 自检；本次为局部控件调整，未另行独立视觉评审。使用隔离合成数据，未使用用户文档或付费模型。
- [PR PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40050596447) 和[主分支矩阵](https://github.com/smartdoca/doca/actions/runs/40050922835) 全部通过。

具体交互见[控件验收](browser-extension-controls-2026-10-24.md)。

## 镜像与公开索引

[原生双架构及发布流水线](https://github.com/smartdoca/doca/actions/runs/40050942472) 全部通过。每架构验证 UID1000、登录/退出/撤权、小图原始字节、沙箱 PDF、Canvas 真实像素和 DOCX/XLSX 转 PDF；571 个运行文件、483 个 Web 文件和 9 个编辑器入口/清单与正式源码构建一致。另与本地正式构建核对扩展 8 个关键文件，包括 `content.js`、`select.js`、manifest 和正式助手 bundle。

发布后从公开 Docker Registry HTTP API 读取索引及子 manifest，验证原始字节 SHA256、Docker-Content-Digest、子镜像和 config 摘要。`0.2.14` 与 `latest` 均为：

`sha256:1c50b5ffc0da705277d686cb7c2131e48dce7de5153ec11f8b19e68e05aa33bc`

| 架构 | manifest 摘要 | 完整压缩层字节 | 保留 0.2.13 时新增唯一层字节 |
| --- | --- | ---: | ---: |
| amd64 | `sha256:746d050c109033fe36c1a8186b4e1cce955b727bcc4087292b4fc20a0cf541ec` | 707,935,249 | 3,174,232 |
| arm64 | `sha256:727488591fd26957801a3d7540341fce8a8e29145a15337e25e7ba2b1efe9a71` | 704,736,873 | 3,174,226 |

增量以前版同架构层仍在本机为前提，只合计缺少的唯一压缩 blob，不含 manifest/config 及传输头部；首次拉取需要完整镜像。未删减 Chromium、Office、字体或编辑器功能。

## GitHub 附件

[Release 流水线](https://github.com/smartdoca/doca/actions/runs/40050938926) 成功。三个公开附件已实际下载，大小和 SHA256 与 GitHub 元数据匹配；Web 的 478 个文件及部署包的 10 个允许文件与本地正式构建逐字节一致，校验文件正确。部署打包使用 `COPYFILE_DISABLE=1`。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.14.tar.gz | 18,419 | `114acb5d5d0b394ee6e179f93752bc88f7d980e73f880651c2f92c43b0d7fee5` |
| doca-deploy-v0.2.14.tar.gz.sha256 | 93 | `e36d6caf83ffffc7690256e601f708c5f4659b1e4425b2c403c32ac08f0be3ea` |
| doca-web-assets-v0.2.14.tar.gz | 17,158,176 | `9e477b94eee8e02552c8bc8d07775b5ac660eef128cbb18db985594161f1dd2c` |

临时 GitHub Docker Hub 发布 secrets 已删除，并复核不存在；没有记录凭据内容。原始日志、下载、截图、浏览器存储及 JSON 位于忽略目录 `artifacts/verification/release-0.2.14/` 和 `artifacts/verification/browser-extension-controls/`。

## 更新范围

没有改变数据库、队列、编辑器 SDK 或位置缓存键和格式，没有转换、删除或回填已有数据。保留既有数据库、文件及浏览器存储；回退继续遵守既有队列停用约定。

更新镜像后，从「浏览器助手」设置重新下载并加载扩展 **0.2.3**，刷新已打开网页。旧扩展不会仅随服务端更新而改变。此回执确认 GitHub/Docker Hub 制品发布，未部署用户的生产站点。
