# Doca 0.2.18 发布验收

2026-10-25 完成发布验收。Doca **0.2.18** 已发布到 [GitHub](https://github.com/smartdoca/doca/releases/tag/v0.2.18) 和 [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags)。[PR98](https://github.com/smartdoca/doca/pull/98) 将本次全部工作区改动一起合并，正式 tag 固定指向 `a02b5b5e6c456fff931f276d523b595a832e7726`；本回执不移动 tag。

## 已交付内容

- 浏览器扩展 **0.2.5** 将静态外链和内联 SVG 转为保留透明背景的 PNG。不兼容、失效或转换失败的图片在原位置保留原因及原图链接，正文和其他图片继续保存；权限、配额和存储错误仍中止提交。
- 新任务在暂存前完成预处理，重试保持正文、图片清单和请求 ID，并复用已上传图片。历史失败任务按用户已同意的方案重新收录；不自动改写旧任务、文档或图片。收录协议、资产及数据库格式不变。
- 富文本评论与正文共享一个纵向滚动区域，桌面和紧凑布局均保持卡片随锚点移动；滚动评论推动整篇文档，保留回复草稿、评论导航和长线程可达性。
- 补入可复用浏览器验证脚本、双语发行说明、部署包及当前版本入口。详见[SVG 收录验收](browser-extension-svg-2026-10-25.md)与[评论滚动验收](rich-comment-scroll-2026-10-25.md)。

## 本地与 CI 验证

- 全量回归：326 个文件、3387 项通过；3 个文件及 11 项按配置跳过，无失败。TypeScript、最终正式 Web/扩展/Canvas 构建、编辑器 npm 来源核对、93 页双语文档及部署打包通过。
- 实际 Chromium MV3 验证无 CORS 许可的跨域 SVG、内联 SVG、透明背景、内嵌样式像素、三处缺图占位、来源链接、正文尾部和提交中断后的同任务重试。额外验证 Nature 实际 Logo 转为 326 × 50 的透明 PNG。完整回归之后重新正式构建，并再次通过真实扩展验证。
- 评论在 2100、1600、1000、760px、AI 栏展开、草稿输入、上下跳转、空评论及长回复下验证共享滚动。空闲 61 秒后文档 seq/checkpoint 和内容更新均不变。测试使用隔离数据库和合成文档，不操作用户文档、不调用付费模型。
- [PR PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40207090320)及[主分支矩阵](https://github.com/smartdoca/doca/actions/runs/40207515156)全部通过；[主分支文档 CI 与部署](https://github.com/smartdoca/doca/actions/runs/40207515167)通过。

## Docker Hub 双架构与公开索引

[原生双架构构建和发布流水线](https://github.com/smartdoca/doca/actions/runs/40207535153)全部通过。每架构均验证 UID1000、健康检查、扩展 ZIP、登录/退出/撤权、原始图片字节、沙箱 PDF、Canvas 真实像素及 DOCX/XLSX 转 PDF，模拟模型调用为零。每架构 572 个运行文件、484 个 Web 文件及 9 个编辑器入口/清单，与最终本地正式构建逐字节一致。

发布后独立通过 Docker Registry HTTP API 读取公开索引、子 manifest 和 config，核对原始字节 SHA256、Linux amd64/arm64、版本及源码标签。`0.2.18` 和 `latest` 均为：

`sha256:57455a68e644f4d9af3d2581124f2b523a9f518d73409c226899f158cab5adbe`

| 架构 | manifest 摘要 | 完整压缩层字节 |
| --- | --- | ---: |
| amd64 | `sha256:e2874b452996961ce9bc184a389460e562d608dbfc73b4d87544f4f31a9cde31` | 707,941,823 |
| arm64 | `sha256:dd0023061be0cd92df1d1dd5d59b74d0f05563b88a0bb2e4b0b4e69c871629d1` | 704,743,529 |

两架构均保留 46 层，包含既有 Chromium、Office、字体和编辑器功能。

## GitHub 附件

[GitHub Release 流水线](https://github.com/smartdoca/doca/actions/runs/40207531209)成功。三个公开附件实际下载后，大小和 SHA256 与 GitHub 元数据一致；479 个 Web assets 文件和部署包中的 10 个允许文件与最终本地构建逐字节一致，部署包校验文件正确。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.18.tar.gz | 18,417 | `4dbab72c6a466780344cf567de587f7035d38638fe4e20c78f0d967c10f97307` |
| doca-deploy-v0.2.18.tar.gz.sha256 | 93 | `1dd8dcf0db520899c60e3f740cfb721a806ee0228e3830202d086d33f2a6e5f3` |
| doca-web-assets-v0.2.18.tar.gz | 17,168,524 | `73df2fe2af2488ae2f8b435430b33ee74dbeac5057d350f413865bb744d84a49` |

本次临时 GitHub Docker Hub 发布 secrets 已删除并复核不存在，未记录凭据值。原始下载、JSON、执行日志、浏览器存储及截图位于忽略目录 `artifacts/verification/release-0.2.18/`、`artifacts/verification/browser-extension-svg/` 和 `artifacts/verification/rich-comment-scroll/`，不提交原始执行输出。

部署 0.2.18 后重新下载并加载扩展 **0.2.5**，刷新原网页并重新发起历史失败页面的收录。保留原数据库、文件卷、凭据主密钥及既有队列，沿用已批准的升级与回退规则。
