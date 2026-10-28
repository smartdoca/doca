# Doca 0.2.24 发布验收

2026-10-29 完成制品发布。[PR112](https://github.com/smartdoca/doca/pull/112) 已合并，正式 tag `v0.2.24` 固定指向 `c3f4b54b713b506c076b044e6929027f1307e0c7`；浏览器扩展为 0.2.10。

系统 Logo 使用用户确认的 `settings.site_logo` nullable 新增列方案，表格评论定位修复考虑冻结区域可见像素。功能、数据保留和回退范围见 [Logo 验收](site-logo-2026-10-28.md)、[表格验收](sheet-comment-freeze-2026-10-28.md)和[发行说明](../releases/0.2.24.zh-CN.md)。SQLite、PostgreSQL 17/18 均以实际发布版本 0.2.23 创建的数据库升级，保留全部 131 张表的原有行，复启、并发及拒绝前无部分写入检查通过。

全量测试 3,453 项通过、11 项跳过（332 个测试文件通过、3 个跳过），类型检查、生产构建、编辑器 npm 来源检查、部署包和文档检查通过。[主分支数据库回归](https://github.com/smartdoca/doca/actions/runs/40720397973)及[文档检查](https://github.com/smartdoca/doca/actions/runs/40720398580)均成功。

[原生镜像发布流水线](https://github.com/smartdoca/doca/actions/runs/40720540500)的 amd64、arm64 及发布作业全部通过，包含 Logo 配置/读取/重置、管理员和修订冲突验证、原图、授权、渲染及运行文件检查。每个架构匹配 578 个运行文件和 483 个 Web 文件。独立匿名读取公开 Registry，复核索引、子 manifest、config 的原始字节 SHA256、架构及源码标签。

[Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) 的 `0.2.24` 与发布时的 `latest` 均为：

`sha256:7037d51725a72c810789cc088e098ccd7b09860dfa97175111b34da2e7e838de`

| 架构 | manifest SHA256 |
| --- | --- |
| amd64 | `369619f8fdb4feef6bdc40f72b42912b53579b0d74ba2e1af4fb760da38d22a7` |
| arm64 | `98de6cb1aa856fcaaeacbbaef0424b7bbf01bd66825e68b587e8d6f816fa3c3c` |

[GitHub Release](https://github.com/smartdoca/doca/releases/tag/v0.2.24)及其[流水线](https://github.com/smartdoca/doca/actions/runs/40723530515)成功。三个附件已下载，大小及 SHA256 与公开元数据一致。478 个 Web assets 文件与镜像验收构建一致，部署包 10 个文件与本地包内容一致（本地 macOS AppleDouble 元数据不参与比较），校验文件正确。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.24.tar.gz | 18,556 | `4fab2b8f9f4c6e5166d80e3942bfb2875680905b2e40b4f96ef17e4a1e1aa128` |
| doca-deploy-v0.2.24.tar.gz.sha256 | 93 | `37488ad68301956fdcb5b4458b200b92ed01b02e0adaf2c1ff20e03d4339cca3` |
| doca-web-assets-v0.2.24.tar.gz | 17,178,739 | `8f974d68037accaf623936c2f696b4e031b711835ba71c92ef4eed76b8ec3bd2` |

临时 Docker Hub 发布 secrets 已删除并复核不存在；未保存凭据值。下载、日志、截图和 JSON 保存在忽略目录 `artifacts/verification/release-0.2.24/`。本次未部署运行中的 Doca 站点。
