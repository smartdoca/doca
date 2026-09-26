# 文档任务回归与整改记录

本轮针对 Doca 的意图提示、工具执行和交付验收。使用隔离测试数据库、临时文件及模拟模型/网络响应，不修改用户文档。测试通过不等于真实模型成功率、真实网站可用性或视觉质量已达标。

## 场景矩阵

| 场景 | 覆盖与验收证据 | 测试入口 |
| --- | --- | --- |
| 调研与网页读取 | 正文/引用提取、跳转、正文截断、登录失败、内网限制、取消 | ai-web-fetch、ai-web-request、ai-tool-examples |
| 生成报告与文档 | 创建幂等、保存回执、缺少回执不得宣称成功、五种原生格式工具循环 | ai、ai-delivery |
| 制作 PPT | 原生页面/元素、链接保存、读取大纲和尺寸 | ai、presentation、ai-links、ai-document-read |
| 文档样式优化 | 标题/列表/表格/链接转换、保留块标识、非法操作明确报错 | ai-links、ai-edit-tools、ai-edit-normalize |
| Markdown、表格与画布 | 原生格式编辑、表格坐标纠错、画布非法元素原子拒绝 | ai、editor-tools、ai-document-read |
| Office 文件交付 | Word/Excel/PDF/Markdown 创建和重新抽取，附件图片顺序 | ai-office-files、ai-attachments |
| 文件与文件夹搜索 | 搜索过滤/权限、系统目录、文件位置、现有文件交付卡片 | search-*、ai-file-locations、files、ai-delivery |
| 移动、复制与重命名 | 文件生命周期、目录递归复制、重复名称、只读系统目录 | files、ai-file-locations、capability-files |
| 下载资源到文件夹 | 二进制下载、下载名处理、大小限制、存储回滚和访问权限 | ai-web-fetch、files、upload-storage |
| 多轮意图变化 | 同一轮后续指令覆盖前面的文档取消决定、复制/移动区别于发送 | ai-delivery |
| 交付验收 | 每项标准、完整回读、独立验收、有限修订、待澄清停止 | ai-delivery、ai |
| 恢复、取消和权限变化 | 重试输入保留、创建不重复、撤权、会话范围、任务取消 | ai、ai-checkpoint、ai-context-budget |
| 知识问答 | 发布快照、成员读取与管理权限分离 | knowledge-records、knowledge-studio |

表中是自动化覆盖，不代表每项已经进行真实模型和浏览器端到端测试。尤其 PPT/样式只做结构验证，未进行逐页截图视觉验收；下载到文件夹的下载、存储与目录操作分层覆盖，未测所有真实站点。

## 本轮修改

1. 意图手册提示补全「创建/生成/制作文档」「优化文档样式」「画布」表达。仅增加提示，不裁掉工具。
2. 文件复制/移动不再因「把这个文件」误判成发送已有文件，避免不必要的交付卡片修订。
3. 文档和幻灯片标题改名不再要求文件夹回执；文件夹移动成功声明加入校验，同时区分文件移入文件夹。
4. 同一用户消息先取消、后恢复文档保存时，采用最后一个明确分句的决定。
5. 验收标准存在相互矛盾的检查时，missingReviewCriteria 保持该标准未解决。执行器原有的全项 passed 校验继续保留。
6. 下载名支持 UTF-8 扩展字段中的语言标记；普通 filename 保留字面百分号；纯点号名称使用安全默认名。
7. Firecrawl 调用之前检查取消；调用中取消或本地等待超时立即停止等待，移除事件监听。SDK 本身未提供此处可用的取消参数，因此不承诺远端已停止处理。

基线知识检索测试暴露出发布时序问题：审核条目写入文档后，问答使用另外发布的快照。当前工作区另一路修改已补入显式 publication 步骤，本轮确认该测试独立复测通过，未恢复旧检索逻辑。

## 重跑

```sh
pnpm exec vitest run --maxWorkers=4
pnpm typecheck
pnpm build
```

针对本轮新增回归：

```sh
pnpm exec vitest run tests/ai-delivery.test.ts tests/ai-office-files.test.ts tests/ai-web-fetch.test.ts --maxWorkers=2
```

## 仍需真实环境验收

固定模型、模型配置、网页夹具和隔离文档，逐场景记录首轮成功率、最终成功率、工具失败次数、修订次数、总调用数和耗时。等待审批、缺少用户信息、取消和失败单独记录，不能归为成功。现有 scripts/qa-ai-delivery.mts 包含真实模型验收思路，但其服务启动脚本仍需与当前配置接口核对，不能把模拟测试统计当成真实模型指标。

优先补充完整流程：调研→引用→报告→导出→指定目录；资料搜索→选择→移动→目标回读；PPT 生成→逐页渲染→版面检查；批量下载→部分失败→仅重试失败项。这些需要独立运行记录，不能仅靠增加提示词宣布完成。
