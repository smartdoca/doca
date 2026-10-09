# AI 长任务性能

速度应按实际请求、工具和交付事实衡量。隐藏界面的思考摘要不会减少服务端推理；降低思考强度也不能代替真实图片验收，或把未确认的请求当作免费请求。

## 当前定向运行请求

当前宿主对显式 `provider=doubao` 的以下已确认型号默认发送 `reasoning_effort: low`：

- `doubao-seed-2-1-pro-260628`
- `doubao-seed-2-1-pro-260915`
- `doubao-seed-2.1-pro`，仅用于官方 `https://ark.cn-beijing.volces.com/api/plan/v3` 或 `/api/coding/v3` 计划端点；不猜测 alias 对应的日期版本。
- `kimi-k3`，仅用于官方 `https://ark.cn-beijing.volces.com/api/plan/v3`；其他 Kimi 型号、厂商、地址和部署 ID 不据此推断。

日期版本使用官方 Model ID 的连字符拼写；不将带小数点的日期名称自动转换为已知型号。[官方模型参数表](https://docs.volcengine.com/docs/ark/model-parameter-support?lang=zh)

这是运行请求参数，不新增持久配置、补旧记录或迁移数据。当前 `@ai-sdk/openai-compatible@3.0.48` 的宿主 namespace 为 `doca`，`providerOptions: { doca: { reasoningEffort: "low" } }` 实际序列化为顶层 `reasoning_effort: "low"`。已有显式 `reasoningEffort`、顶层 `reasoning` 或 `doca.thinking` 保持原样；其他厂商、未知型号、未知计划地址也保持原请求。原始用量、费率快照和 pending 状态不改写。

新默认参数不进入既有的思考摘要自适应变量；端点拒绝它时直接报错，不会自动去掉参数重试。当前已有的 Responses→Chat、拒绝可选摘要参数后的适应行为没有在这次修改中改变，也不扩展到该豆包参数。安装 SDK 的弃用 namespace 读取仍是原库行为，没有新增旧配置 reader。

豆包官方说明 Seed 2.1 默认高思考；`low` 保留轻量思考，`minimal` 关闭思考。宿主**不默认** `minimal` 或 `thinking.type=disabled`。`disabled` 与 `low` 同发是非法组合，显式思考设置因此不会再被追加低思考默认。`providerOptions.doca.reasoning=false` 只是既有内部开关，不能声称它关闭了 Ark 思考。[深度思考参数](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh#fc5eac89)、[组合规则](https://docs.volcengine.com/docs/ark/context-management?lang=zh#480730d0)

当前计划端点和模型 alias 有官方 OpenCode/AI SDK 接入示例，但本地 mock 验证只证明请求格式，不是这个计划端点的速度或质量测评。[Agent Plan 接入](https://docs.volcengine.com/docs/ark/agent-plan-enterprise-opencode?lang=zh)、[Coding Plan 接入](https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-opencode?lang=en)

Kimi K3 始终启用思考，原生 `reasoning_effort` 支持 `low`、`high`、`max`，默认 `max`。定向设置 `low` 保留思考，不发送关闭思考参数。当前 compatible SDK 在下一轮原样传递助手的 reasoning 内容与工具调用；工具结果仍绑定原工具调用 ID，不把思考摘要改写为工具结果。场景分析与独立验收使用管理员配置的完整 `maxOutput`，不再按照 JSON 字数额外截断；额度、超时、截断和非法报告均不能作为图像通过证据，也不触发去参数重试。该规则不新增配置字段或迁移历史模型、任务、费用、图片；回滚代码仅撤去新请求默认，已有数据保留。[Kimi K3 官方调用说明](https://github.com/MoonshotAI/Kimi-K3/blob/main/README.md#6-model-usage)

## 输出限制和用量事实

独立图片验收已规划完整原生细节检查时，全局检查中的原图与成品前两帧使用最长边1600、JPEG Q92、4:4:4构图预览。身份参考继续使用PNG，后续全画幅重叠细节块继续使用原生尺寸无损PNG；没有原生细节后续计划的小图也保持完整PNG。预览明确标为有损，不能作为像素不变的证据。实际传输只接受本次宿主生成并登记摘要的前两帧JPEG，不转换未知参考图，也不改变原文件或交付图片。

2026-10-06的隔离直连运行已记录一次全局检查请求为1,675,022字节，随后两次原生细节请求仍分别约11.4MB与10.1MB。这些是该页的实际请求体大小，不是同一页面压缩前后的速度对照；仍须记录全部细节验收结果与返修次数，不能仅凭全局请求变小宣称任务交付率提高。

独立图片验收对已确认型号的官方 Ark 端点，通过当前 SDK 的 `providerOptions.doca.response_format` 原生请求参数发送 `json_schema`、`strict:true` 和本次全局或细节报告的 Schema。每个嵌套对象明确必填字段及 `additionalProperties:false`，检查 ID 和分块 ID 按本次宿主清单枚举，授权字段为对象或 `null`；只发送官方支持的语法子集，不把 Zod 的长度、正则等限制直接发送。当前 compatible SDK 的默认能力为 false，单独提供通用 `responseFormat.schema` 仍会发成 `json_object`，所以不使用这一无效路径，也不更改适配器能力列表。宿主仍解析完整原文，严格核验覆盖数量、重复 ID、通过判决一致性、字符串和数字界限、正式授权原文与真实图像；不会拼接、修剪非法输出或接受 SDK 部分对象。未知厂商、型号和地址维持原请求，参数被拒绝时不降级、不自动删除并重试。隔离 Plan 单次协议探针已确认 `json_schema/strict:true`、完整 stop 回复和实际用量登记；它不证明图片质量或整批交付通过。[官方结构化输出说明](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=zh)

当前兼容 SDK 将 `maxOutputTokens` 映射为 `max_tokens`。Seed 的该字段限制回答，**不限制原始思考**；不能把 `maxOutput=12000` 当作 12,000 个回答与思考总 token 的上限。`max_completion_tokens` 才限制二者总量，与 `max_tokens` 互斥。本次不改变原输出字段或预算，不把两个字段一起发送，也不通过缩短坐标或完整验收结果来提速。[官方长度控制](https://docs.volcengine.com/docs/ark/context-management?lang=zh#3cb3d444)

供应商明确返回的 `usage.completion_tokens_details.reasoning_tokens` 是原始思考 token，不是可见摘要长度。思考通常已包含在输出总量里，不能再加一次；缺失值保持未知。本次只读诊断发现当前账本原始 `usage.raw.raw` 已保留该事实，但汇总 `providerMetrics.reasoning` 未读到当前 SDK 嵌套结构。这次性能参数修改不改用量 reader 或历史数据。[官方原始思考与摘要说明](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh#8cfd447b)

正式请求正文按原文完整发送，job、消息、提问回执及作用域规则作为独立nonCitable宿主资料，不进入可引用正文。原生细节报告提供allowedAuthorizationQuotes短选项表，每项最长240个UTF-16单位，优先按原换行或句末边界分段，其余长句连续切块；保留标点、空格、CRLF及完整代理对，忽略纯空白段。请求索引与该纯正文片段在本次 Schema 中绑定，模型只能逐字选择实际相关选项，不另加标点、改写UUID或引用宿主资料。原始任务全文仍完整发送；短选项只证明出处，不证明差异已获授权，最终仍核验真实变更与原文含义，原有1000单位回复字段界限和全部严格检查保留。

原生细节每次核对一个完整分块，发送512全页原图/成品定位及该块原生原图/成品共四帧PNG。全部重叠分块仍逐块核验，最长边1536，不抽样或缩小；最多16块、16次细节调用。1500×2000页面为2块、2次，1780×2357为4块、4次，另计全局及身份组实际调用；任一块失败即停止追加细节费用，已发生的用量照实保留。

全局与原生细节验收使用相同的当前来源范围及完成门禁说明。整批数量、来源覆盖和全部页的验收由宿主另验，当前块仍检查所有适用的逐页子条件；纯整批条件或有真实依据的不适用条件须写明范围，不能以它们缺少整批证据为由拒绝当前合格块，也不能跳过可见变化或复合标准中的本页条件。`passed`仍是现有布尔字段，矛盾的`pass`与`false`回包继续严格拒绝，不转换、补值或改写判决。

## 只读样本和验证边界

2026-10-06 05:44:28（上海时间）的隔离任务快照如下，活动任务后来新增的请求不在此样本中。耗时为调用记录创建到结算的时间，包含服务等待和结算；不是独立测得的首 token 延迟。仅统计 confirmed 聊天请求，不能将 pending/reserved 的零占位值解释为实际零用量。

| 样本               | confirmed 聊天请求 | 请求耗时合计 |   中位数 / P90 | 输出 / 原始思考 token | 思考占比 |
| ------------------ | -----------------: | -----------: | -------------: | --------------------: | -------: |
| 当前 A `40e82fc7…` |                 12 |     348.9 秒 | 12.3 / 86.0 秒 |        11,895 / 9,906 |    83.3% |
| 旧 A `06146a47…`   |                 41 |   1,572.8 秒 | 26.4 / 88.3 秒 |       59,255 / 42,995 |    72.6% |
| 当前 B `fc8de66f…` |                 22 |     540.3 秒 | 19.4 / 35.6 秒 |        23,483 / 9,040 |    38.5% |

旧 A 的一次 216.8 秒请求输出 7,044 token，其中 6,135 是原始思考。其整个调用记录窗口约 35.6 分钟，41 次聊天占约 26.2 分钟，另一次真实图片请求约 40.9 秒；即使聊天时间完全消失，图片请求及其他工具/等待间隔仍在。B 另有一个 306.1 秒 pending 请求，其耗时和实际用量未知，不能据此确认是思考慢或免费重试。

这些数据说明重复高思考值得定向优化，但不能预测 `low` 必然快几倍。缓存已大量命中仍出现长思考；缓存优化主要减少输入计算，不等于减少本轮推理。实际提速仍须用相同任务、完整页面和验收要求对比总时间、思考 token、失败/返修次数及交付结果。分割、几何、模型等待、非目标细节核对都可能成为剩余瓶颈。

隔离 SDK 测试覆盖真实请求序列化、流式 usage、显式选项优先、未知厂商/型号保持原请求，以及 400/422 只调用一次。它们不调用真实模型，不证明图片质量已经通过。独立验收的原要求、全页与原生细节 PNG 覆盖、人物/文字/背景标准及费用未知时的保护仍执行；不能为了速度减少这些检查。
