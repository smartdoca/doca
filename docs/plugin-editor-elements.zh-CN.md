# 文档插件元素（SDK 0.1.6 源码增量）

[English](plugin-editor-elements.md)

2026-10-02 在宿主源码 0.1.8、SDK 0.1.6、契约包 0.1.6 和 Web registry 0.1.3 中实现。本文记录源码导出与隔离验收，不代表 npm 发布、生产安装或原生设备验收。既定存储策略是精确版本支持：未知类型或版本显示错误占位，保留原始 JSON。不提供适配器、自动转换、迁移或数据重置，现有内部文档引用读取规则保持原状。

## 公开注册

从 `@smartdoca/plugin-sdk/editor-elements` 导入 `PluginElementContribution`、`PluginElementPayload`、`createPluginElementPayload`、`pluginElementState`、`isPluginElementPayload`、`validatePluginElementPayload`。普通已安装 Web 插件 bundle 返回可选 `elements`。宿主将贡献注册到 `WebPluginRegistry.elements` 的所属插件命名空间，并随 bundle 释放。重复 ID 或非法声明导致注册失败，回撤该 bundle 的注册。

```ts
import type { PluginElementContribution } from "@smartdoca/plugin-sdk/editor-elements";

const element: PluginElementContribution = {
  id: "example.elements.countdown", pluginId: "example.elements",
  title: { zh: "倒计时", en: "Countdown" }, dataVersion: 1,
  formats: ["rich_text", "spreadsheet"],
  validate: data => typeof data.targetAt === "string" &&
    Number.isFinite(Date.parse(data.targetAt)),
  text: data => `Countdown: ${data.targetAt}`,
  renderEditor: context => /* 注入的 React 配置表单 */ null,
  render: (payload, context) => /* 注入的 React 行内视图 */ null,
  renderCell: context => { /* 在 context.rect 内通过 context.canvas 绘制 */ },
  refreshIntervalMs: 1000,
};
```

示例展示实际导出签名；[独立示例](../examples/plugin-elements/README.md)包含可工作的表单、渲染器和安装文件。插件使用注入的宿主 React，自行打包依赖，不导入宿主源码路径或使用全局编辑器桥接。

贡献必须提供双语 `title`、正整数 `dataVersion`、至少一种支持格式，以及 `validate`、`text`、`renderEditor`。`rich_text` 需要 `render`，`spreadsheet` 需要 `renderCell`。可选 `onCellClick` 接收 payload 和公开上下文；可选 `refreshIntervalMs` 为 1000–60000 的整数，只刷新画布视图。

上下文包含 `documentId`、`format`、`locale`（`zh`/`en`）、`readOnly`、`AbortSignal`。表单另有克隆的 `initialData` 或 null、`submit(data)`、`cancel()`；画布上下文另有克隆的 `payload`、画布和裁剪后的单元格矩形。配置经宿主提交，插件没有可变编辑器句柄、私有运行时或独立持久化通道。渲染异常显示本地化占位；插件自行处理事件和异步失败，并响应取消。

## 持久内容

```json
{
  "version": 1,
  "pluginId": "example.elements",
  "type": "example.elements.countdown",
  "dataVersion": 1,
  "data": { "label": "Launch", "targetAt": "2026-10-04T00:00:00.000Z" },
  "text": "Launch · 2026-10-04T00:00:00.000Z"
}
```

`version` 是 envelope 版本，`dataVersion` 是贡献的精确数据版本。`data` 是普通 JSON 配置，`text` 是供文本消费者使用的有界静态投影。不要持久化渲染函数、凭据、临时 URL、跳动数值或计时器。payload 必须是普通 JSON 对象，UTF-8 最多 32 KiB、深度 20、节点数 4096；持久化前拒绝危险原型键、非有限数值和非 JSON 数据。

当前 envelope 只接受六个声明字段。结构有效但类型未知、提供者未安装或停用、格式不支持、版本不匹配时显示不支持占位；当前提供者拒绝配置时显示无效占位。都不会改写或丢弃数据。宿主不调用版本不匹配的渲染器或配置编辑器。用户可通过原生编辑显式删除不支持元素并撤销；重新启用精确匹配提供者可恢复展示。

## 原生编辑器集成

- 富文本使用永久宿主原子行内扩展 `custom:plugin-element` 和共用 codec。没有业务插件时也保存完整不透明 payload。插入捕获实时 Slate 范围，编辑按节点 ID 定位；插入、配置和删除使用原生操作及撤销。当前支持行内原子，不导出任意块布局。
- 表格使用公开 `cellRenderers` 画布扩展和原生 `ICellData.custom.docaElement`，`v` 为静态文本投影。提交保留当前样式并设置原生 CLIP 换行，避免文本溢到相邻格。插入会替换所选整单元格的值、公式、富文本和 custom 数据，弹框明确说明；没有浮动对象或格内文字插入位置。表单打开时，稳定单格锚点跟随行列变化；目标被删除或并发改变时拒绝提交。复制、删除、撤销、协同由原生范围命令完成。
- 关闭弹框、改变编辑上下文或离开编辑状态会取消会话。提交重新检查提供者、句柄、只读状态和目标。渲染及注册变化不重建文档编辑器，视图刷新不提交正文写入。

富文本 schema 3 与表格 schema 6 继续使用原生检查点和可靠协同 outbox，没有第二条 JSON 自动保存、传输、Yjs 重放或业务插件数据库。原生检查点和同模型剪贴板保留 payload；文本、Markdown、Office 转换沿用现有限制。富文本原子导出按已有转换警告降为标签，表格消费者可读静态值。纯文本导出不构成插件元素无损备份。

## 生命周期、安装与回退

默认不安装元素提供者。只通过现有安装目录/ZIP 机制发现插件。当前示例 manifest 要求 SDK `^0.1.7`；独立生产使用前发布并安装包含该增量的 SDK 与宿主。示例服务端工厂没有业务数据，卸载不删除文档内容。

停用/卸载注销渲染器，保留持久元素。重装精确匹配提供者无需转换。回退到缺少永久原生 codec 的旧宿主不支持编辑这些文档；保留数据库/检查点备份，并使用已实现该能力的宿主访问。不提供降级改写或破坏性清理。

## 验收

`tests/plugin-editor-elements.test.ts` 使用隔离数据库和文档，覆盖注册归属/释放/回撤、严格版本和 JSON 限制、富文本原子剪贴板/删除/撤销及不透明 CRDT 往返、原生持久化/ACK 重放/双副本不回声、表格稳定锚点/行插入/复制/删除/撤销/重载/收敛、只读授权与超限 payload 原子拒绝。SDK 验证还包括不依赖宿主路径的独立 JavaScript 与 NodeNext 声明消费者。

浏览器验收使用隔离数据库和临时安装的独立倒计时/新闻示例。原生容器及第三方插件需单独验收。通用块、跨格式无损导出和任意公开编辑器修改命令仍是后续能力。

浏览器已验证富文本插入/配置/撤销/重做/重载/只读，表格配置/插入/撤销/重做/重载，以及未知类型占位和仅允许移除的配置。表格投影裁剪在保存重载后确认。当时组合检查：TypeScript 通过，171 个测试文件通过（1066 项通过、3 项跳过），SDK 构建与独立消费、Web 构建、空白检查通过。

## 性能验收（2026-10-02）

运行 `node --import tsx scripts/benchmark-plugin-elements.mts`。在该 macOS arm64 / Node 24.15.0 环境中，1000 个普通段落的原生投影中位数从两个旧行内 codec 的 0.513 ms 变为增加元素 codec 后的 0.515 ms，差异处于测量噪声。10000 个普通占用单元格的稀疏元素检查增加 0.039 ms；含 100 个元素时为 0.111 ms。首次验证 100 个倒计时 payload 为 0.188 ms，克隆并调用 100 个示例画布回调为 0.101 ms；回调基准使用模拟画布，不测量原生绘制。

普通单元格在 custom 属性检查后快速返回。富文本验证有缓存，画布按 payload/提供者缓存并在注册变更时失效。合并后的单一视图计时器只有绘制可见计时单元格后才重新安排，最短一秒；隐藏页面取消，没有可见计时单元格时不运行周期刷新。调度测试覆盖零空闲计时器、100 元素合并、离开视口、隐藏和释放。浏览器观察计时文档空闲超过 60 秒，没有新增正文 seq/历史；计时器不进入持久化 outbox。

这些结果只说明已测场景的宿主额外 CPU 开销很小，不保证任意第三方渲染、外部读取、大量可见元素或每种设备都零开销。生产提供者需验证自身渲染和异步工作。
