# Doca 0.2.22 发布验收

2026-10-26 完成制品发布。服务端 **0.2.22**、浏览器扩展 **0.2.10** 由 [PR105](https://github.com/smartdoca/doca/pull/105) 交付，正式 tag 固定指向 `1cb4d91e176c05b588354b069b1c5688e4fc4ab9`。本文不移动 tag。

## 自动回收与回归

每次新收录在十个暂存名额已满时，只回收所需数量的最旧闲置任务；三十分钟活动保护、浏览器 AI 任务保护及原定二十四小时原文/图片保留规则均按用户已明确同意的方案执行。扩展遇到过期任务，使用同一份冻结材料、账号和位置自动重建并重试一次。协议、表列和持久化 JSON 形状不变，已保存文档保留。详见[规则及故障定位](clipper-automatic-recovery-2026-10-26.md)。

全量回归 3,429 项通过、11 项跳过；160 项针对性测试及最终提示文案的 39 项 UI 测试通过。PostgreSQL 心跳测试改为等待实际事务提交后，隔离 PostgreSQL 17 的 26 项收录测试通过；[GitHub PostgreSQL 17/18 回归](https://github.com/smartdoca/doca/actions/runs/40288237467)全部通过。类型检查、最终生产构建、正式编辑器 npm 来源检查及 97 页双语文档检查通过。

## Docker Hub

[原生 amd64 / arm64 流水线](https://github.com/smartdoca/doca/actions/runs/40288752121)全部通过。两个架构都实际执行满额自动回收并保存文档，断言原任务冻结内容及原到期时间不变，并验证长文完整保存、图片占位、当前处理提示、原图字节、授权退出与撤权、扩展包下载和渲染功能。

独立读取公开 Docker Registry 的索引、子 manifest 和 config，核对原始字节摘要、架构、版本及源码标签，并逐文件对照最终本地构建。[Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) 的 `0.2.22` 与 `latest` 均为：

`sha256:1d48c17449663448c3f28add201e448eed4733efab3702de0b036a31a90aa4ab`

| 架构 | manifest 摘要 | 匹配运行 / Web / 编辑器文件 |
| --- | --- | ---: |
| amd64 | `sha256:a9562ac271f35421c9c6e9aa5e2d19422338237155c0e8bca3343058de5d47d4` | 573 / 484 / 9 |
| arm64 | `sha256:57789ffe02f887db7553030ff1ba007cf2af6c50fa5951b6b47e8997152a64a3` | 573 / 484 / 9 |

## GitHub 附件与收尾

[GitHub Release](https://github.com/smartdoca/doca/releases/tag/v0.2.22)及其[流水线](https://github.com/smartdoca/doca/actions/runs/40288746503)成功。三个公开附件已下载，大小和 SHA256 与公开元数据一致；479 个 Web assets 文件及部署包的 10 个文件与最终本地构建一致，部署包校验文件正确。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.22.tar.gz | 18,417 | `63f21b02eb0bec99ce52c392380558e2704d79652f1048423df9075c7e687fa6` |
| doca-deploy-v0.2.22.tar.gz.sha256 | 93 | `46adc1bbef9ab65d2db61296ddbbc968d2609da6e2aa53b7bd8fba4d84fcac9f` |
| doca-web-assets-v0.2.22.tar.gz | 17,165,064 | `bc426d42db861cfb5dc52b66005c93245fbf51dbc618c37f9ff2bb7e13261945` |

临时 Docker Hub 发布 secrets 已删除并复核不存在，未保存凭据值。运行日志、JSON、下载与截图保存在忽略目录 `artifacts/verification/release-0.2.22/` 和 `artifacts/verification/annualreviews-production-2026-10-26/`。

## 原站点验收通过

原站点的真实故障已由扩展 0.2.9 显示为暂存任务已满。用户升级服务端并重新加载扩展后，`/health` 确认为 **0.2.22**；扩展 **0.2.10** 的 114 个运行文件已更新并核对到原安装目录，连接配置保留。

在真实 Chrome 中收录 Annual Reviews 原页面，插件直接显示保存成功，不需要手动清理暂存任务。一张站点 SVG Logo 处理失败，当前提示列出该项，文档保留带原始来源链接的占位。打开及刷新生产文档后，1,525 个内容块、139,155 个文本字符一致，正文末尾和参考文献保留，九张图片全部正常加载；两张正文图已实际可见核对。生产收录、打开和刷新验收通过，详见[实际验收记录](clipper-automatic-recovery-2026-10-26.md)。
