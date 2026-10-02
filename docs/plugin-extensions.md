# 插件公共读取与多位置展示

2026-10-02：源码 SDK `0.1.4`、契约包 `0.1.3`、Web registry `0.1.2` 已实现以下能力。本文不代表 npm 已发布或部署实例已升级。使用新增方法的插件在静态 manifest 声明 `sdkRange: "^0.1.4"`，在构建时依赖对应新版公共包。

## 公共服务

| 服务 / 导出 | 当前方法 | 用途与边界 |
| --- | --- | --- |
| `users.v1` / `@smartdoca/plugin-sdk/platform` | 新增 `me`、`searchPage`、`resolveDirectory`、`validateSelection` | 跟随管理员用户覆盖和系统 none/all/related；搜索输出公开展示投影；自身资料独立读取 |
| `permissions.v1` | `registerDirectory` | 内部模块与插件注册同一 `DirectorySource` 契约；只有 related 调用来源，并复核、按用户 ID 合并 |
| `documents.read.v1` / `@smartdoca/plugin-sdk/documents` | `get`、`readSnapshot`、`capabilities`、`references` | 文档信息、原生完整内容、当前权限能力、引用关系；与内部协作服务 `documents.v1` 分开 |
| `libraries.v1` / `@smartdoca/plugin-sdk/documents` | `list`、`children`、`path` | 可发现知识库、直接子节点分页、授权祖先路径；正文另查权限 |
| `files.v1` / `@smartdoca/plugin-sdk/files` | 已有 folders/files/uploads/bindings/content/receipts | 文件夹结构、文件信息、授权内容流、附件绑定、上传与操作回执 |
| `content.v1` / `@smartdoca/plugin-sdk/content` | 保持 list/read/resolve/search | 纯内容检索、分析和知识订阅；不替代原生文档结构 |

服务 token 为 `usersServiceToken`、`permissionsServiceToken`、`documentReadServiceToken`、`librariesServiceToken`、`filesServiceToken` 和 `contentServiceToken`。服务端插件在 `injections.required` 声明需求，通过 `context.inject(token)` 获取实现。无新增关系来源时无需注册。插件来源 ID 必须属于自身命名空间；注册由插件 lifecycle 持有，disposer 只释放运行时贡献。

`DirectorySource` 保留 schemaVersion 1、related/verify 协议。内置文档和共享文件夹也进入来源注册表。none 搜索返回空，读取自己用 me；all 直接查询有效站内账户，不调用来源。related 并行聚合有效来源，候选经来源复核和账户状态过滤。来源异常、重复游标、超预算或执行期间注销时不接受该来源的候选。新增分页结果以 `complete: false` 标识部分来源失败。预算为每来源 2 秒、40 页、每页 250 项。

`searchPage({query,cursor?,limit?})` 返回 `{items,nextCursor,complete}`，limit 为 1–100，默认 20。游标绑定调用者、查询和有效目录模式；每页重新授权。查询期间目录策略变化返回 409，重新从第一页开始。`resolveDirectory({ids})` 与 `validateSelection({ids})` 最多 100 个 ID，按当前目录重新检查；发现用户仍不等于具备共享、指派或业务资源权限。旧 search 仍返回最多 20 项数组；可信服务端的旧 list 不进入浏览器客户端。

`readSnapshot({documentId,expectedRevision?})` 返回 `{documentId,format,codec,schemaVersion,revision,epochId,seq,content,assets}`。当前支持 rich_text、markdown、spreadsheet、canvas、presentation；content 是各编辑器当前原生模型（Markdown 是字符串），不是摘要，也不是 Yjs 更新字节。revision 是不透明内容标识，包含实际内容、codec/schema 和 epoch/seq 事实；不是资源标题等元数据的 version。expectedRevision 不匹配返回 409。富文本已经持久化但尚未建立协作 epoch 时返回 `epochId: null`，不生成 epoch。没有持久化状态返回 409，不在读取中初始化。正文 JSON 超过 16 MiB 明确返回 413。

读取在一致的事务中恢复持久内容，不混入当前编辑器未保存修改，不提交正文、历史或 ACK。assets 仅返回当前授权文件的稳定 fileId/name/mime，不返回存储密钥、物理路径或持久化临时 URL。capabilities 表示当前资源的权限和快照支持情况，不承诺插件已经具有文档写入服务。

知识库 list/children 返回 `{items,nextCursor}`，当前每页沿用宿主 100 项查询。children 接受 `{libraryId,parentId,cursor?}`，根层 parentId=null；path 接受 `{resourceId}`。发现与读取分开：可见节点标题可能 role=none，正文接口仍拒绝访问。分页每页复核，不是冻结库存；批处理不得据一次不完整遍历判断内容已删除。

## 浏览器与 App WebView

`PluginWebHost.platform` 提供同一应用服务的类型化客户端：

```js
const page = await host.platform.users.searchPage({ query: "张", limit: 20 });
const self = await host.platform.users.me();
const snapshot = await host.platform.documents.readSnapshot(
  { documentId }, { signal: context.signal },
);
const children = await host.platform.libraries.children({ libraryId, parentId: null });
const folders = await host.platform.files.folders.list({ parentId: null });
```

客户端 users 包含 me/searchPage/resolveDirectory/validateSelection；documents 和 libraries 包含上述全部只读方法；files 包含 folders.get/list、files.get/list。其余文件写入、内容流和附件下载仍使用服务端 `files.v1` 或既有附件能力，不把流当作 JSON。

公共调用使用认证后的 `POST /api/v1/plugin-platform/{pluginId}/{operation}`，只允许运行中的安装插件命名空间和明确列出的操作。输入不接受 principal、mode 或任意服务名。响应不缓存。旧 `host.request` 仍限定插件自己的 `/api/v1/plugins/{pluginId}/`，路径语义没有扩大。

移动插件仍使用宿主签发、限定到单个插件的 WebView 会话。公共调用仅允许该插件自己的 namespace，后端继续校验当前用户和资源权限。没有向插件交付原生 bearer token。HTTP 会话边界已在隔离测试验证；新增卡片和文档挂载位置本轮是 Web 界面，移动原生位置未实现、未做真机验收。

## 操作、视图与位置

`WebPluginBundle` 新增三个可选集合：

- commands：可复用操作，包含 id/pluginId/title/supportedContexts/execute。
- views：可复用视图，包含 id/pluginId/title/supportedContexts/render。
- placements：挂载项，包含 id/pluginId/slot/order?/conditions?，引用一个 commandId 或 viewId。视图可指定 presentation 为 dialog/drawer/sidebar；不指定则原位渲染。

title 为 `{zh,en}`；ID 必须属于插件命名空间。supportedContexts 为 global/home/document/library/folder/resources。conditions 可按 targets、resourceKinds、formats、capabilities 过滤。平台支持和可见条件只是展示规则，不能代替服务端授权。重复 ID、非法位置、缺失或跨插件引用会使整个 bundle 注册失败并撤回已注册贡献。

| 已接入 Web 位置 | 上下文 |
| --- | --- |
| global.more | 全局操作；与原 web.more 导航共用右上角应用图标；二者过滤后均为空则隐藏 |
| home.cards / home.actions | 主页卡片、快捷操作 |
| document.toolbar / document.menu | 文档 ID/格式/当前权限；一个操作可同时放两处 |
| document.sidebar / document.status | 文档侧栏、状态内容；窄屏侧栏排列到正文下方 |
| library.toolbar / library.nodeMenu | 知识库入口、目录节点 |
| folder.toolbar / folder.rowMenu | 当前文件夹或行资源 |
| resource.bulkActions / resource.details | 选中集合（非空时挂载）、文档详情扩展 |

上下文包含 scope/target/locale/resource?/resources?/capabilities/signal，不默认包含正文或整个用户目录。宿主提供 resource.read/comment/edit/manage 展示能力；文件位置暂未提供统一操作能力投影，不要由 capability 缺失推断访问授权。

下面是浏览器 ESM 注册示例，不依赖宿主源码路径：

```js
export default host => {
  const pluginId = "example.tools";
  const viewId = "example.tools.preview";
  return {
    manifest: { pluginId, version: "1.0.0", targets: ["web"] },
    views: [{
      id: viewId, pluginId,
      title: { zh: "预览", en: "Preview" }, supportedContexts: ["document"],
      render(context) {
        return host.React.createElement("p", null, context.resource.title);
      },
    }],
    commands: [{
      id: "example.tools.open", pluginId,
      title: { zh: "预览", en: "Preview" }, supportedContexts: ["document"],
      execute(context) {
        host.ui.openView({ viewId, presentation: "dialog", context });
      },
    }],
    placements: ["document.toolbar", "document.menu"].map((slot, index) => ({
      id: `example.tools.placement${index}`, pluginId, slot,
      commandId: "example.tools.open",
    })),
  };
};
```

视图使用宿主 React，依赖随插件打包；不解析插件 ESM 的裸 npm 导入。宿主隔离 render 和子组件错误，操作 Promise 的失败显示反馈，执行中按钮禁用。插件自己创建的事件处理和异步任务仍应处理错误并监听取消信号。

原位视图/操作的 signal 在资源上下文变化或卸载时取消。打开弹窗或抽屉时，宿主将上下文转交到面板自己的会话，因此触发菜单关闭不会销毁面板；关闭面板、切换路由或打开另一面板时取消。旧关闭句柄不会关闭后开的面板。这里只读资源操作，没有选区句柄或未保存模型的写入承诺。

## 未实现的后续能力

选区/块/插入位置、文档修改命令、评论/历史的公共服务、共享邀请、AI 公共执行、事件字段范围和主题贡献仍需逐项契约与实际实现。本轮没有开放任意全局 CSS/DOM 改写，没有新增布局持久化、数据库迁移、旧格式转换或素材/模板提供方。

后续素材会话可复用公共包构建、字符串 service token、插件命名空间、lifecycle/disposer、认证上下文及类型化客户端。源码 SDK/平台/registry/契约文档属于本轮共同基础；素材会话另定义自己的服务与提供方，不修改旧 document_templates 或转换已存数据。已有 files.v1 和 content.v1 保持现有语义，不为素材追加私有桥接。

## 验证

新增测试涵盖目录聚合/撤销/策略变化、五种原生模型及修订、无权限候选后可见记录分页、目录遍历、注册撤回、面板取消与旧句柄、HTTP allowlist、移动跨插件会话拒绝。

`pnpm build:plugin-sdk` 生成发布制品；`node scripts/verify-plugin-sdk.mjs` 将制品复制到临时独立 node_modules，运行 JavaScript 并在没有宿主 paths 的 NodeNext 项目中检查 .d.ts。验证没有 npm 发布、不会安装到用户现有插件目录。

隔离示例插件已在浏览器检查主页卡片、右上角更多、文档菜单/工具栏、桌面侧栏与快照弹窗。实际两个个人插件和移动真机仍需各自集成验收。

完整检查：类型检查通过；162 个测试文件全部通过（1021 项通过、3 项跳过）；SDK 构建、独立消费验证、Web 构建及 diff 空白检查通过。
