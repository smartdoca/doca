# Doca 插件开发规范

[English](plugin-development.md)

完整目标及尚未实现部分见 [SDK 契约](plugin-sdk-contract.zh-CN.md)。项目尚未上线，删除不合理的旧接口，不维护旧会员、审核或源码加载兼容层。

## 许可证边界

Doca 及公开插件 SDK 采用 [MIT](../LICENSE)。插件可以开源，也可以闭源。许可说明见
[中文说明](../LICENSING.zh-CN.md)。

插件不得把许可证不明、禁止再分发或与其发布方式不兼容的依赖打入正式制品。所有
第三方 NOTICE、源码提供和署名义务由插件发布者继续履行。Doca 的许可证不会覆盖
插件发布者无权许可的第三方内容。

## 安装与启动

宿主只读取 `DOCA_PLUGINS_DIR/package.json` 的直接 dependencies。默认目录是 `${DOCA_DATA_DIR:-./data}/plugins`。在这个独立目录执行 npm/pnpm 安装，重启 Doca 生效。安装目录应位于宿主发布目录之外，升级宿主不会覆盖插件；SDK 版本仍须匹配。

插件包的 package.json：

```json
{
  "name": "@example/attachments",
  "version": "1.0.0",
  "type": "module",
  "doca": {
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
  "sdkRange": "^0.1.0",
  "dependencies": [{ "id": "doca.files", "range": "^0.1.0" }]
}
```

仅加载已编译 JavaScript，不扫描间接依赖，不运行安装命令，不使用 doca.config.ts 或仓库源码目录。支持 scoped 包和 pnpm 链接。入口、静态资源和真实符号链接路径必须位于包声明的目录内。依赖冲突在执行插件前报错。

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

注册 ID 必须以插件 ID 加点开头。路由 namespace 必须等于插件 ID。这些公共注册自动归属插件生命周期，关闭或启动失败时回收；自建定时器、连接仍用 context.effect/effectAsync 回收。关闭不删除持久数据。

目录来源返回当前有效用户关系。宿主统一执行管理员 all/related/none 策略，并过滤有效用户；来源错误不扩大可见范围。可搜索不等于可以读取资源。来源使用 schemaVersion: 1、分页 related 和当前事实 verify，插件自行维护关系索引；分页、超时和候选复核见交接文档。

AI 工具通过 `aiServiceToken.registerTool` 注册，包含 id、description、inputSchema 和 execute。execute 获得认证用户、sessionId、turnId、jobId、callId、signal，不能绕过文件权限。`registerSkill` 接收 id、name、description、content、formats；手册进入宿主技能库。业务工具必须自行校验业务资源权限，在插件数据库保存跨重试稳定的操作 ID 做副作用幂等；callId 可用于关联调用，但不能假定新调用会复用旧 callId。文件/文件夹创建应传稳定 idempotencyKey；上传创建同时传 uploads.complete 返回的 contentIdentity。使用 files.receipts.get 查询持久回执；pending 可重试、异参为 409，已删除结果不能借重放重建。完整协议见 SDK 契约第 7.1 节。

Doca 不内置会员、货币价格、积分或业务额度。模型管理中的输入/输出速率和每张图片 Token 只负责把厂商原始用量统一折算为 Token，不是最终售价。用量记录区分未确认调用与实际指标；`ai.usage.recorded` 在结算事务内写入持久事件，顶层 `metrics` 是已折算用量，`provider.metrics` 保留厂商原始事实。插件通过 events.read(cursor, limit) 拉取，持久保存消费位置并按事件 ID 幂等处理。策略 check 可以拒绝调用；跨插件预留、失败补偿和资金一致性尚未提供完整事务协议，不能将一次 check 当作完整计费实现。

插件自管独立数据库、凭证、业务任务和 outbox。宿主不提供 data.v1/data.v2。使用 initialize/mount/ready/dispose 初始化和清理。数据库必须按插件当前基线新建；结构不匹配时拒绝启动。

## Web

可选 Web 产物默认导出 `async host => bundle`，host 提供 React、apiBase、useEnvironment、navigate、toast、confirm、request 和 FilePicker。React 从 host 注入，避免重复 renderer；其他依赖须打入浏览器产物，不要求宿主解析 npm 裸路径。bundle 遵循 `@smartdoca/web-plugin-registry` 的 WebPluginBundle，manifest.pluginId/version 与服务端一致，支持页面、导航、管理和设置贡献。

宿主从 `/api/v1/plugin-assets/{id}/{version}/` 提供声明目录，启动前加载注册。插件加载错误隔离并记录，禁止暴露服务端包文件。贡献 render 已加入错误边界；通用目录树插槽尚待补齐。

## 构建与验证

宿主仓库运行 `pnpm build:plugin-sdk` 生成 SDK、契约和文件能力包的 JS 与 d.ts。发布到 npm 的包名是 `@smartdoca/plugin-sdk`，以及它再导出的契约包。`publishConfig` 指向 `dist`。安装插件时依赖这些发布产物，不要依赖仓库源码。

至少验证独立安装、无插件启动、依赖冲突、跨用户拒绝、版本冲突、调用幂等、撤销关系、两个宿主实例隔离和关闭回收。测试使用独立数据库、用户和文档。界面文案遵循 [语言规范](i18n.zh-CN.md)，编辑器遵循 [集成规范](editor-integration.zh-CN.md) 和 [协同规范](collaboration-sdk-contract.zh-CN.md)。

HTTP 回调、附件绑定授权、用户校准、搜索与知识接口，以及 Mobile 接入边界，见 [邮箱插件交接](plugin-mail-handoff.zh-CN.md)。

## 接入范围与交付门槛

`search.v1` 是宿主统一搜索基础能力；插件内搜索、全局搜索和 AI 检索分别控制来源范围。注册来源不代表全局 endpoint/UI 已接通，也不自动授权 AI 使用。知识来源注册不等于自动订阅：宿主负责知识订阅、调度、订阅游标与派生索引，插件负责外部业务、凭证、同步及当前权限事实。详细分级和待实现项目见 [邮箱交接需求清单](plugin-mail-handoff.zh-CN.md#调整后的接入需求与验收顺序)。

交付验收需用实际宿主交付物、SDK 和业务插件 tgz，在仓库外的隔离环境安装启动。预备完整依赖闭包，禁止依赖源码链接、未声明缓存或安装/启动时访问包仓库；实际验证 Web 资源加载、业务流程、撤权、失败重试和重启恢复。SDK 构建及导入成功仅是基础验证，不可替代端到端验收。

禁用、卸载和数据保留行为在首次交付确定。插件数据库只接受当前空库基线，结构不匹配时拒绝启动，不运行升级或降级脚本。用户删除协议与动态 WebView 尚未提供，不要将其写成可调用示例。默认数据目录和任务状态管理不会赋予宿主访问插件数据库的权限。

## 后台身份复核与通知

`users.status(userId)` 为可信服务端任务返回当前 `{id, status}` 或 null。非 active 时停止业务操作；账号有效不代表拥有业务资源权限。

`notificationsServiceToken` 导出 `notifications.v1`：`publish(pluginId, {recipientId, key, title, body, path, resource: {type, id}})` 和 `withdraw(pluginId, {recipientId, key})`。宿主限制只能使用自己的 pluginId。key 非空且最多 200 字符，按插件和收件人隔离；同参数重放返回同一 `{id}`，异参返回 409，已撤回返回 410。插件在自己的 outbox 中保证先发布后撤回。

资源类型在 permissions.v1 注册并实现 `notification.read`。发布、列表、未读数和点击均复核当前权限；来源缺失、禁用、失败或超时均拒绝。标题和正文为纯文本，分别最多 200 和 2000 字符。path 使用 `/mail/<id>?message=...` 这样的站内路径，不含 origin 或 hash。链接先经过宿主鉴权端点再跳转，插件页面及 API 仍须自行鉴权。

本实例发布后实时刷新 Web，Web 每 30 秒对账其他实例的通知。这是站内通知，不包含 SMTP、移动推送或桌面通知。

HTTP 注册默认限制请求体 1 MiB；需要附件等大请求的单条路由可指定 `bodyLimit`（字节），最大 32 MiB。插件仍需校验附件数量、实际解码大小及业务总量。
