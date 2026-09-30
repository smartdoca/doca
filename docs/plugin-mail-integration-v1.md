# 邮箱插件对接手册：npm、Web、App 与导航 v1

2026-09-30。对接分支：`codex/plugin-store`。本手册描述本轮新增实现，远端商城接口见 [插件商城交互协议](plugin-store-protocol.md)。建议邮箱先完成收件箱、邮件正文、发送及附件的一条闭环，再扩展 AI、搜索和知识库。

## 1. 分发一个完整 npm 包

直接使用商城协议第 8 节的 package.json 示例，包名与 manifest.id 分开：例如 npm 包 `@example/doca-mail`，插件 ID `example.mail`。服务端、Web 产物及全部运行依赖必须随包分发。依赖可打包进产物或作为普通文件 vendored；不要仅声明 npm dependencies 后期待 Doca 执行 npm install。宿主不编译、不运行 install/postinstall，不加载仓库源码。

构建后先执行 `npm pack --dry-run` 检查文件清单，再 `npm pack`。审核绑定该版本完整 tgz 的 SHA-512，不允许同版本换包。不要打包 `.env`、业务数据库、用户邮件、OAuth 凭据或开发证书。

manifest 必须含 schemaVersion=1、id、version、displayName、sdkRange；version 等于 package.json.version。dataVersion 是插件私有数据库结构标识；首版只允许代码版本升高且 dataVersion 不变。插件初始化仍须验证实际数据库结构，不能仅相信包中的标记。

安装方式：

- 官方商城：经审核的明确 npm 版本。
- 管理后台 → 插件商店 → 设置：输入 npm 包名和完整版本。该方式不自动赋予官方审核状态。
- 管理后台上传本地 ZIP；ZIP 根目录直接为 package.json，不能直接上传 npm tgz。
- 停止实例后放入 `<DOCA_PLUGINS_DIR>/<plugin-id>/`，启动时导入共享归档。

所有包变更需重启各实例，目录缺失自动从共享宿主数据库补齐。邮箱数据库、账号凭据、任务队列与 outbox 由邮箱插件负责持久化；包目录不是数据目录，多实例邮件同步须由插件自己协调锁和幂等。

## 2. 服务端接口

沿用 [插件开发手册](plugin-development.md) 的 `definePlugin`、`httpServiceToken`、`usersServiceToken`、`filesServiceToken`。只依赖公开 SDK；不能导入 `@server`、`@core`、`@db` 等宿主私有路径。

注册的 `/messages` 实际为 `/api/v1/plugins/example.mail/messages`。用户身份来自 request.principal。每次读取正文、下载附件、发送或后台同步都重新检查邮箱业务权限及用户状态，隐藏入口不代表撤销权限。

插件专有数据库中保存账号、凭据、邮件索引、发件幂等记录和同步游标。附件通过 files.v1 及 owner binding 管理，使用稳定 id，不存临时 URL。跨数据库写入使用 outbox、幂等键和补偿；不存在宿主提供的统一业务 SQL 或跨库事务。

参考已有 [邮箱能力交接](plugin-mail-handoff.md)，其中 AI、目录交集、通知和文件接口仍有效。全局搜索接入、自动知识库订阅、用户删除协同仍须单独验收，不应因服务 token 存在就宣称完整业务已实现。

## 3. Web 页面与移动复用

`doca.web` 指向浏览器 ESM 入口。默认导出一个函数，收到宿主对象后返回 WebPluginBundle。React 必须使用 host.React；其余依赖由插件打包，不在浏览器解析 bare npm import。

```js
export default function createMailUI(host) {
  const React = host.React;
  function Inbox() {
    const environment = host.useEnvironment();
    const [messages, setMessages] = React.useState([]);
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      const controller = new AbortController();
      host.request("/messages", { signal: controller.signal })
        .then(result => setMessages(result.items))
        .catch(reason => {
          if (!controller.signal.aborted) setError(reason.message);
        });
      return () => controller.abort();
    }, []);
    return React.createElement("section", { "data-target": environment.target },
      error && React.createElement("p", { role: "alert" }, error),
      ...messages.map(message => React.createElement("button", {
        key: message.id,
        onClick: () => host.navigate(`/plugins/example.mail/message/${message.id}`)
      }, message.subject))
    );
  }
  return {
    manifest: {
      pluginId: "example.mail", version: "1.2.0", targets: ["web", "mobile"],
      routes: ["example.mail.inbox", "example.mail.message"]
    },
    routes: [
      { id: "example.mail.inbox", pluginId: "example.mail",
        path: "/plugins/example.mail/inbox", render: () => React.createElement(Inbox) },
      { id: "example.mail.message", pluginId: "example.mail",
        path: "/plugins/example.mail/message/:id",
        render: (_context, match) => React.createElement("p", null, match.params.id) }
    ]
  };
}
```

这是展示路由与加载方法的最小示例，正文页需替换成真实组件，/messages 的结果结构由邮箱接口定义。不要把示例当完整邮箱。

host.useEnvironment 返回 locale（zh/en）、theme 和 target（web/mobile）。按 target 与容器宽度适配，不自己读取 Doca localStorage。host.request 只访问当前插件 API 命名空间；host.navigate 在 App 中只允许插件自己的 `/plugins/<id>/...` 路径，自动保留移动容器前缀。

host.toast、confirm 可用。Web 的 FilePicker 继续遵循现有公开 props；**App 的受限会话不允许调用宿主文件选择器相关 API，因此首版移动页面不要使用 host.FilePicker**。移动附件可先由插件自有 UI 选择并经插件 API 上传；宿主原生文件选择、相机、推送、剪贴板桥尚未提供。页面不能通过 postMessage 请求任意原生操作。

## 4. 静态导航声明

在 package.json 的 doca.navigation 注册入口，完整例子见商城协议第 8 节。使用 `example.mail.inbox` 等稳定 ID、zh/en 标题、语义图标名（如 mail）、完整 webPath、allowedSlots、defaults 和 order。App 支持时设置 mobile=true 和 doca.mobileHostRange="^1.0.0"。

入口声明和页面注册分别负责“入口放在哪里”和“打开后渲染什么”。即使 JS bundle 注册了旧式 navigation contribution，新的管理员导航管理也以静态声明为准；不提供旧包兼容代码。

支持 Web 左侧、顶部、头部右侧、右侧工具栏、用户菜单、首页、更多、管理后台；App 侧滑栏、底部、头部右侧、个人菜单、首页、更多。右侧工具栏的入口打开页面，不代表任意页面支持嵌入右侧面板。

管理员可发布 Web/App 布局，覆盖位置、排序、名称、图文显示和分组；有草稿与版本冲突检查。配置统一为 `{ schemaVersion: 1, layout: { placements, home? } }`，全局只有一套布局。管理界面分为 Web 用户入口、App 用户入口、Web 管理员入口三个页签，不再支持按人群和优先级匹配规则。用户页面与管理员页面严格分开，管理员入口仅允许放入 `web.admin`。旧 `rules` 配置被拒绝，不提供自动转换。底部最多四个配置入口，另保留“更多”；顶部和右侧区域溢出进入更多。插件在当前平台没有其他可见导航入口时，才显示在“更多”中作为兜底；已有左侧、顶部等入口时不重复显示。

发布布局后刷新生效；能力声明随包升级、重启生效。运行目录不包含已停用插件，业务权限仍由接口校验。

## 5. App 会话与安全边界

App 必须先升级到包含插件宿主的版本；之后兼容插件不需要重新编译 App。App 获取 `/api/v1/navigation` 并在进入前台时刷新，点击插件入口申请绑定该入口所属插件的一次性票据。

- 票据 60 秒有效、单次兑换，绑定原 App session 和插件 ID。
- 兑换出 30 分钟的独立 HttpOnly Cookie，会话不是完整宿主会话。
- 服务端每次检查原 App session 仍有效、用户有效、插件在本实例已加载。
- 只允许只读 bootstrap、该插件静态资源及该插件 API；管理后台、其他插件和宿主文件 API 均拒绝。
- 原 App session 注销/失效会使派生会话失效；停用在实例重启后生效。
- WebView 限制同源、当前插件路径，不暴露长期 bearer token，无通用原生执行桥。

这是授权范围限制，不是插件 JavaScript 或 Node.js 沙箱。邮件 HTML 必须由邮箱插件自行净化；远程邮件图片默认阻断或经受控代理，防止跟踪。凭据只在插件服务端保存。

## 6. 首轮邮箱验收

使用隔离用户、邮箱测试服务、临时数据目录与数据库，不用真实用户邮件：

1. 空插件目录下宿主仍正常运行；安装完整 npm 包并重启后 Web 入口出现。
2. Web 收件箱 → 正文 → 附件 → 发送；发送重试不重复，切换用户不得看到对方邮箱。
3. App 各导航位置能打开相同页面，布局发布后前台刷新生效，Web-only 插件不出现在 App。
4. 票据重放失败；受限会话访问 `/admin`、其他插件及全局文件 API 被拒绝；注销后不可继续请求。
5. 升级后目标/运行版本与待重启提示正确；dataVersion 不匹配拒绝。
6. 第二实例空插件目录、npm/商城离线时自动补齐；业务数据库和同步锁由插件自行验证。
7. 禁用/卸载后重启不再出现入口，邮件和账号数据保留。
8. 回报不足时附宿主/SDK/App/插件版本、安装来源、最小重现、脱敏请求 ID；不要提交真实邮件或凭据。

当前尚未完成真机/模拟器与独立邮箱 npm 包的端到端验收；源码检查和宿主测试不能替代这一步。

## 首页最近访问

邮箱可以注册 `activity.v1` 数据源，将邮件或会话加入首页最近访问。邮件访问记录和删除清理由邮箱插件自行管理；宿主不复制记录。注册 `permissions.v1` 的 `activity.read` 动作，提供来源的 `list/get` 方法和邮件图标，并在插件依赖中声明 `activityServiceToken`。完整接入示例与分页约定见[插件接入首页最近访问](plugin-activity.md)。
