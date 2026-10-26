# Doca 0.2.21 发布验收

2026-10-26 完成发布验收。Doca **0.2.21**、浏览器扩展 **0.2.8** 由 [PR103](https://github.com/smartdoca/doca/pull/103) 交付。正式 tag 固定指向 `b4b975c48d3bca77a12928ac93d2ecfa20ef934c`，本回执不移动 tag。

## 实际收录与回归

通过用户 Chrome 的真实浮动工具条收录反馈的 Annual Reviews pharmtox 页面，在隔离的 0.2.21 实例中保存、打开并刷新。1,525 个原生块、568,703 字节，正文末尾和参考文献保留，9 张保存图片全部加载，包括两张正文图；一张不支持的站点 SVG Logo 留下占位和当前提示。扩展已恢复原站点和账户，见[实际网页验收](annualreviews-pharmtox-2026-10-26.md)。

整页提取排除 CSS 隐藏副本；格式化内容超出既有导入预算时保存完整原始 Markdown、标题和已上传图片。全量 3,409 项测试通过、11 项跳过、无失败；类型检查、最终生产构建、正式编辑器 npm 来源核对和双语文档检查通过。[PR PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40277138548)、[主分支 PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40277565286)及[文档部署](https://github.com/smartdoca/doca/actions/runs/40277565255)均通过。

## Docker Hub

[原生双架构流水线](https://github.com/smartdoca/doca/actions/runs/40277599321)全部通过。在 amd64 和 arm64 原生容器中实际验证 8,000 段格式膨胀后的完整保存、原始标题、坏图占位、当前转换提示及原图字节，以及既有登录、退出、撤权、扩展下载和渲染检查。发布后独立读取公开 Docker Registry 索引、子 manifest 和 config，核对原始字节摘要、架构、版本和源码标签，并逐文件对照最终本地构建。

[Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) 的 `0.2.21` 和 `latest` 均为：

`sha256:8bf59b78702a50ed96ee1c6e44851895bf2674010fc926d812836eb8d7f12c13`

| 架构 | manifest 摘要 | 匹配运行 / Web / 编辑器文件 |
| --- | --- | ---: |
| amd64 | `sha256:5eab0d63f093129c3bad7e57fbd5c87280c1551120f83758705b78e02425288e` | 573 / 484 / 9 |
| arm64 | `sha256:3d9b27791a29e008a57726dcbbe0500a4479f12419bc50b639d4db5552cd054f` | 573 / 484 / 9 |

## GitHub 附件与收尾

[GitHub Release](https://github.com/smartdoca/doca/releases/tag/v0.2.21)及其[流水线](https://github.com/smartdoca/doca/actions/runs/40277595090)成功。三个公开附件已下载，大小和 SHA256 与 GitHub 元数据一致；479 个 Web assets 文件及部署包中的 10 个允许文件与最终本地构建一致，部署包校验文件正确。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.21.tar.gz | 18,421 | `994de8ceda0af6ce2da1ed54742c3846c9ac9d81a7995e6dedf049558ed488d4` |
| doca-deploy-v0.2.21.tar.gz.sha256 | 93 | `11190e425322d246962cefd837520d648eb40a93fcb0d91947fe12bc1ce8104f` |
| doca-web-assets-v0.2.21.tar.gz | 17,166,210 | `074e6eecd12296fadedc9639be55b5cbf2f87ef0cf37c5d81d7f668e6148f56a` |

临时 Docker Hub 发布 secrets 已删除并复核不存在；未记录凭据值。原始日志、JSON、下载和截图位于忽略目录 `artifacts/verification/release-0.2.21/` 与 `artifacts/verification/annualreviews-pharmtox-2026-10-26/`。

本回执确认 GitHub / Docker Hub 制品发布；生产站点需更新服务端到 **0.2.21** 并使用扩展 **0.2.8**。未修改数据库结构、协议版本或持久化任务格式，不增加报告字段。历史失败页面重新收录，已完成请求保持幂等，保留既有文档、图片及原有清理规则。

## 原站点复查状态

恢复原连接后，也尝试了原站点的“网页收录目录”新建规则：扩展仍显示通用失败。原站点 `/health` 此时明确为 **0.2.20**；未修改其收录方案或部署。当前网页的完整 DOM 和实际计算隐藏样式在本地复现提取得到 283,885 字节 Markdown、10 个图片候选，符合现有收录协议。尚未取得这次原站点失败的具体服务端错误，不能将其标记为生产验收通过。已请用户更新原站点到本次发布的 **0.2.21** 后继续实际收录验收。
