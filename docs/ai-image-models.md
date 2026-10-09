# 图片模型适配器

核对日期：2026-10-05。支持清单、协议适配器、三个工具、配置保存和管理界面均已接入。代码变更不自动修改运行中服务或真实账号配置；旧图片模型按用户同意的默认值处理。

## 工具与模型

厂商适配器保留三个明确的操作；成品续改复用 `edit`，独立校验底图与冻结原页：

| 工具 | 输入 | 意图 |
| --- | --- | --- |
| `image_generate` | 提示词，不接受图片 | 文生图 |
| `image_reference_generate` | 提示词、至少一张参考图 | 参考图生成新图 |
| `image_edit` | 提示词、明确的 `sourceImageId`，可选附加参考图 | 修改已有底图；可选局部编辑范围 |
| `image_edit_saved` | 冻结原页 `originalReferenceImageId`、本页当前 `baseAssetId`、提示词、附加参考 | 在批次 v4 当前成品上继续整页修改，保留已有成果；复用 edit 模型 |

局部编辑继续使用宿主的选区预览、原始候选、蒙版合成及保护像素机制，不额外拆出付费工具。参考图生成不接受底图局部选区或底图裁切参数。

保留一个默认 `imageModel`，仅在需要不同模型时设置可选的 `imageToolModels.generate/reference/edit`。选中的模型不支持该操作时明确报错；不自动挑选其他模型、修改请求意图或尝试另一个接口。

模型先从代码中的支持清单选择 `imageProfile`，再填写厂商实际调用标识 `model`。通常两者相同；火山部署 ID 或网关别名可以不同，但必须明确对应一个已实现的模型规格。接口和能力由厂商连接类型加所选规格确定，不根据部署 ID、别名或字符串正则猜测。没有适配器的图片规格不能新增或保存。

管理界面的厂商、用途、图片规格和工具模型均使用可搜索的组件下拉框；文本、密码和数值分别使用组件库输入，编辑使用项目弹框，移除配置使用气泡确认。图片模型表单只显示按张数计费的参数。所有保存错误在界面内反馈，不使用浏览器原生确认框或校验提示。

## 已实现的协议

### 本机 MFLUX 图片协议 v1

2026-10-08 用户同意新增本地适配器。显式规格 `mflux-flux2-klein-9b-q8-v1` 对应实际型号 `flux2-klein-9b-8bit`，支持文生图、参考图生成和编辑；`mflux-qwen-image-edit-2511-q8-v1` 对应 `qwen-image-edit-2511-8bit`，只支持参考图生成与编辑。连接使用 `compatible`，但由规格选择独立 `mflux-native-v1` 适配器，不走 GPT Images，也不根据部署别名猜测。新型号和规格缺少显式 profile 时拒绝，现存其他型号的已批准默认读取不扩展。新增规格以单张、最多八张有序参考、16 对齐、每边128至2048、256²至2048²像素和最高4:1比例作为当前宿主范围。

`scripts/local-models/mflux-image-server.py` 仅监听127.0.0.1，使用独立私钥及已核验文件清单启动。服务固定 MFLUX 0.22.0，FLUX 为9B蒸馏版4步、Qwen Edit为2511版30步、量化8-bit。启动重新核对全部权重文件哈希和固定上游 revision；只读取明确配置的本地模型，不自动下载、转换模型、安装LoRA或切换执行器。并发1，采用512像素分块VAE解码，并在阶段间释放文字编码器、图片变换器和缓存。每个请求重新加载明确的模型权重，避免复用已经释放模块的实例。依据 [MFLUX FLUX.2](https://github.com/mflux-community/mflux/blob/main/src/mflux/models/flux2/README.md) 与 [Qwen Edit](https://github.com/mflux-community/mflux/blob/main/src/mflux/models/qwen/README.md)。实际多参考人物一致性、文字与场景保留仍须视觉验收。

客户端只向配置地址的 `/v1/images` 发一次JSON POST，明确 `version:1`、profile、model、operation、画幅、`n:1`及有序图片字节/MIME/SHA256；第一张是编辑底图。拒绝未知版本、缺字段、图片URL、蒙版、非法/透明/多帧参考以及型号错配，不提供旧协议读取、字段补值、接口回退或重新生成重试。本地使用由调用方取消信号控制的HTTP传输，避免通用fetch在等待响应头时独立触发五分钟超时；请求上限15分钟，其他适配器的3分钟上限不变。取消或中断仍保留实际后台结果及宿主待核对记录，不将请求改报为未执行。新增请求写入独立运行记录，成功后记录实际输出哈希，异常时保留失败类型及已经写出的文件，不修改此前请求记录。

完成回复必须包含唯一完整PNG、实际尺寸与SHA256、按顺序的输入SHA256、真实请求ID、实际图片计数和运行用量事实；宿主逐项匹配本次输入，核对PNG头及完整解码后保存。原生 `usage.runtime` 保留MFLUX版本、上游revision、步数、seed和实际耗时。该服务未报告文字token数量；通用图片DTO中的token零占位不代表观测到零token消耗，原始usage没有补写文字token。本机隔离配置的输入、输出和图片费率显式为0，生成请求仍进入次数、幂等及验收流程，不能因本地运行跳过验收。

现有配置、数据库、消息、文件、任务、候选和费用不迁移、不删除、不重置。已有候选协议枚举扩展为可接受新 `mflux-native-v1`；新配置须显式选择规格，回滚旧代码会拒绝新增规格及其候选，但原数据保留。当前仅新建隔离本机验收环境；单次真实文生图协议已返回PNG，接口测试和回归通过不代表两组95页整批通过。

启动示例：

```sh
python -m pip install -r scripts/local-models/requirements.txt
python scripts/local-models/test_mflux_image_server.py
python scripts/local-models/mflux-image-server.py --models /absolute/models-v1.json --key-file /absolute/private-service-key --output /absolute/private-artifacts --port 39365
```

模型清单形状为 `{version:1,models:[{profile,model,directory,model_revision,verified_files:[{path,size,sha256}]}]}`。服务密钥与清单保存在受保护的本机目录，不放入源码或镜像。oMLX继续负责独立的聊天与视觉语言推理，不将聊天接口当作图片生成接口。

支持清单位于 `packages/core/src/modules/ai/image-model-catalog.ts`，请求与响应转换位于 `apps/server/src/services/ai/image-provider-adapters.ts`。

| 厂商连接 | 模型规格 | 能力 | 请求 |
| --- | --- | --- | --- |
| 火山 `doubao` | Seedream 4.0、4.5、5.0 Lite/Pro/Flash 的清单版本 | 三项操作 | JSON `/images/generations`；图片为 data URL；单图输出 |
| 千问 `qwen` | Qwen Image 3.0 Pro、3.0、2.1 Pro | 三项操作 | JSON `/compatible-mode/v1/images/generations` 扩展；参考图放 `image` 字段 |
| 千问 `qwen` | 显式 `wan2.7-image-pro` | 三项操作 | 同配置主机的 `/api/v1/services/aigc/multimodal-generation/generation`；独立同步 native adapter，消息内容依序传图片与提示词 |
| 千问 `qwen` | Qwen Image 2.0 / 2.0 Pro 的清单版本 | 三项操作 | 原生同步 multimodal-generation 接口 |
| 千问 `qwen` | Qwen Image Max / Plus / Image 的清单版本 | 文生图 | 原生同步接口；只接受清单中的五种尺寸 |
| 千问 `qwen` | Qwen Image Edit Max / Plus 的清单版本 | 参考图生成、图片编辑 | 原生同步接口；需要输入图片 |
| OpenAI `openai` / `compatible` | GPT Image 1、1 Mini、1.5、2、2.5 Sunburst/Flare 的清单版本 | 三项操作 | 文生图为 JSON generations；参考图和编辑为 multipart edits；可用原生 mask |

准确模型 ID、允许的操作和尺寸以支持清单为准。自建 OpenAI 兼容网关仅声明上述 Images 协议；网关是否实际部署对应模型仍须管理员核实。聊天接口兼容不表示图片编辑接口兼容。

Wan 2.7 Pro 必须显式选择对应 profile；只有型号、没有 profile 的配置拒绝，不从既有配置默认链路推断。首版统一单图、2K 像素上限、最多八张参考，不开放该模型官方文生图4K与组图能力。原接口主机保持配置值，仅从 `/compatible-mode/v1` 推导 native 路径；不尝试其他主机或异步路由。实际参考图在预留付费请求前完成尺寸、格式、透明通道及完整解码检查，最终传输提示词超过5000字符明确拒绝。响应须具有真实完成标记、单张PNG与有效用量；记录原始厂商回执，不补造参考图消耗。依据 [Wan 2.7 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference) 与 [Token Plan 多模态接入](https://help.aliyun.com/zh/model-studio/token-plan-multimodal-gen)；隔离协议测试已通过，真实部署路由与生成质量另行验收。

局部提示协议的宿主标记图可能由合成操作产生冗余 alpha。只有完整解码证明标记图全不透明时，传输副本移除该通道，RGB像素保持一致；原始文件、引用和持久候选不改。真实透明像素不平铺、不放宽 Wan 的格式校验。直接整页路径保持原行为。

千问新统一模型要求配置的基础地址以 `/compatible-mode/v1` 结尾。原生同步适配器接受 `/compatible-mode/v1` 或 `/api/v1` 前缀，只替换同一配置来源的 API 路径，保留地区和工作空间域名。没有异步任务轮询或失败后切换地区的实现。

## 尺寸与图片限制

每次请求固定生成一张图片。参考图文件必须非空且不超过 10 MiB；宿主最多传八张，千问 3.0 / 2.0 / Edit 系列进一步限制为三张。千问 2.1 官方允许十张，当前宿主上限仍为八张。

旧 GPT Image 1/1.5 系列只接受 1024×1024、1536×1024、1024×1536。GPT Image 2/2.5 接受 16 的倍数，比例不超过 3:1，像素数为 655,360 至 8,294,400，单边不超过 3840；高于 2560×1440 的分辨率官方标为实验性。[OpenAI 图片指南](https://developers.openai.com/api/docs/guides/image-generation)

千问统一模型的像素数为 512² 至 2048²，3.0/2.1 比例上限为 8:1。宿主将自由尺寸按 16 对齐；2.0 的当前宿主比例上限为 4:1。Edit Max/Plus 的单边范围为 512 至 2048。[统一模型接口](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference)、[生成接口](https://www.alibabacloud.com/help/en/model-studio/qwen-image-api)、[编辑接口](https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-api)

Seedream 4.0 最低 921,600 像素，4.5 和 5.0 Lite 最低 3,686,400；这三种最高 16,777,216。5.0 Pro/Flash 为 921,600 至 4,624,220。比例上限均为 16:1。4.0/4.5/Lite 明确关闭组图，Pro/Flash 不传组图参数。[火山图片 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)

尺寸选择会检查实际模型限制。参考底图超过可用分辨率时返回失败，不静默缩小底图或换模型。

## 宿主执行要求

2026-10-07 用户同意的成品续改契约见 [续改与版本约定](ai-image-revision-proposal.md)。新任务使用严格 batch v4 / scope v2；旧 v3 仅经新续跑任务中的显式 `image_batch action:upgrade` 升级，历史任务与 v3 检查点保留。规范费用范围沿用同一个原任务 ID，精确归档旧范围整行后更新为 v2；历史 paid v1 和新版 paid v2 在同一原页累计，包括结果或费用待核对的请求，不重置序号或账本。旧代码回滚后拒绝此范围，恢复新版可以继续。

续改底图必须是当前本页最新成果，核对已保存回执、账号、会话、范围、正式要求摘要、尺寸和实际 SHA256；生成前与采用结果前重新检查。首版仅整页，不支持把旧原页轮廓、SAM、蒙版或 viewport 用在成品底图上。新 `image_revision v1` 与 `image_revision_raw v1` 单独记录真实 provider 底图和有序参考；不改写旧 generation/raw 回执。`image_revision_view` 只读展示原页、实际成品底图和原始候选三帧。取消或并发底图变更后，已返回且权限仍有效的候选和真实费用保留，不覆盖较新成果。

每次续改都重新对照冻结原书页及全部正式要求独立验收，不继承旧图通过状态。整页模型编辑仍可能改变其他内容，工具可用和测试通过不等于严格背景保留或整批质量合格。

未指定输出尺寸或比例的图片编辑，优先请求模型支持的实际源画幅；成品续改使用冻结原页尺寸，避免继承上一张成品的画幅误差。模型不支持该尺寸时仍按源比例选择合法尺寸。显式尺寸或比例优先。原始候选保留厂商实际输出，不靠拉伸或改写回执伪造尺寸符合。

缺少续改查看证明时，宿主预检先返回只读原页与当前成品两帧，明确 `paid:false`；不是新成品，不写图片费用。两帧实际完整送达并正常结束模型响应后，后轮重试才可能付费。查看恢复按原页、当前成品及其真实绑定最多三次，改写提示词不重置上限；不足两帧整体省略并提示单独查看。此证明只用于续改，不授权独立复审或自动通过。

厂商明确返回内容审核拒绝时，显示独立错误 `image_content_rejected` 并停止当前执行，不误报接口或尺寸错误，不自动改写提示或重发付费请求。仅识别实现清单中的明确错误代码；任意上游说明、地址和响应正文不进入用户提示。其他 HTTP 拒绝仍沿用其实际状态；历史错误和用量不重写。

适配器只处理请求协议和响应，不访问数据库、额度、文件权限或候选账本。继续复用宿主的权限、累计尝试次数、幂等操作、候选保存和视觉验收。

付费 POST 只提交一次，无自动重试或协议回退。请求中断且厂商结果未知时保留待核对状态。已得到成功结果后先记录实际用量，再下载 URL 图片；下载失败不能触发再次生成。同一个已返回 URL 的临时网络故障、429 或明确的 5xx 最多下载三次，重试间隔为250和500毫秒，每次都重新核验公开网络地址、重定向与取消状态。认证、地址安全、文件大小、格式与未知错误不重试，不转发模型密钥。没有 URL 或原始候选的既有失败记录不能凭此恢复。

响应支持 base64 或临时 URL，要求唯一图片。厂商原始 `usage` 保留原样；已报告的 `input_images` / `input_image_count` 包括零值，未报告时保持未知。请求 ID 同时支持响应正文和 `x-request-id`。千问临时图片 URL 应及时保存，不能作为持久资产回执。

## 旧配置与历史数据

当前代码仍存在既有配置读取行为：读取已有配置时移除旧 `imageEditApi`；缺少 `imageProfile` 的图片模型若实际 ID 在当前连接的清单中则使用该规格，否则按连接使用以下默认值。这是 2026-10-05 用户明确要求“旧的就给个默认值处理”的现有读取规则；本版保留该已批准规则，不扩大默认处理范围。本次新增 Wan 规格要求显式 profile，不使用此默认链路：

| 连接 | 默认规格 | 默认尺寸 |
| --- | --- | --- |
| 火山 | `doubao-seedream-5-0-pro-260628` | `2048x2048` |
| 千问 | `qwen-image-3.0-pro` | `2048x2048` |
| OpenAI / OpenAI 兼容 | `gpt-image-2` | `1024x1024` |

实际部署 ID、密钥、厂商地址和历史数据保留；默认化不验证远端部署的实际模型。其他连接没有图片适配器，保留配置但不可执行。管理员保存后持久化新字段，旧协议字段不再写入或参与执行。新建模型和管理 API 保存必须明确选择当前支持的规格，不能利用缺字段默认值新增任意规格。

旧的带参考图 `image_generate` 输入明确拒绝，后续使用 `image_reference_generate` 或 `image_edit`；不重放或改写历史工具调用。未完成批次的进度、候选、失败证据和累计付费次数保留，恢复后使用新工具。切换工具或模型不重置次数。

原始候选维持当前 `image_raw_candidate/version:1` 的结构，协议枚举增加 `qwen-generations` / `qwen-native`，原记录无需补字段或迁移。回滚后的旧代码无法重新合成新千问协议候选，已保存图片与账本仍保留，恢复新版后可读取。上线前应保存 AI 配置副本；回滚恢复原代码与配置，保留新增图片、候选及账本，不清空用户数据。

## 验证边界

协议回归验证使用隔离数据库、图片文件和模拟厂商响应，覆盖协议、工具输入、模型覆盖、候选及原始用量保存、幂等与下载失败后的计费状态。真实验收另外使用用户授权的火山与千问直连账号，调用、费用、图片和失败记录均保留；接口可用不代表复杂任务质量通过。

千问 Token Plan 的实际模型清单包含 `qwen3.8-max` 和 `wan2.7-image-pro`；不能据其他产品的文档推断当前账号可用 `qwen-image-3.0-pro`。Qwen 已实际完成相邻书页的规划对比，Wan native 接口已实际返回有效 PNG。但家人替换候选多次出现真人头像与卡通身体混合，未通过当前验收；隔离环境的编辑路由已恢复 Seedream，Qwen 继续用于规划。这些是本次对比的结论，不替代两套95页的完整验收。

已通过 504 项相关回归测试。界面调整后重跑 101 项关键回归、类型检查和隔离前端构建；浏览器验证覆盖支持清单、部署 ID 保存、三个工具模型覆盖、移除确认与取消、中英文切换，未出现浏览器原生对话框或页面异常。
## 本地多参考图提示

本地模型仍须按本次实际输入顺序明确图片用途：原页作为图 1，身份参考从图 2 起；只加入当前目标需要的参考。六视图可先完整查看，再用已有 `referenceCrops` 选择适合本页的身份视角，保留原附件及引用关系。不能把一页只需爸爸替换的任务同时塞入全家照片并仅写“我爸爸”，也不能沿用其他页的图号。

这一做法参考 [Black Forest Labs 官方多参考图实践](https://github.com/black-forest-labs/skills/blob/master/skills/flux-image-best-practices/rules/multi-reference-editing.md)中的明确图片角色、图片索引及减少无关参考建议。官方 [Qwen Image Edit 2511 说明](https://qwen.ai/blog?id=qwen-image-edit-2511)描述了人物一致性改进；这些能力说明不证明当前人物替换已经通过。最终仍按实际原页、保存成品和正式用户要求独立验收。
