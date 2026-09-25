# Doca 插件开发规范

完整目标及尚未实现部分见 [SDK 契约](plugin-sdk-contract.md)。项目尚未上线，删除不合理的旧接口，不维护旧会员、审核或源码加载兼容层。

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
import { definePlugin } from "@doca/plugin-sdk";
import { filesServiceToken } from "@doca/plugin-sdk/files";
import { httpServiceToken, usersServiceToken } from "@doca/plugin-sdk/platform";
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

| 导入入口            | 服务                    | 用途                                         |
| ------------------- | ----------------------- | -------------------------------------------- |
| plugin-sdk/files    | filesServiceToken       | 文件夹、文件、上传、内容、绑定及访问授权     |
| plugin-sdk/platform | usersServiceToken       | 当前授权用户资料、统一用户搜索               |
| plugin-sdk/platform | permissionsServiceToken | 注册业务资源鉴权及用户关系来源               |
| plugin-sdk/platform | httpServiceToken        | 已认证、独立命名空间的后端路由               |
| plugin-sdk/platform | dataServiceToken        | 插件独立 JSON 键值存储，版本条件写入         |
| plugin-sdk/platform | policiesServiceToken    | 创建、存储、分享、转移及 AI 调用前的业务准入 |
| plugin-sdk/platform | eventsServiceToken      | 读取持久事件流，包括 ai.usage.recorded       |
| plugin-sdk/ai       | aiServiceToken          | 注册带 JSON Schema 的 AI 工具和 skill 手册   |

注册 ID 必须以插件 ID 加点开头。数据 scope 和路由 namespace 必须等于插件 ID。这些公共注册自动归属插件生命周期，关闭或启动失败时回收；自建定时器、连接仍用 context.effect/effectAsync 回收。关闭不删除持久数据。

目录来源返回当前有效用户关系。宿主统一执行管理员 all/related/none 策略，并过滤有效用户；来源错误不扩大可见范围。可搜索不等于可以读取资源。当前采用实时来源接口，大规模关系投影仍待实现。

AI 工具通过 `aiServiceToken.registerTool` 注册，包含 id、description、inputSchema 和 execute。execute 获得认证用户、sessionId、turnId、jobId、callId、signal，不能绕过文件权限。`registerSkill` 接收 id、name、description、content、formats；手册进入宿主技能库。业务工具必须自行校验业务资源权限，使用 callId 做副作用幂等。

Doca 不内置会员、货币价格、积分或业务额度。模型管理中的输入/输出速率和每张图片 Token 只负责把厂商原始用量统一折算为 Token，不是最终售价。用量记录区分未确认调用与实际指标；`ai.usage.recorded` 在结算事务内写入持久事件，顶层 `metrics` 是已折算用量，`provider.metrics` 保留厂商原始事实。插件通过 events.read(cursor, limit) 拉取，持久保存消费位置并按事件 ID 幂等处理。策略 check 可以拒绝调用；跨插件预留、失败补偿和资金一致性尚未提供完整事务协议，不能将一次 check 当作完整计费实现。

数据 put(key, value, expectedVersion) 的初始版本是 0；冲突返回 409。单值上限 1 MiB。该接口不是任意宿主 SQL，也不提供跨文件服务事务。

## Web

可选 Web 产物默认导出 `async host => bundle`，host 提供 React 和插件 apiBase。React 从 host 注入，避免重复 renderer；其他依赖须打入浏览器产物，不要求宿主解析 npm 裸路径。bundle 遵循 `@doca/web-plugin-registry` 的 WebPluginBundle，manifest.pluginId/version 与服务端一致，支持页面、导航、管理和设置贡献。

宿主从 `/api/v1/plugin-assets/{id}/{version}/` 提供声明目录，启动前加载注册。插件加载错误隔离并记录，禁止暴露服务端包文件。通用目录树插槽和渲染级错误边界尚待补齐。

## 构建与验证

宿主仓库运行 `pnpm build:plugin-sdk` 生成 SDK、契约和文件能力包的 JS 与 d.ts。使用 pnpm pack 生成发布包，publishConfig 指向 dist；未执行 npm 发布。安装消费者只能依赖发布产物。

至少验证独立安装、无插件启动、依赖冲突、跨用户拒绝、版本冲突、调用幂等、撤销关系、两个宿主实例隔离和关闭回收。测试使用独立数据库、用户和文档。界面文案遵循 [语言规范](i18n.md)，编辑器遵循 [集成规范](editor-integration.md) 和 [协同规范](collaboration-sdk-contract.md)。
