# Doca 0.2.20 发布验收

2026-10-26 完成发布验收。Doca **0.2.20**、扩展 **0.2.7** 与升级提示改动已由 [PR101](https://github.com/smartdoca/doca/pull/101) 一起交付。正式 tag 固定指向 `a5ddb7995c23a0064a6e34aa09f976da45446fc4`，本回执不移动 tag。

## 实际收录与回归

通过用户 Chrome 的真实浮动工具条收录 Annual Reviews 原页面，在隔离实例中保存、打开并刷新：正文和三张正文图保留；两个 SVG 标识与三个广告 iframe 留下占位，插件显示五项当前处理问题。原生内容刷新前后哈希相同，扩展连接已恢复原站点及账户。见[实际网页验收](annualreviews-capture-2026-10-26.md)。

正式 npm `@smartdoca/slate 0.4.26` 修复引用括号、图片说明及美元文本的转换问题，见 [Slate PR18](https://github.com/smartdoca/slate/pull/18) 和 [0.4.26 Release](https://github.com/smartdoca/slate/releases/tag/v0.4.26)。Doca 对转换异常保留可读内容或原始文字，对不兼容图片和嵌入内容保留占位；授权、配额及实际存储失败仍返回失败。没有新增数据库报告列、持久化字段或协议版本。升级提醒和版本化下载见[浏览器验证](browser-extension-updates-2026-10-26.md)。

最终全量执行为 3,404 项通过、11 项跳过，另有一项大 PNG 检查在并发下超时；该文件独立复跑 13 项全部通过，未放宽超时或修改该检查。类型检查、正式 npm 来源核对、完整扩展/Canvas/Web 构建与双语文档检查通过。[PR PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40262215336)、[主分支 PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40262603137)及[文档部署](https://github.com/smartdoca/doca/actions/runs/40262603139)全部通过。

## Docker Hub

[原生双架构流水线](https://github.com/smartdoca/doca/actions/runs/40262646447)全部通过。两个架构分别验证转换降级后保存、坏图占位、当前警告、原图字节、扩展下载、登录/退出/撤权，以及沙箱 PDF、Canvas 像素和 DOCX/XLSX 转 PDF，模型调用为零。每架构 **573 个运行文件、484 个 Web 文件和 9 个编辑器文件**与最终本地完整构建逐字节一致。本地核对前重新完整构建，更新了此前尚未按最终依赖生成的扩展目录。

发布后独立读取公开 Docker Registry 索引、子 manifest 和 config，验证原始字节摘要、架构、版本与源码标签。[Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) 的 `0.2.20` 和 `latest` 均为：

`sha256:fb6f9610341949bf0594579a30fc0b6dcc7c78e1e6b5f050ec05c3a99169e0b9`

| 架构 | manifest 摘要 | 完整压缩层字节 |
| --- | --- | ---: |
| amd64 | `sha256:7930242eed2427a2740ccaa2ed653abe9b16f4b48fe78ba02b03e3ce18dd3be4` | 707,948,289 |
| arm64 | `sha256:bc2fdc3e94b847824d7f2c90224e78b2f3a13dfad74408b0c41951d09caab636` | 704,748,652 |

## GitHub 附件与收尾

[GitHub Release](https://github.com/smartdoca/doca/releases/tag/v0.2.20)及其[流水线](https://github.com/smartdoca/doca/actions/runs/40262629676)成功。三个公开附件实际下载后，大小和 SHA256 与 GitHub 元数据一致；479 个 Web assets 文件及部署包中的 10 个允许文件与最终本地构建一致，部署包校验文件正确。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.20.tar.gz | 18,420 | `870e109e6fe9fd7e70894986de6739365d33e9548d7246544cfe6e60c96e972f` |
| doca-deploy-v0.2.20.tar.gz.sha256 | 93 | `c796857d9e76ae3b9908dfe3318ad82093f8e61fbfdae8c7c1fca414b19a093e` |
| doca-web-assets-v0.2.20.tar.gz | 17,166,213 | `a00d976eea745b71a662c966d670228523383158bf3f7b80b306be0db2821c6d` |

临时 GitHub Docker Hub 发布 secrets 已删除，并复核仓库 secrets 列表为空，未记录凭据值。原始日志、下载、JSON、截图及隔离实例保存在忽略目录 `artifacts/verification/release-0.2.20/` 和 `artifacts/verification/annualreviews-capture-2026-10-26/`。

本回执确认 GitHub/Docker Hub 制品发布，没有部署用户生产站点。新收录行为需要服务端 **0.2.20** 与扩展 **0.2.7** 一起使用；历史失败页面重新收录，保留既有文档、图片、数据库、凭据和到期规则。
