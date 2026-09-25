# Doca 插件开发

Doca 插件是管理员安装、在 `doca.config.ts` 中显式启用、随 Server/Web/Mobile
一起构建的可信 npm 包。它不是安全沙箱；启用插件等同于允许该包在对应
Node.js 或客户端进程中执行代码。

## 包结构

一个同时支持三端的包至少应声明：

```json
{
  "name": "@example/doca-plugin",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server.ts",
    "./web": "./src/web.ts",
    "./mobile": "./src/mobile.ts",
    "./manifest": "./src/manifest.ts"
  },
  "doca": {
    "manifest": "./src/manifest.ts",
    "server": "./src/server.ts",
    "web": "./src/web.ts",
    "mobile": "./src/mobile.ts"
  }
}
```

不支持的客户端 target 应省略，不能注册一个运行时才报错的空页面。React、
Yjs、Ant Design 和编辑器 SDK 必须使用 peer dependency，避免产生第二份运行时。

在根配置中安装：

```ts
import { defineDocaConfig, plugin } from "@doca/plugin-sdk";

export default defineDocaConfig({
  plugins: [
    plugin("@doca/plugin-files"),
    plugin("@doca/plugin-documents"),
    plugin("@example/doca-plugin", {
      config: { endpoint: "https://example.test" },
    }),
  ],
});
```

插件 ID、route、tool、job、renderer、migration 与 contribution ID 必须带包拥有的
命名空间。Host 在启动或构建时拒绝重复 ID、缺失依赖、版本不兼容及依赖环。

## Service、Provider、Consumer

能力定义与实现分开发布。Consumer 只注入稳定 Definition，不能导入 Provider
内部表或底层 SDK：

```ts
const files = defineService<FilesServiceV1>("files.v1");

export default definePlugin({
  manifest,
  injections: { required: [files] },
  discover(ctx) {
    const service = ctx.inject(files);
    ctx.effect(() => service.registerConsumer("example"));
  },
});
```

一个 Service key 只能有一个 Provider。AI tools、Search sources、Knowledge
sources 和 UI renderers 属于多贡献 registry；每次注册必须返回 disposer，并由
`ctx.effect()`/`ctx.effectAsync()` 持有。生命周期固定为：

```text
discover -> required injection check -> migrate -> mount -> ready
dispose  <- reverse dependency order
```

Fastify 已挂载路由不能在运行中移除，因此生产只在应用关闭时卸载 Server 路由。
定时器、监听器、source、tool 和 renderer 仍必须可逆清理。

## 持久化与任务

- 插件只通过有前缀的表和从零 migration 建库；版本写入
  `plugin_migrations`。
- 业务事务将领域事实追加到 transactional outbox，不在事务内调用搜索、
  知识投影或外部网络。
- 后台处理使用 JobHost 的租约、幂等、指数重试和死信。handler 被移除时任务进入
  `blocked-plugin-missing`，不会无限重试。
- 文件引用只保存稳定 file ID。附件关系使用
  `(ownerPlugin, ownerType, ownerId, role)`，不能保存临时签名 URL。

## AI、搜索与知识贡献

AI intent 的路由次序为资格过滤、置信度、相同置信度下的 priority、稳定 ID。
intent 应关联 workflow、acceptance 和按需 skill。所有 tool 调用经过统一
call/result、guard、审批、wrapper 与 receipt pipeline；注册工具并不授予用户权限。
Chat 与 MCP 消费同一 registry。

领域插件应在自己的 lifecycle 中注册贡献，宿主只提供 registry service。比如邮箱
插件注册 `doca.mail.*` intent/tool/workflow/acceptance/skill；停用邮箱后这些条目、
邮件 SearchSource 和 KnowledgeSource 必须同时消失。领域 tool 的实现可以由 Server
adapter 提供，但不能作为始终存在的 AI 内建工具绕过插件开关。

模型可见输入、意图、workflow、tool call/result、验收及最终消息写入 append-only
SessionEvent。流式 token/progress 是临时事件，不能冒充已提交事实。UI 用稳定
`(kind, id)` 和 sequence 投影节点；未知事件必须显示通用事实卡片。

Search source 声明独立 schema version、enumerate/project/delete/query/ACL/hydrate。
SearchHost 对来源做故障隔离，并在返回前调用来源 ACL 与 hydrate；索引内的 reader
字段不能作为最终授权。Knowledge source 必须提供配置校验、preview、
`pull(cursor)`、稳定 external ID/version、provenance、reader mapping 与 file IDs。

## Web/Mobile 与国际化

客户端入口在构建期注册 routes/navigation/admin/settings/AI blocks/search
results/knowledge config/file picker。route ID 和 path 会检查冲突。renderer 只接收
schema 校验后的 DTO 与宿主 capability，不能读取 Cookie、数据库或存储密钥。

`/api/v1/bootstrap.plugins` 是运行时活动清单。客户端构建中存在、但服务端未启用的
插件必须隐藏导航和管理入口；旧深链应显示“模块未安装或已停用”，不能继续请求缺失
API。未知对话事件或 renderer 仍使用通用事实展示，不能丢弃已提交记录。

每个插件自带 `zh`/`en` 字典，key 使用稳定英文标识。locale 由宿主传入；插件不得
读取 localStorage。locale 或 registry 更新不能重建 Y.Doc、协同 adapter 或编辑器
实例。

## 验证

提交插件前至少验证：

1. manifest、依赖、配置及 migration 幂等；
2. Provider、route、job、tool、renderer 冲突会在启动时失败；
3. 权限二次检查、禁用插件启动和逆序 shutdown；
4. SessionEvent replay 与乱序客户端投影确定；
5. Search ACL/hydrate、索引切换和单来源故障；
6. Web/Mobile 构建清单与 `/api/v1/bootstrap` 的活动插件版本一致。

`@doca/plugin-sdk/testing` 提供 lifecycle contract harness，可用于验证第三方包的
discover/migrate/mount/ready/dispose 顺序和 effect 清理；它不能替代领域权限及端到端
测试。

首方示例见 `packages/plugin-files`、`packages/plugin-documents` 和
`packages/plugin-mail`。邮箱插件必须能独立禁用，且不得影响文件、文档、AI 和搜索
启动。
