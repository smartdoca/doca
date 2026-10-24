# Doca 0.2.17 发布验收

2026-10-25 完成发布验收。Doca **0.2.17** 已发布到 [GitHub](https://github.com/smartdoca/doca/releases/tag/v0.2.17) 和 [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags)。正式 tag 固定指向 `5037da2b24da4dcf55e58450a6653e08587f0122`，[PR95](https://github.com/smartdoca/doca/pull/95) 的浏览器改动和 [PR96](https://github.com/smartdoca/doca/pull/96) 的评论及文档改动一起交付；本回执不移动正式 tag。

## 功能与文档

- 富文本评论区展开时，上下跳转及 AI 按钮仍位于最右侧。其他格式保留抽屉对应的布局。
- 浏览器助手恢复上次会话前校验当前收录规则，避免规则更新后的误导性访问报错；新消息附加的网页显示为可打开、按网址去重的关联资源。新会话首条消息结合网页名称、请求和域名生成标题，来源用浏览器图标标识。
- 评论回复间距缩小；删除前气泡确认，取消或 Esc 不发送删除。五种编辑器的评论栏顶部增加已解决评论入口，可查看线程和回复，并按既有作者/管理权限及版本检查恢复为未解决。恢复失败保留列表并允许重试。Esc 关闭弹框后保留评论栏。
- README 和双语指南补充浏览器扩展及 MCP 接入，修正文档首页、能力版本、已有本地副本/队列和多副本通知的过时说明。MCP 文档按当前服务端接口核对，未改动 MCP 实现。

## 本地与数据库验证

- 全量回归为 325 个文件、3370 项通过，3 个文件及 11 项按配置跳过。首次默认并发有一项大 PNG 用例超时；该文件单独复核 13 项通过，随后以 `--maxWorkers=4` 完整重跑通过，未放宽超时或修改该用例。
- 评论、定位与滚动的 23 项定向测试通过；新增测试验证已解决线程与回复保留、无权限恢复被拒、旧版本冲突和有效根评论恢复。
- TypeScript、正式 Web/扩展/Canvas 构建、编辑器 npm 来源核对、92 页双语文档与部署打包通过。
- 同一最终应用源码、已安装编辑器包和正式 Web 构建在真实 Chromium 与隔离 SQLite 中连续三轮通过。每轮覆盖富文本、Markdown、表格、幻灯片和画布：删除取消/确认、Esc、已解决历史、恢复失败重试、390px 弹框，以及 1600/760/390px 评论布局。画布含超过 200 条评论，验证分页后能查到目标线程及全部回复。
- 每轮保留 5 个编辑器空闲至少 61 秒，文档内容写入为零、原生编辑器实例保持不变，前后包及源码指纹一致，无页面错误。最后一轮额外等待确认气泡动效结束后截图；主 Agent 自行检查桌面及窄屏画面，没有独立设计评审。全部使用隔离合成文档和模拟模型，未对用户文档编辑或调用付费模型。
- 浏览器会话改动在 PR95 合并前通过真实 MV3 扩展三轮验证，每轮 4 个合成模型任务；本次双架构发布再次验证扩展下载、登录、退出和撤权。
- [PR PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40110655391) 和[主分支矩阵](https://github.com/smartdoca/doca/actions/runs/40110996648) 全部通过，矩阵已包含评论权限及恢复测试。文档 CI 与部署通过。

## 镜像与公开索引

[原生双架构及发布流水线](https://github.com/smartdoca/doca/actions/runs/40111033139) 全部通过。每架构验证 UID1000、登录/退出/撤权、原始图片字节、沙箱 PDF、Canvas 真实像素及 DOCX/XLSX 转 PDF。571 个运行文件、484 个 Web 文件和 9 个编辑器入口/清单与 tag 源码构建一致。发布后另核对两个架构的全部 484 个 Web 文件和扩展 8 个关键文件哈希，与本地正式构建一致。

独立通过只读 Docker Registry HTTP API 读取公开索引、子 manifest 和 config，检查原始字节 SHA256、Docker-Content-Digest、操作系统/架构以及版本和源码标签。`0.2.17` 和 `latest` 均为：

`sha256:a25aa6f77df5bc34a23a236b454b96337c5cd6c484517e06ae2ac00e92237a6f`

| 架构 | manifest 摘要 | 完整压缩层字节 | 保留 0.2.15 时新增唯一层字节 |
| --- | --- | ---: | ---: |
| amd64 | `sha256:97eef6725a7c247e02a992115a782d2a48c13d3e8369be20f7dce42a0809e73d` | 707,938,853 | 14,354,785 |
| arm64 | `sha256:8e95c85e1ca88c6ec6cfaa158cb19a45cbc28b1ebbfa8cb6946880d44542beb5` | 704,740,492 | 14,354,743 |

增量以前版同架构镜像层仍在本机为前提，仅计缺少的唯一压缩 blob，不含 manifest/config 和传输头部；首次拉取需要完整镜像。两架构均有 46 层，复用 25 层。未删减 Chromium、Office、字体或编辑器功能。

## GitHub 附件与收尾

[Release 流水线](https://github.com/smartdoca/doca/actions/runs/40111027693) 成功。三个公开附件实际下载后，大小和 SHA256 与 GitHub 元数据匹配；Web 的 479 个文件、部署包的 10 个允许文件与本地正式包逐字节一致，校验文件正确。部署打包使用 `COPYFILE_DISABLE=1`。GitHub 最新 Release 为 `v0.2.17`。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.17.tar.gz | 18,416 | `7f0103caf7092710befe4ea854297e72a341b41e729482b7d7ab1f98ae6961ba` |
| doca-deploy-v0.2.17.tar.gz.sha256 | 93 | `5fca5d640b3e26cef157c55e6a4186827a2a6de9d3b02a29e5750d786da7e8e7` |
| doca-web-assets-v0.2.17.tar.gz | 17,164,033 | `a13ead88e9558c763253792ada798063cc2ebe66b28f5ed2e641b46eb180a804` |

临时 GitHub Docker Hub 发布 secrets 已删除，并复核不存在，未记录凭据内容。原始日志、下载、SQLite、浏览器存储、截图和 JSON 位于忽略目录 `artifacts/verification/release-0.2.17/`、`artifacts/verification/comment-thread-controls/` 和 `artifacts/verification/browser-assistant-context/`。

## 更新范围

服务端和 Web 一起更新。浏览器扩展为 **0.2.4**，从 0.2.15 或更早版本升级需重新下载并在 Chrome/Edge 重新加载。数据库结构、SDK、认证与收录协议、评论/锚点及持久队列格式不变；沿用既有历史队列处理，不转换、回填、删除历史数据或改写既有标题。详见[发行要求](../releases/0.2.17.zh-CN.md)。

0.2.16 的 GitHub 制品先前已生成，其尚未完成的正式镜像发布已停止；本次完整交付使用 0.2.17，保留既有源码标签。本回执确认 GitHub/Docker Hub 制品发布，未部署用户生产站点。
