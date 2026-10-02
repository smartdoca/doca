# Doca 插件开发规范

更新：2026-10-02；源码宿主 0.1.8，公共 SDK 0.1.5（生产部署未验收）。本文是插件开发的主入口，包含当前内容、App 和安装约定；链接文档补充完整类型、协议和历史验收记录。任何新增或修改兼容策略、旧格式转换或数据库迁移，必须先与项目负责人对齐方案。

[English](plugin-development.md)

完整目标及尚未实现部分见 [SDK 契约](plugin-sdk-contract.zh-CN.md)。项目尚未上线，删除不合理的旧接口，不维护旧会员、审核或源码加载兼容层。

## 许可证边界

Doca 及公开插件 SDK 采用 [MIT](../LICENSE)。插件可以开源，也可以闭源。许可说明见
[中文说明](../LICENSING.zh-CN.md)。

插件不得把许可证不明、禁止再分发或与其发布方式不兼容的依赖打入正式制品。所有
第三方 NOTICE、源码提供和署名义务由插件发布者继续履行。Doca 的许可证不会覆盖
插件发布者无权许可的第三方内容。

## 安装与启动

通过「管理 → 插件商店」上传完整的预构建 ZIP，或停机后放入 `DOCA_PLUGINS_DIR/<plugin-id>/`。每个实例重启生效，共享数据库保存全站清单和完整归档，各实例启动自动校验并补齐本地缓存。不保留 npm 安装目录兼容路径。详见 [商店协议](plugin-store-protocol.md) 与 [部署说明](plugin-deployment.zh-CN.md)。

插件包的 package.json：

```json
{
  "name": "@example/attachments",
  "version": "1.0.0",
  "type": "module",
  "doca": {
    "dataVersion": "1",
    "manifest": "./manifest.json",
    "server": "./dist/server.js",
    "web": { "directory": "./web", "entry": "./index.js" }
  }
}
```

manifest.json 必须为静态 JSON，版本与 package.json 一致：

```json
{
  "schemaVersion": 1,
  "id": "example.attachments",
  "version": "1.0.0",
  "displayName": "Attachments",
  "sdkRange": "^0.1.3",
  "dependencies": [{ "id": "doca.files", "range": "^0.1.0" }]
}
```

仅加载已编译 JavaScript。依赖必须打包或随包以真实文件提供，不运行安装脚本、访问依赖源或编译插件。入口必须在包内。`doca.dataVersion` 必填。结构号是否可以改变，见下文「数据结构」。

## SDK 与宿主文件服务

依赖公开契约，禁止导入 `@server/*`、`@core/*`、`@web/*`、`@db/*`、同级 Doca 源码或全局桥接。SDK 的服务 ID 在不同安装副本之间保持一致；运行时由宿主注入实现。

```ts
import { definePlugin } from "@smartdoca/plugin-sdk";
import { filesServiceToken } from "@smartdoca/plugin-sdk/files";
import { httpServiceToken, usersServiceToken } from "@smartdoca/plugin-sdk/platform";
import manifest from "../manifest.json" with { type: "json" };

export default () =>
  definePlugin({
    manifest,
    injections: {
      required: [filesServiceToken, httpServiceToken, usersServiceToken],
    },
    async mount(context) {
      const files = context.inject(filesServiceToken);
      const users = context.inject(usersServiceToken);
      await context.inject(httpServiceToken).register(manifest.id, [
        {
          method: "GET",
          path: "/folders",
          async handle(request) {
            const user = await users.get(request, request.principal.id);
            const folders = await files.folders.list(
              { principalId: request.principal.id, signal: request.signal },
              { parentId: null },
            );
            return { user, folders };
          },
        },
      ]);
    },
  });
```

该接口实际地址为 `/api/v1/plugins/example.attachments/folders`，身份来自宿主会话。文件操作重新检查权限。文件业务保存稳定 file ID 和 owner binding，不保存本地磁盘路径。完整资料可通过 users.get 获取本人或管理员授权的目标用户，包含联系信息和自定义资料，不返回密码哈希及认证密钥。浏览器响应应由插件按用途裁剪。

## 当前公共服务

| 导入入口            | 服务                      | 用途                                         |
| ------------------- | ------------------------- | -------------------------------------------- |
| plugin-sdk/files    | filesServiceToken         | 文件夹、文件、上传、内容、绑定及访问授权     |
| plugin-sdk/platform | usersServiceToken         | 当前授权用户资料、统一用户搜索               |
| plugin-sdk/platform | permissionsServiceToken   | 注册业务资源鉴权及用户关系来源               |
| plugin-sdk/platform | httpServiceToken          | 已认证、独立命名空间的后端路由               |
| plugin-sdk/platform | policiesServiceToken      | 创建、存储、分享、转移及 AI 调用前的业务准入 |
| plugin-sdk/platform | eventsServiceToken        | 读取持久事件流，包括 ai.usage.recorded       |
| plugin-sdk/platform | notificationsServiceToken | 幂等发布、撤回通知及受权站内跳转             |
| plugin-sdk/ai       | aiServiceToken            | 注册带 JSON Schema 的 AI 工具和 skill 手册   |
| plugin-sdk/content | contentServiceToken | 统一内容清单、读取、定位、可选搜索及知识订阅来源 |
| plugin-sdk/platform | activityServiceToken | 插件自管最近访问，宿主汇总与鉴权 |
| plugin-sdk/search | searchServiceToken | 投影、重建与授权索引查询 |

注册 ID 必须以插件 ID 加点开头。路由 namespace 必须等于插件 ID。这些公共注册自动归属插件生命周期，关闭或启动失败时回收；自建定时器、连接仍用 context.effect/effectAsync 回收。关闭不删除持久数据。

目录来源返回当前有效用户关系。宿主统一执行管理员 all/related/none 策略，并过滤有效用户；来源错误不扩大可见范围。可搜索不等于可以读取资源。来源使用 schemaVersion: 1、分页 related 和当前事实 verify，插件自行维护关系索引；分页、超时和候选复核见交接文档。

AI 工具通过 `aiServiceToken.registerTool` 注册，包含 id、description、inputSchema 和 execute。execute 获得认证用户、sessionId、turnId、jobId、callId、signal，不能绕过文件权限。`registerSkill` 接收 id、name、description、content、formats；手册进入宿主技能库。业务工具必须自行校验业务资源权限，在插件数据库保存跨重试稳定的操作 ID 做副作用幂等；callId 可用于关联调用，但不能假定新调用会复用旧 callId。文件/文件夹创建应传稳定 idempotencyKey；上传创建同时传 uploads.complete 返回的 contentIdentity。使用 files.receipts.get 查询持久回执；pending 可重试、异参为 409，已删除结果不能借重放重建。完整协议见 SDK 契约第 7.1 节。

Doca 不内置会员、货币价格、积分或业务额度。模型管理中的输入/输出速率和每张图片 Token 只负责把厂商原始用量统一折算为 Token，不是最终售价。用量记录区分未确认调用与实际指标；`ai.usage.recorded` 在结算事务内写入持久事件，顶层 `metrics` 是已折算用量，`provider.metrics` 保留厂商原始事实。插件通过 events.read(cursor, limit) 拉取，持久保存消费位置并按事件 ID 幂等处理。策略 check 可以拒绝调用；跨插件预留、失败补偿和资金一致性尚未提供完整事务协议，不能将一次 check 当作完整计费实现。

插件自管独立数据库、凭证、业务任务和 outbox。宿主不提供 data.v1/data.v2，也不打开插件数据库。数据库必须符合声明的 dataVersion，可复用结构相同的已有数据；结构不匹配时拒绝启动。数据放在下文的业务数据目录。卸载见下文。

## 业务数据目录

业务库、凭证、任务和 outbox 放在插件自己的数据目录，不放进安装包目录。

插件只读取 `DOCA_PLUGINS_DATA_DIR`，并只使用 `<DOCA_PLUGINS_DATA_DIR>/<自己的插件 id>/`。相对路径相对进程工作目录。插件不自己补默认路径，也不再定义某个插件专用的数据目录环境变量。没有这个变量时，插件不能猜一个目录。

默认值由安装配置提供。Docker Compose 在未设置时传入 `/data/plugin-data`。

宿主不创建、不打开这个目录里的数据库。插件在首次使用时创建自己的子目录。`uninstall` 删除本插件的这个子目录，不要删除其他插件的目录。多个实例共用同一份业务库时，使用同一个根目录；插件安装缓存目录仍然各实例分开。

## 数据结构

`doca.dataVersion` 是插件私有数据库的结构号。它不是可以比较大小的版本号。

计划让新版本继续使用已经安装的数据时，结构号不能改。依赖库需要升级时，由插件自己准备升级方法，在插件代码里把现有库升级到新依赖库可以读取的状态。宿主不调用这个方法，也不因为依赖库版本变化而修改结构号。

结构号一旦改变，就表示不再兼容旧版本的数据。必须先卸载旧版本，等 `uninstall` 删掉旧库并清除旧结构号，才能安装声明新结构号的版本。宿主不会把旧库迁移到新结构。

## 卸载

已安装插件必须实现 `uninstall(context)`。插件工厂没有这个方法时，宿主拒绝安装，也不会加载该插件。

管理员卸载时，宿主先调用 `uninstall`。插件在这里删除自己的数据库、凭证、任务和 outbox。调用成功后，宿主才清除结构号并移除安装目标。宿主不打开、不删除插件数据库。

- 结构号不同就是不兼容旧结构。`uninstall` 只删除当前库，不把旧库迁移成新结构。
- 数据已经不存在时，再次调用必须成功。
- 方法缺失或抛错时，卸载不完成：插件保持已安装，结构号保留。
- `initialize`、`mount`、`ready`、`dispose` 只管理本次进程里的连接、定时器和注册。不要在 `dispose` 里删除数据库。
- 宿主文件服务中的附件不会随卸载自动删除。插件要解除自己的绑定时，必须确认这些文件没有被其他业务继续使用。

继续使用已有数据的升级必须保持 `doca.dataVersion` 不变，依赖库升级写在插件自己的升级方法里。改变结构号的版本必须先卸载旧版本，见上文「数据结构」。

```ts
export default () =>
  definePlugin({
    manifest,
    async uninstall() {
      await removeOwnDatabase();
    },
  });
```

`removeOwnDatabase` 由插件自己实现，删除它存放业务数据的库。宿主不提供这个函数。

## Web

可选 Web 产物默认导出 `async host => bundle`，host 提供 React、apiBase、useEnvironment、navigate、toast、confirm、request 和 FilePicker。React 从 host 注入，避免重复 renderer；其他依赖须打入浏览器产物，不要求宿主解析 npm 裸路径。bundle 遵循 `@smartdoca/plugin-sdk/web` 导出的 WebPluginBundle，manifest.pluginId/version 与服务端一致，支持页面、导航、管理和设置贡献。

宿主从 `/api/v1/plugin-assets/{id}/{version}/` 提供声明目录，启动前加载注册。插件加载错误隔离并记录，禁止暴露服务端包文件。贡献 render 已加入错误边界；通用目录树插槽尚待补齐。

## 构建与验证

宿主仓库运行 `pnpm build:plugin-sdk` 生成 SDK、契约和文件能力包的 JS 与 d.ts。发布到 npm 的包名是 `@smartdoca/plugin-sdk`，以及它再导出的契约包。`publishConfig` 指向 `dist`。安装插件时依赖这些发布产物，不要依赖仓库源码。

至少验证独立安装、无插件启动、依赖冲突、跨用户拒绝、版本冲突、调用幂等、撤销关系、两个宿主实例隔离和关闭回收。测试使用独立数据库、用户和文档。界面文案遵循 [语言规范](i18n.zh-CN.md)，编辑器遵循 [集成规范](editor-integration.zh-CN.md) 和 [协同规范](collaboration-sdk-contract.zh-CN.md)。

HTTP 回调、附件绑定授权、用户校准、搜索与知识接口，以及 Mobile 接入边界，见 [邮箱插件交接](plugin-mail-handoff.zh-CN.md)。

## 接入范围与交付门槛

`search.v1` 保留投影与授权查询能力。新的通用内容、全局内容检索和知识订阅接入统一使用下文 content.v1；插件负责业务数据与实时权限，宿主负责明确订阅后的调度、分块指纹及派生内容访问控制。

交付验收需用实际宿主交付物、SDK 和业务插件 tgz，在仓库外的隔离环境安装启动。预备完整依赖闭包，禁止依赖源码链接、未声明缓存或安装/启动时访问包仓库；实际验证 Web 资源加载、业务流程、撤权、失败重试和重启恢复。SDK 构建及导入成功仅是基础验证，不可替代端到端验收。

插件数据库只接受声明的结构版本（包括已有兼容数据），结构不匹配时拒绝启动，不运行升级或降级脚本。卸载要求见上文「卸载」。用户删除协议尚未提供。动态 WebView 的受限会话与实际可用接口见邮箱插件对接手册 v1。默认数据目录和任务状态管理不会赋予宿主访问插件数据库的权限。

## 后台身份复核与通知

`users.status(userId)` 为可信服务端任务返回当前 `{id, status}` 或 null。非 active 时停止业务操作；账号有效不代表拥有业务资源权限。

`notificationsServiceToken` 导出 `notifications.v1`：`publish(pluginId, {recipientId, key, title, body, path, resource: {type, id}})` 和 `withdraw(pluginId, {recipientId, key})`。宿主限制只能使用自己的 pluginId。key 非空且最多 200 字符，按插件和收件人隔离；同参数重放返回同一 `{id}`，异参返回 409，已撤回返回 410。插件在自己的 outbox 中保证先发布后撤回。

资源类型在 permissions.v1 注册并实现 `notification.read`。发布、列表、未读数和点击均复核当前权限；来源缺失、禁用、失败或超时均拒绝。标题和正文为纯文本，分别最多 200 和 2000 字符。path 使用 `/mail/<id>?message=...` 这样的站内路径，不含 origin 或 hash。链接先经过宿主鉴权端点再跳转，插件页面及 API 仍须自行鉴权。

本实例发布后实时刷新 Web，Web 每 30 秒对账其他实例的通知。这是站内通知，不包含 SMTP、移动推送或桌面通知。

HTTP 注册默认限制请求体 1 MiB；需要附件等大请求的单条路由可指定 `bodyLimit`（字节），最大 32 MiB。插件仍需校验附件数量、实际解码大小及业务总量。

## 首页最近访问

插件通过 `@smartdoca/plugin-sdk/platform` 的 `activityServiceToken`（`activity.v1`）注册最近访问数据源，自己管理记录、删除清理和业务权限，宿主统一分页、来源筛选与图标展示。必须注册 `activity.read` 权限并声明所需服务。完整接口、排序/游标协议和接入示例见 [插件接入首页最近访问](plugin-activity.md)。

## 统一内容：读取、搜索与知识库订阅

使用 `@smartdoca/plugin-sdk@^0.1.3`。从 `@smartdoca/plugin-sdk/content` 导入 `contentServiceToken` 与 `ContentSource` 类型，在 `injections.required` 声明服务，并在 mount 中注册来源。来源归属注册它的插件；内置文档和文件也使用这套契约。

| 成员 | 契约 |
| --- | --- |
| 来源声明 | `id`、`pluginId`、`version: 1`、中英文 `title`、`contentTypes`、`purposes`、`capabilities: {search}`、`configSchema` |
| `list(ctx, {config, cursor, limit})` | 必需。返回 `{items, nextCursor, snapshot}`。每项含 `ref: {sourceId, resourceId, blockId}`、`fingerprint`、`title`，可选 `order`、`anchor`、`excerpt`；此处不返回完整正文。 |
| `read(ctx, {config, ref, fingerprint})` | 必需。重新鉴权后返回清单项及 `text`，不可用返回 null；指纹变化报冲突，不能在旧指纹下返回新正文。 |
| `resolve(ctx, ref)` | 必需。重新鉴权并返回 `{path, fingerprint}` 或 null；path 是当前可打开的站内位置。 |
| `search(ctx, {config, cursor, limit, query})` | 可选，声明与实现必须一致。返回轻量分页结果；不支持时宿主不会自动全量扫描代替。 |

`ctx` 包含宿主认证的 `principalId`、`purpose`（knowledge、analysis、search）和取消信号 `signal`。来源每次调用都检查当前业务权限。声明 analysis 的来源可供未来待办插件分析，不需要邮箱专用查询接口。消费方先调用 `sources(ctx, purpose)`，再调用服务的 list/read/search 并传入 sourceId、purpose；服务 resolve 接受 `{ref, purpose}`。只能使用来源已声明的用途。

分页从 null 开始，以 nextCursor=null 结束；同一轮所有页必须属于一致的 snapshot，过期就失败，不能静默切换数据继续。这是遍历当前有权访问的全量清单所用的分页游标，不是持久增量日志。本契约不要求、也不导出 listChanges/readChanges。插件可自行同步业务系统，但宿主不规定它的内部同步实现。

知识库复用现有订阅与调度体系，由用户明确选择来源、知识库和配置。宿主保存引用与分块指纹，完成清单核对后仅拉取和分析新增、变化的正文，不额外存一份完整来源正文镜像；未变化的块不重复读取。只有完整、一致的清单才能认定删除，失败或不完整的遍历不能确认删除。块身份不能依赖整篇文档的修订号或段落位置序号。

原内容删除、解绑、撤权或来源不可用时，派生知识暂停普通用户的新读取、列表展示、搜索及回答检索，保留内容供管理员处理，人工编辑过的结果也遵循此规则。已送达的内容不会被追回，已打开的协同连接也不在即时断开的承诺内。配置界面支持基础字段、枚举和字符串数组；复杂配置由插件界面处理。本次没有数据库结构迁移、双读双写或旧来源适配。SDK 仍导出 knowledge.sources.v1，但新接入使用 content.v1，旧注册不会自动变成新订阅。

限制：每页 100 项、每轮清单 100,000 项、单块正文 200 万字符、每轮分析变化正文 120,000 字符、来源调用 20 秒超时。超限或不完整时明确失败，不能截断后宣称完成。HTTP 入口为 `/api/v1/content/sources` 与 `/api/v1/content/{list,read,resolve,search}`；详细请求及订阅路由见[内容协议](plugin-content.md)。

## App 持久缓存与附件

Web 与受限移动 WebView 复用插件 Web 产物。`@smartdoca/plugin-sdk/web` 的 `PluginWebHost.native` 在 Web 中为 null，App 中提供原生能力；类型从 `@smartdoca/plugin-sdk/native` 导出。

- `native.storage` 提供 get/set/remove/clear，字符串缓存按服务器、登录用户和插件隔离；单值 200 万字符、每插件 2000 万字符。退出或移除账号会清理该账号缓存。插件主动接入，不迁移 IndexedDB，不承诺离线冷启动。
- `native.attachments.save/share` 接收 `{path, name, mime}`（path 为插件 API 相对路径），由原生侧带认证下载，不向 WebView 暴露原生凭证；禁止重定向，最大 32 MiB，并清理临时文件。
- Android 保存可返回 completed/canceled；iOS 保存和系统分享的 presented 仅表示展示系统面板，不代表操作完成。切换账号或页面销毁会取消进行中的请求。
- 邮箱绑定作为 Web 能力，当前不实现原生 OAuth。

当前公共 SDK 包版本是 0.1.5。宿主测试和构建不能替代独立邮箱包联调、iOS/Android 真机验收，这两项仍待完成；详细契约见[原生能力](plugin-native.md)。

## 分发与导航

完整 npm tgz 用于商城发布或「插件商店 → 设置」中的指定包名/版本安装；本地上传使用根目录含 package.json 的 ZIP，不能直接上传 tgz。两种产物都必须包含编译产物和完整运行依赖，宿主不运行 npm install 或安装脚本。安装、升级、禁用和卸载在各实例重启后生效。卸载行为见上文「卸载」。

导航是全局配置，分为 Web 用户入口、App 用户入口、Web 管理员入口。用户页面与管理页面不得混用；插件声明页面用途和支持平台，管理员在对应范围选择入口。插件页面会标记来源；同一入口不应在侧栏和更多里重复展示。详情见[分发、WebView 与导航](plugin-mail-integration-v1.md)及[商城协议](plugin-store-protocol.md)。

## 公共读取与多位置展示（SDK 0.1.4）

新增用户目录、原生文档快照、知识库目录、`host.platform`、`host.ui` 及可选 commands/views/placements 的实际导出和接入示例见[插件公共读取与多位置展示](plugin-extensions.md)。使用新方法的插件声明最低 `sdkRange: "^0.1.4"`；当前只注册常规页面的插件无需新增注册。

## 模板与素材插件

SDK 0.1.5 新增可选的创作资源提供者／消费者、公共客户端和宿主注入选择器；见[准确契约](creation-resources.md)。宿主没有默认来源，插件按自身命名空间与生命周期注册，业务消费者自行校验操作权限。
