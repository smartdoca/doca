# 知识册验收策略与人工放行验证

本次验证使用合成账号、隔离 SQLite/PostgreSQL 测试库及故意包含单位换算错误的短篇候选。未重跑此前暂停的长文，也未修改或批准用户原知识册。此处记录发布前的隔离验证；发布制品见 [0.1.28 发行记录](../../releases/0.1.28.zh-CN.md)。

- 验收遵循冻结配置的描述及明确例外，验收项 ID 不隐含固定策略。真实模型三个单断言对照分别验证严格来源要求拒绝、准确常识获准、错误算术仍被拒绝，见 [real-model-policy-results.json](real-model-policy-results.json)。这不是整册内容正确性证明。
- 人工放行要求有效负面验收结果、可访问的候选及明确处理意见。页面二次确认后，同一候选进入后续发布审批；模型的失败 checks 与节点失败状态保留，人工决定进入审计及成果溯源。参见[确认页面](manual-acceptance-confirm.png)、[后续发布审批](publication-review.png)、[发布阅读页](published-reader.png)。
- 验证空意见、重复批准、配置/输入变化、批准者失效和决定哈希失效拒绝，技术失败不能放行；取消后续跑复用有效人工决定，正文无需重新生成。
- 非 Error 的 SDK 流错误经现有安全分类器处理，鉴权失败不重试、临时服务错误有限重试，不把厂商正文或请求头写入知识册错误。
- 服务关闭后，新进程读回的成果哈希相同，见 [cold-readback-results.json](cold-readback-results.json)。已发布的 0.1.27 镜像能读取同格式成果和人工决定，见 [old-release-read.json](old-release-read.json)；旧执行器不支持新放行流程。

全量回归 2898 项通过、8 项跳过；专项 156 项通过；PostgreSQL 17/18 各 58 项通过。类型检查、Web 构建及 69 页双语文档检查通过。

统计与验证范围见 [report.json](report.json)。配置、流水线及成果保持 version 1；新增决定只写入现有 resolution，不更改 SQL 结构或转换旧数据。原始模型配置、密钥、会话和测试数据库均不在本目录。
