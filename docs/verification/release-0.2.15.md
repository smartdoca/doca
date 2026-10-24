# Doca 0.2.15 发布验收

2026-10-24 完成发布验收。Doca **0.2.15** 已发布到 [GitHub](https://github.com/smartdoca/doca/releases/tag/v0.2.15) 和 [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags)。正式 tag 固定指向 `2430151615083095d8b5b0325003780ebfff7846`，[PR93](https://github.com/smartdoca/doca/pull/93) 已合并；此回执不移动正式 tag。

## 位置选择与回归

收录方案的创建位置使用与文档移动一致的树形展示，可选个人文档、知识库根目录及具体文档下方。知识库单独分页，展开时加载库内完整层级；重新打开方案时展开上级并定位已选位置。创建采用既有编辑权限，移动的管理权限要求不变；只读上级保留在树中，失效位置阻止保存。目录加载失败明确重试，保存失败保留输入和选择。

- 15 项定向测试通过，覆盖层级、不同操作权限、分页、保存与恢复、失败重试和切换追加方式。
- 全量回归为 325 个文件、3365 项通过，3 个文件及 11 项按配置跳过，无失败，耗时 240.51 秒。
- TypeScript、正式 Web/扩展/Canvas 构建、编辑器 npm 来源、90 页双语文档和部署打包通过。
- 最终正式构建在真实 Chromium 与隔离 SQLite 中连续三轮通过。每轮创建 102 个知识库、105 个最近文档和三级目录，复现旧混合首页没有知识库，再从实际设置页保存个人文档、库根及三级文档下方，刷新恢复、模拟加载失败和保存失败并重试，最后提交真实收录请求，核对新文档的知识库与父文档 ID 均等于选中位置。
- 100%、390px 及原生 200% 验收通过。自动化等待已保存目录加载、定位及虚拟行重绘后再点击，避免使用已被替换的节点。主 Agent 自行看图，额外等待有限动效完成核对桌面选择状态；局部控件复用既有移动样式，没有另行独立评审。没有使用用户文档或付费模型。
- [PR PostgreSQL 17/18](https://github.com/smartdoca/doca/actions/runs/40054084801) 和[主分支矩阵](https://github.com/smartdoca/doca/actions/runs/40054397640) 全部通过。

交互与边界见[位置树验收](clipper-destination-tree-2026-10-24.md)。沿用既有目录接口的 10,000 节点上限并在截断时提示。

## 镜像与公开索引

[原生双架构及发布流水线](https://github.com/smartdoca/doca/actions/runs/40054423942) 全部通过。每架构验证 UID1000、登录/退出/撤权、小图原始字节、沙箱 PDF、Canvas 真实像素和 DOCX/XLSX 转 PDF。571 个运行文件、483 个 Web 文件及 9 个编辑器入口/清单与 tag 源码构建一致。发布后另核对两个架构全部 483 个 Web 文件和扩展 8 个关键文件的哈希，与本地正式构建一致。

以只读 Docker Registry HTTP API 重新读取公开索引、子 manifest 和 config，核对原始字节 SHA256 及 Docker-Content-Digest。`0.2.15` 和 `latest` 均为：

`sha256:3b4b756efa7f838e27e0a328d5a14e6c1d4e6cf466a8d4be5b6e2d6311b3fd93`

| 架构 | manifest 摘要 | 完整压缩层字节 | 保留 0.2.14 时新增唯一层字节 |
| --- | --- | ---: | ---: |
| amd64 | `sha256:e2fe3f81a84efbb121e634fa3e0d7e0669b37cb610f75ead894c2587e79b98c4` | 707,936,592 | 9,532,701 |
| arm64 | `sha256:8dc617ed99cc198223053988650e99ede3eba445cfaada20ea43ed2d2677fe68` | 704,738,232 | 9,532,653 |

增量以前版同架构镜像层仍在本机为前提，仅计缺少的唯一压缩 blob，不含 manifest/config 和传输头部；首次拉取需要完整镜像。未删减 Chromium、Office、字体或编辑器功能。

## GitHub 附件

[Release 流水线](https://github.com/smartdoca/doca/actions/runs/40054419521) 成功。三个公开附件实际下载后，大小和 SHA256 与 GitHub 元数据匹配；Web 的 478 个文件、部署包的 10 个允许文件与本地正式构建逐字节一致，校验文件正确。部署打包使用 `COPYFILE_DISABLE=1`。

| 附件 | 字节 | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.15.tar.gz | 18,421 | `e487aba1492cd35f92c1d3901ef972238d1db046611fee9c64d52b708fca8128` |
| doca-deploy-v0.2.15.tar.gz.sha256 | 93 | `d31a131c3211d257f99e839693bf87493ae14ceeffd0e03888366711a4959601` |
| doca-web-assets-v0.2.15.tar.gz | 17,157,048 | `9407ddc1e88728e358a084debd0a2fe0cb8ff178a54148f73fb6e9ded02984bc` |

临时 GitHub Docker Hub 发布 secrets 已删除，并复核不存在，未记录凭据内容。原始日志、下载、SQLite、浏览器存储、截图及 JSON 位于忽略目录 `artifacts/verification/release-0.2.15/` 和 `artifacts/verification/clipper-destination-tree/`。

## 更新范围

本次修改 Doca 设置页，浏览器扩展功能版本仍为 **0.2.3**。更新 Doca 后刷新「浏览器助手」设置页即可使用位置树。没有改变方案字段、资源接口、数据库结构、队列、编辑器 SDK 或扩展协议，没有转换、删除、回填或自动改写历史方案及内容。

此回执确认 GitHub/Docker Hub 制品发布，未部署用户的生产站点。
