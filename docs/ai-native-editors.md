# AI 原生画布与演示工具

当前目标：Canvas 0.5.5、Slides 0.3.0-alpha.3。宿主的 `canvas_edit` / `presentation_edit` 使用现有授权、seq/epochId 乐观校验、原生 Yjs 命令、原子验证和 durable ACK；没有第二条 JSON 保存通道。

## 画布

`canvas_edit.operations` 新增宿主工作流，组合已安装组件公开的 `CanvasModel` 命令，未假定组件存在未导出的语义 SDK：

| 命令 | 输入与生成结构 |
| --- | --- |
| `createFlowchart` | id/x/y、带 id/text/x/y/width/height/shape 的 nodes、带 id/sourceId/targetId/mode/可选 label 的 edges；生成 diagram-node/body/label 和绑定端点的 connector |
| `diagramEdge` | 已有普通原生连接器 id；autoRoute:true 自动避障，或明确 sourcePort/targetPort 及可选 mode/offset；autoLabel 与显式 labelOffset 互斥；保留端点、标签及全部对象身份 |
| `diagramNode` | 当前流程节点 id、可选 width/height/fill/stroke；同步调整透明外框、内部图形及文字边界，保留全部原对象 ID 与正文 |
| `createMindmap` | id/x/y、递归 topic{id,text,children?}、layout=right/left/balanced；生成 mindmap/mind-node/mind-edge，逻辑关系保存在 data.parentId |
| `createTable` | id/x/y、矩形 cells 字符串矩阵、可选完整 columnWidths/rowHeights；生成 board-table/table-cell/原生 Text |
| `createContainer` | id/x/y/containerType/title、可选原生 children 数组；phone、tablet、web、wide、standard、a4、section，生成原生 frame 容器 |
| `table` | id 为原生表格分组 ID，command 为下表命令 |

表格行列从 0 开始，区域端点均包含：

| command.kind | 字段 |
| --- | --- |
| cell | row/column/text，明确整格替换 |
| paste | row/column/cells，明确矩形整格替换，先增行列再粘贴 |
| clear / merge / split | range{startRow,endRow,startColumn,endColumn}，必须包含完整合并区域 |
| style | range/style，支持粗斜下划线、字号、文字/背景色、水平/垂直对齐，保留文字和资源 |
| resize | axis=row/column、index、size，单位像素 |
| insert-row / insert-column / delete-row / delete-column | index；不能删除最后一行列，存在合并时先拆分 |

编辑回执和首次读取的 `nativeTables` 提供最终 rows/columns/lastRowIndex/lastTwoRows、合并坐标和有限行预览。新增行后的“末两行”必须按最终 lastTwoRows 验收，不能使用增行前索引。

画布表格最多 100 行、30 列。富文本格合并尚不支持，会明确拒绝，不能清除格式绕过保护。原生表格结构必须走 `table`，直接 add/remove/place 子节点、ungroup 表格或 patch.data 覆盖行列会拒绝；整表移动、删除及基础原生绘图仍可用。

手机为 390×844，tablet 为 820×1180。新建 APP/手机/平板/网页 UI 时，用 `createContainer.children` 一次写入整页原生内容，嵌套组件沿用节点的 `children`；后续追加用 `add`，在操作顶层指定所属容器 `parentId`。空设备壳和同层内容不构成页面层级。坐标相对父容器，移动容器会携带整页内容；outline 显式返回实际结构 `parentId` 供核对。子节点递归使用与 `add` 相同的类型/属性校验，失败整批不写入。沿用当前 Canvas schema 1，无旧场景转换。手机顶部 100、底部 30 像素避开设备装饰，平板顶部留 60 像素。图案用原生可编辑 Path/Polygon/Star/Ellipse/Text 等组合。Polygon/Line 的 points 只接受当前原生扁平数字数组或 `{x,y}` 对象数组，不接受嵌套点对；Path 使用 path 字段，SVG 的 d 会明确报错。原生合法的 parentId:null 表示根节点，无输入猜测或转换。

Rect/Ellipse/Star 默认 x/y 为外接矩形左上角。中心为 `(400,400)`、直径 280 的圆应传 `x:260,y:260,width:280,height:280`，不能直接传圆心。文字居中明确提供包围盒和 textAlign；skill 先规划主体边界，再安排五官、装饰和标签。

删除思维主题会递归删除逻辑子主题和相应思维连线；删除根主题移除整张导图。普通未选中连接器保留，仅断开被删除的端点引用。

## 演示文稿

`presentation_edit` 沿用当前原生 controller。新表格的 cell、paste、style、merge、split、clear、resize、单/多行列删除和插入均在工具 schema 与内置 skill 中说明。表格操作使用读取到的稳定 `rowIds` / `columnIds`，拆分用 `merges[].id`；不得混用画布的数字索引。

| 字段 | 单位 |
| --- | --- |
| 元素 transform、读取的文稿 size | EMU，1 CSS 像素 = 9525 EMU |
| pageSize 的 width/height | CSS 像素 |
| padding、paddingInsets、表格 resize size/extent | CSS 像素 |
| fontSize、letterSpacing | pt |

文字修改用限定 slideId/id 的 replaceText；样式用 formatText/paragraphFormat；已有正文不能用 patch.paragraphs 覆盖。原生表格只含纯文本和整格样式，无公式、格内富文本或链接。

## 读取与模型调用

演示 `document_read(slideId,elementId)` 读取单个元素，outline 带表格摘要、稳定行列 ID 和 transform。画布 outline 带 data.kind、主题/连线关系、格坐标和 textLength。完整 data 或正文仍按元素读取，不能用截断预览重建。

模板/素材工具发布对象根 schema，再按原有精确 kind 契约验证。图片工具的坐标和空元组发布为等价数组 schema，保留原有 tuple 验证、长度、范围和几何约束。没有添加旧协议适配、放宽数据校验或修改图片业务规则。

独立 AI 验收通过当前 SDK 的流式接口完整消费模型输出，减少长响应期间网关空闲超时；只读工具、固定快照、完整读取和 submit_review 校验仍沿用原规则。部分响应、截断或未提交有效记录都不能算通过。

## 画板视觉读取与验收

`canvas_view` 把保存的画板通过当前已安装组件的原生 SVG 导出与隔离 Node/resvg 渲染为 PNG，图片作为真正的模型视觉输入传输，JSON 回执只保存来源、版本、世界坐标和导出警告。执行 AI 与独立验收 AI 都有此只读工具：

- `{resourceId}` 看完整画板；
- `{resourceId,elementIds:["对象ID"]}` 看对象及子树，保留祖先变换；
- `{resourceId,region:{x,y,width,height}}` 看世界坐标局部，不能同时传 elementIds。

图片最长边 1600 像素，最多 2 倍放大；`sourceRect` 与 `pixelsPerUnit` 给出图像到画板的映射。现有画板的视觉修改先看图，再按 ID 读取完整对象并编辑；保存后再看整板与必要细节，检查遮挡、溢出、错位和可读性。空板返回明确标识的白色视图。

验收的 JSON 和图片读取共用每轮固定快照。通过前，每份画板成果必须完整读取原生内容，并有同一快照的整板图片实际送达模型、模型响应成功结束的证据。局部图、未传输的图片、文字回执以及执行 AI 的自述都不能替代。对话模型有视觉能力时图片直接进入本模型；对话模型是文字模型时，`canvas_view` 与 `image_view` 复用 AI 管理中已配置的 `mediaModel`，通过共享只读图片查看服务将真实像素交给视觉模型，返回 `inspection` 观察结果。执行和独立验收分别发起自己的查看，不复用执行者的自述或视觉记录。独立视觉响应必须完整结束，全部图片字节须实际进入请求；同快照的完整观察结果还须进入验收模型的上下文并成功结束响应，之后才计为已看图。裁切、上下文裁剪掉的观察结果、空响应、输出截断、失败或撤权均不能计为通过。视觉调用沿用授权检查、模型权限和真实用量记账；没有可用视觉模型、渲染器缺失或渲染失败时不得声称视觉验收通过。

这是内容的原生导出视图，不含编辑器工具栏、光标或当前未提交草稿。字体、描边及不受支持的效果可能和浏览器编辑器存在差异，原生导出警告原样提供，不能宣称所有编辑器效果完全一致。其他文档格式仍只做原生内容与保存检查。

`pnpm build`、`pnpm dev` 和 `pnpm dev:workspace` 会先生成服务端 SDK 渲染包，也可单独运行 `pnpm build:canvas-render`。Docker 已包含原生 Canvas/resvg 和中文字体。每次渲染使用独立 Node 进程，以已安装 SDK 生成 SVG，并用原生 Canvas 测量文字及 resvg 生成 PNG；只接收宿主已授权的图片字节，不允许外部图片解析。图片只在当前任务内存中存在，不创建资产、文档版本或新保存通道。没有编辑器升级、存储格式转换、数据库变更或新增历史兼容规则。

隔离测试 `tests/ai-canvas-view.test.ts` 使用真实 Node 渲染器验证像素、负坐标、选区、裁切、导出警告、权限及无写入；模拟模型的完整任务验证实际多模态请求、未看图拒绝通过、固定快照和协作者后续修改。真实模型调试和画布侧栏附件回归记录见 `docs/verification/ai-canvas-tools-2026-10-19/`。视觉观察仍可能漏判或误判，不能以模型通过替代所有渲染效果的保证。

## 用户已确认的清理范围

删除画布/PPT 工具的旧参数别名、元素类型猜测、扁平文本重建、缺失 ID/rotation 补写以及像素/EMU 自动判断。当前接口之外的调用明确失败，不自动转换。富文本和电子表格的既有规范化不在本次清理范围内。

画布 schema 1 和旧 checkpoint 保留；PPT v5 沿用拒绝策略，不转换文稿、重写 epoch、历史或待提交更新。没有数据库结构变更。回退保留原部署、依赖和产物，并保留后续数据；旧编辑器不保证能读取新写入。

## 隔离验收入口

`scripts/qa-ai-native-creativity.mts` 使用真实模型、真实 Doca 工具、临时账号、内存 SQLite、临时存储和真实浏览器。默认执行完整 PPT 及修改、流程图、思维导图、画布表格、手机/pad UI、原生矢量图案，每个场景生成后继续定向修改。

```sh
DOCA_QA_ISOLATED=1 \
DOCA_QA_KEY_FILE=/absolute/private/temporary-key-file \
DOCA_QA_MODEL=kimi-k2.7-code \
DOCA_QA_OUTPUT=artifacts/ai-native-creativity/run \
pnpm exec tsx scripts/qa-ai-native-creativity.mts
```

密钥文件由操作者在仓库外创建并限制权限，完成后删除。脚本不保存请求头、密钥或用户数据；模型跟踪、原生投影、真实截图、PPTX 往返和报告写到指定的已忽略 artifacts 目录。可用 `DOCA_QA_CASES=ppt,flowchart,mindmap,table,ui,pattern` 选择场景，用 `DOCA_QA_PORT` 分离独立运行。

独立 AI 验收器对画板同时检查保存内容与 `canvas_view` 图像；其他格式仍只验证保存和原生内容，结构检查不能冒充视觉验收。脚本生成的完整浏览器截图可补充检查编辑器与原生导出差异。生产环境、Office/WPS 视觉往返和全部输入法不属于此脚本的验证结论。

## 2026-10-19 画布对话与关系图修复

- 收起画布/文档助手保留已经挂载的聊天实例，避免创建会话或上传图片时卸载组件并取消发送。展开后保留原消息与预览，原消息 ID 和已上传附件继续复用；没有增加本地持久格式。离开对应页面或退出账号仍按现有生命周期清理。
- 流程节点外层透明 Frame 不能被 AI 的 `patch` 涂成色块或加描边；错误明确返回内部 `diagram-body` 的真实 ID，改该子图形即可。失败整批不写入。现有文档没有自动修复、重建或删除。
- 新建连接器标签按实际字段名留宽并禁止折行，避免 `source_family_id` 被固定 96px 宽度拆开。密集关系图的手册要求分层和独立走线通道，保存后放大核对起点、箭头与标签。
- 原生文字粗体使用 `fontWeight:700`；根节点新增省略 `parentId` 或传 `null`，虚构 `root` ID 和 `bold` 字段继续拒绝，并给出具体纠正方法，不自动转换。
- 共享图片查看不再使用固定 4000 token 输出上限；部分推理模型会把思考计入同一额度，原先会连续截断视觉结论。现在使用该识别模型的已配置输出额度，要求简洁结论，截断仍明确失败。

流程图的 wire schema 现在完整发布 nodes/edges 的字段、必填项与端口枚举，执行侧仍按相同原生命令校验，没有放宽参数或引入旧参数转换。新建节点边界重叠时整批拒绝，错误给出冲突 ID；明确换行的文字按默认字号校验最低高度，自动折行仍需模型看图检查。

`edges[].labelOffset:{x,y}` 相对原生规范化路径的长度中点偏移，不能使用原始折线拐点中心。新建标签默认避让节点与其他标签；已有连线用 `diagramEdge` 指定端口及 `autoLabel:true` 重新安排，也可显式传 `labelOffset`，两者不能同时传。`offset:null` 明确清除绕行参数。保留标签的原 ID、正文、样式及尺寸，未请求重排的缺省偏移保持原状。只改标签 x/y 会被原生布局重新定位。标签已在连接器上方时不再移动图层顺序，避免反复重排耗尽原生排序精度。

`diagramNode` 调整尺寸时，同批更新绑定的普通连接器端点、路径与标签位置，保留显式标签偏移；跨组、旋转缩放或自定义复杂走线明确拒绝并回滚整批，交由原生界面操作。局部表名字重使用原有 node-label 的 `data.richText`，不拆除文字对象。

新建 `edges[].autoRoute:true,mode:"elbow"` 或已有 `diagramEdge {id,autoRoute:true,autoLabel:true}` 明确请求自动走线。宿主在当前原生四向端口与有限绕行候选中寻找不穿越卡片的路径，按长度、折点和已有共线路段选择；未找到可行路径则整批拒绝。自动模式不同时接受手写端口、绕行参数（新建只指定 elbow）。这两个布尔参数不会写入场景，实际端口、端点和绕行仍使用当前原生字段；不自动调整已有画布。普通交叉线不代表连接，模型验收须区分确定缺陷、无法确认的细节和可选美观建议。

宿主当前直线/折线路由通过已安装 CanvasEditor 的公开 `onReady/getValue` 做 64 组实际浏览器对照，覆盖四向端口、未指定及正/负/零绕行参数、明确和自动标签偏移及节点尺寸调整。另以公开 SVG 导出验证第一行粗体、正文普通字重。`scripts/qa-ai-canvas-routing.mts` 可独立复现，不访问数据库或模型；不导入组件私有模块。已有画布不会因读取、挂载或升级自动重算，只有明确的编辑操作才写入。

已验证的自定义网关 `doubao-seed-2.1-lite` 在画布执行与验收中明确使用原生 `thinking:{type:"disabled"}`，`kimi-k3` 图片查看也使用已实测支持的 low；其余对话模型不添加这一模式选项。保存的模型配置、其他任务的默认参数与现有供应商协议适配不变；参数拒绝作为真实错误处理，没有新增自动重试时移除参数的路径。

只读图片识别会同时获得该固定快照的有界原生对象/连线索引，坐标明确为父级局部坐标，索引仅帮助区分交叉线和真实连接，不能代替图片证据。局部图只检查可见区域；区域外节点和裁切后的线段不被当成缺失。渲染仍最多同时运行两个 Node 渲染进程，多余的少量局部查看排队，排队取消释放位置，超过有界队列才返回 busy。
