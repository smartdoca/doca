# Doca 插件商城交互协议 v1

更新：2026-09-30。**远端商城开发以本文为准。** 本文替换此前“全量目录 + 商城托管 ZIP”的草案，不需要兼容旧接口。

状态：本协议是本轮确定的实现目标；Doca 分支 `codex/plugin-store` 正在接入。已有 ZIP 安装、共享归档、多实例启动补齐；npm 安装、远端分页、更新检查、新详情和导航/App 宿主已接入源码并有本地测试；远端服务与独立插件的端到端联调尚未完成。不要把本文视为全部能力已经上线的证明。远端可立即按本文实现，并用下方验收用例提供 fixtures。

## 1. 职责和部署

- npm registry 分发完整、预编译的插件包。商城不提供 ZIP 下载接口，但审核系统必须检查具体 npm 包字节。
- 远端商城维护插件资料、分类、版本目录、审核/撤回状态、点赞与下载统计、富文本详情。
- Doca 维护管理员权限、安装事务、完整性校验、共享归档、运行版本、Web/App 入口和布局配置。
- 点赞、GitHub 登录均在远端网站完成。Doca 只展示点赞量，并在用户点击后提示打开新页面；不收取远端登录凭据，不实现点赞 API、OAuth 回调或账号绑定。
- Doca 仍支持手动 npm 安装和本地 ZIP / 目录安装。目录外安装标为“未经官方审核”；下载自 npm 本身不等于官方审核通过。

```dotenv
DOCA_PLUGIN_STORE_URL=https://store.smartdoca.cc
DOCA_PLUGIN_NPM_REGISTRY=https://registry.npmjs.org
DOCA_PLUGINS_DIR=/data/plugins
```

两个地址都是 HTTPS origin，不允许凭据、路径前缀、query 或 fragment。空值使用默认值。首版不支持私有 registry 登录。Doca 服务端代理全部商城 API 请求，不向远端转发浏览器 Cookie、Authorization、用户 ID 或业务数据；远端无需开放浏览器 CORS。

API 前缀 `/api/v1`。JSON UTF-8，响应带 `protocolVersion: 1`。时间为 UTC ISO 8601，计数为非负安全整数，未知计数为 `null`，不能以 0 代替未知。所有接口公共只读，无需商城登录。

## 2. 公共类型

### PluginSummary：卡片资料

```json
{
  "id": "example.mail",
  "name": "邮箱",
  "summary": "收发邮件与管理多个邮箱账号。",
  "author": { "name": "Example", "url": "https://github.com/example" },
  "categoryId": "productivity",
  "icon": null,
  "detailPath": "/plugins/example.mail",
  "targets": ["web", "mobile"],
  "review": "approved",
  "latestVersion": "1.2.0",
  "downloads": { "count": 1234, "period": "last30Days", "source": "npm", "asOf": "2026-09-30T00:00:00Z" },
  "likes": { "count": 42, "asOf": "2026-09-30T00:00:00Z" },
  "updatedAt": "2026-09-29T12:00:00Z"
}
```

约束：

- `id`：与安装包 manifest.id 相同，匹配 `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`，最多 100 字符。
- `name` / `author.name`：1–160 字符；`summary`：最多 300 字符，均为纯文本。
- `author.url`：HTTPS URL 或 null，仅供用户点击，不由宿主自动抓取。
- `categoryId`：1–60 字符，`[a-z0-9-]+`；分类列表单独获取，不从当前页推导。
- `icon`：PNG data URL 或 null，编码后总长不超过 24 KiB；不接受 SVG、脚本或远端图片 URL。
- `detailPath`：商城同源绝对路径 `/plugins/<id>`；由 Doca 拼接配置的商城 origin，禁止外部 origin、query、fragment、路径穿越。打开新页使用 `noopener,noreferrer`。
- `targets`：非空且去重的 `web` / `mobile` 数组。mobile 指 App 内受控 WebView 页面，不是动态原生代码。
- `review`：`approved | suspended`。列表默认仅返回 approved；详情允许 suspended。
- `latestVersion`：最新审核通过的稳定版本或 null，**不代表对当前 Doca 可安装或可升级**。
- npm 近 30 天下载数是包下载统计，不是 Doca 安装人数，也不是具体版本下载数。
- 未提供统计时仍返回对象：count/asOf 为 null。列表不返回富文本正文、历史版本数组、npm tarball 或完整导航配置。

### Release：一个不可变版本

```json
{
  "pluginId": "example.mail",
  "version": "1.2.0",
  "sdkRange": "^0.1.0",
  "dataVersion": "1",
  "targets": ["web", "mobile"],
  "mobileHostRange": "^1.0.0",
  "dependencies": [],
  "review": "approved",
  "reviewedAt": "2026-09-29T12:00:00Z",
  "publishedAt": "2026-09-29T10:00:00Z",
  "npm": {
    "registry": "https://registry.npmjs.org",
    "name": "@example/doca-mail",
    "version": "1.2.0",
    "integrity": "sha512-BASE64_OF_SHA512_DIGEST",
    "size": 12345
  }
}
```

示例摘要是占位值；实际必须为 SHA-512 的 64 字节摘要，标准 base64，单个 SRI 值。`npm.size` 为准确 tgz 字节数，1–33,554,432。`npm.version`、Release.version、package.json.version、manifest.version 必须一致。

`version` 采用三段 semver，可含 prerelease，不含 build metadata；最多 100 字符。`sdkRange` 与插件 manifest 完全一致；当前 SDK 能力基线 0.1.0，支持 `*`、精确值、`^`、`~`。`mobileHostRange` 在 targets 含 mobile 时必填，表示移动插件宿主协议版本（首版 1.0.0），不是 App 商店构建号。Doca SDK 与移动宿主协议分别判断。

`dataVersion` 为 `[a-zA-Z0-9._-]{1,80}`，不比较大小；首版升级必须完全相同。dependencies 为最多 100 个 `{id,range,optional?}`，属于 Doca 插件依赖，不是 npm dependencies。首版不自动安装依赖插件。

版本 review 为 `approved | withdrawn`；撤回后禁止新安装，不自动卸载已运行版本。即使 npm 发布了更高版本，未经审核的版本也不能出现在官方更新推荐中。

商城审核绑定 `(pluginId, npm.registry, npm.name, version, integrity, size)`；不得同版本换包。作者、下载量、点赞量、审核撤回状态可以更新，包内容及其能力声明不可变。

## 3. 分类

`GET /api/v1/categories?locale=zh`

```json
{"protocolVersion":1,"items":[{"id":"productivity","name":"效率工具","count":12}]}
```

最多 100 个分类。locale 仅 `zh | en`，缺省 zh；没有译文时返回默认文案。count 为当前已审核可见插件总量或 null，不受列表当前搜索条件影响。

## 4. 插件列表：服务端分页、搜索、排序

`GET /api/v1/plugins?q=mail&category=productivity&target=mobile&sort=downloads&limit=24&locale=zh`

| 参数 | 规则 |
| --- | --- |
| q | 可选，修剪后最多 100 字符；搜索名称、简介、作者、plugin id、npm 包名；远端实现匹配 |
| category | 可选分类 ID，省略为全部 |
| target | 可选 `web` / `mobile`，省略不限 |
| sort | `updated`（默认）、`downloads`、`likes`、`name` |
| limit | 1–48，默认 24 |
| cursor | 可选不透明游标，最多 2048 字符 |
| locale | zh / en，默认 zh |

```json
{
  "protocolVersion": 1,
  "items": [],
  "page": { "nextCursor": null, "total": 0, "snapshotAt": "2026-09-30T00:00:00Z" }
}
```

items 为 PluginSummary[]，不超过 limit。total 为匹配总数或 null；nextCursor 为 null 表示末页。客户端“加载更多”只追加当前查询的结果；更改搜索、筛选、排序后清空游标重新请求，取消旧请求或忽略旧响应，不能把不同查询结果混合。

排序：updated 按 updatedAt 降序；downloads 按近 30 天下载量降序；likes 降序；name 按本地化名称升序；均以 id 升序稳定打破平局。未知统计排在已知之后。

游标必须绑定规范化查询、排序及结果快照；后续分页保持 snapshotAt。快照至少有效 15 分钟，防止统计变化导致翻页重复或漏项。过期返回 410 `cursor_expired`，客户端重新开始；参数不匹配返回 400 `cursor_mismatch`。不得让 Doca 下载整个目录后自行搜索、排序或分页。

单页响应上限 2 MiB，15 秒超时。可返回 ETag；Doca 只有缓存匹配响应时才发送 If-None-Match，304 使用缓存。

## 5. 插件详情：资料与只读富文本

`GET /api/v1/plugins/<id>?locale=zh`

```json
{
  "protocolVersion": 1,
  "plugin": { "id": "example.mail", "name": "见 PluginSummary，实际必须返回完整对象" },
  "description": {
    "format": "doca-slate",
    "version": 1,
    "nodes": [
      { "type": "heading", "level": 2, "children": [{"text":"邮箱插件"}] },
      { "type": "paragraph", "children": [{"text":"支持多个邮箱账号。","bold":true}] }
    ]
  }
}
```

这里缩写的 plugin 必须实际返回完整 PluginSummary。详情不嵌入全部版本；版本另行分页。正文由远端使用 slatetsx 编辑、持久化并转换到下述传输结构；Doca 只读展示，无编辑、保存或加载远端编辑器插件的行为。`doca-slate` 是明确的传输子集，不承诺任意 slatetsx 内部节点都可直接传递。

### 富文本 v1 节点

- 文本：`{text:string,bold?:boolean,italic?:boolean,underline?:boolean,strikethrough?:boolean,code?:boolean}`。
- paragraph：`{type:"paragraph",children:Inline[]}`。
- heading：同上，另含 level 整数 1–6。
- link：行内 `{type:"link",url:string,children:Text[]}`，仅允许 https/http/mailto，拒绝控制字符、javascript/data URL；外链新窗口使用 noopener,noreferrer。
- blockquote：`{type:"blockquote",children:Block[]}`。
- bulleted-list / numbered-list：`{type:...,children:ListItem[]}`；list-item：`{type:"list-item",children:Block[]}`。
- code-block：`{type:"code-block",language?:string,children:Text[]}`，纯文本呈现，不执行代码。
- image：`{type:"image",src:string,alt:string,children:[{text:""}]}`。src 是 PNG/JPEG/WebP data URL，单张解码后最多 256 KiB；拒绝 SVG、远程 URL，避免私有地址请求与追踪。
- divider：`{type:"divider",children:[{text:""}]}`。

不支持的节点保留安全的文本子节点并提示部分内容无法显示；未知 format/version 给出明确提示和远端详情页链接，不执行 HTML/JSX。不接受原始 HTML、自定义脚本、iframe、可执行组件、事件处理字段。正文最多 5000 节点、16 层、200000 文本字符，详情响应总计最多 2 MiB。远端负责转换表格等尚未支持的类型为段落或图片。新增节点需协调协议与渲染器。

## 6. 版本列表和安装前核验

`GET /api/v1/plugins/<id>/releases?limit=20&cursor=...`

返回 `{protocolVersion:1,items:Release[],page:{nextCursor,total,snapshotAt}}`，规则同列表，limit 1–48。按 semver 降序，默认含审核通过的稳定版本；可选 `includePrerelease=true`。明确撤回版本仅通过下面的精确查询返回。

`GET /api/v1/plugins/<id>/releases/<version>`

返回 `{protocolVersion:1,release:Release}`。安装操作必须重新获取精确版本审核状态与摘要，不能直接使用过期列表。404 表示未知版本；withdrawn 在 200 响应中明确给出并拒绝安装。

### npm 下载流程

1. 验证 Release.npm.registry 等于宿主配置的 registry（首版默认 npmjs），禁止商城任意指定下载源。
2. 从 registry 获取精确包版本元数据：`GET /<encodeURIComponent(packageName)>/<encodeURIComponent(version)>`，不解析 latest/tag/range。
3. 验证 registry 元数据 name/version、dist.integrity 与商城审核的 SRI 一致；下载 dist.tarball。
4. tarball 必须 HTTPS 且同 registry origin，无凭据、fragment；不跟随重定向。元数据不超过 2 MiB，15 秒；下载不超过 32 MiB，120 秒，校验大小和 SHA-512。
5. 安全解包 npm tgz，要求根目录 `package/`，剥离一次；只接受普通文件/目录，拒绝符号链接、硬链接、设备、绝对路径、穿越、重复路径。最大 10000 项、128 MiB 展开量；流式限制解压大小。
6. 核对 package / manifest / 审核元数据，发布完整归档和目标状态。npm 生命周期脚本一律不运行，不执行 npm install，也不下载缺失运行依赖。

手动 npm 安装使用相同校验流程，摘要取配置 registry 的精确版本元数据，但没有官方审核背书。商城首页故障不影响手动安装；已安装包的启动不依赖 npm 或商城在线。

## 7. 批量检查已安装插件更新

`POST /api/v1/updates/check`

```json
{
  "protocolVersion": 1,
  "host": { "sdkVersion": "0.1.0", "mobileHostVersion": "1.0.0" },
  "plugins": [
    { "id": "example.mail", "version": "1.0.0", "dataVersion": "1", "npm": {"registry":"https://registry.npmjs.org","name":"@example/doca-mail"} }
  ]
}
```

每批 1–100 个不同插件 ID，最多 128 KiB。仅提交安装元数据，不提交站点标识、用户、配置、数据内容或业务凭据。超过 100 个由 Doca 分批请求。无 npm 来源的本地包可省略 npm，仍可检查同 ID 官方版本，但不能默默把其安装来源切换到官方。

```json
{
  "protocolVersion": 1,
  "checkedAt": "2026-09-30T00:00:00Z",
  "items": [
    {
      "id": "example.mail",
      "installedVersion": "1.0.0",
      "status": "update_available",
      "currentReview": "approved",
      "latestVersion": "1.2.0",
      "release": { "pluginId": "example.mail", "version": "实际为完整 Release 对象" },
      "reason": null
    }
  ]
}
```

每个请求项必须恰好返回一个结果，installedVersion 回显输入，避免客户端把旧响应套用到安装后的新版本。status：

| status | 意义 |
| --- | --- |
| update_available | 存在更高、已审核且 SDK/dataVersion/移动宿主协议兼容的稳定版本，release 必须为完整 Release |
| up_to_date | 没有更高的已审核稳定版本，release=null |
| incompatible | 有更高版本，但无兼容候选，release=null；reason 为 sdk / data_version / mobile_host |
| unknown | 商城无此插件或来源包不匹配，release=null；reason 为 not_found / source_mismatch |

currentReview 为 approved / withdrawn / unknown。当前版本被撤回时单独提醒，不自动删除或停用。插件其他依赖是否已安装由 Doca 在安装时再次检查，远端更新建议不保证本地依赖图可满足。

选择最高兼容版本，而不是只检查最新版本。latestVersion 是最高审核稳定版本，可高于 release.version。Doca 必须自行再次验证版本、SDK、数据结构及依赖，不能把远端结论当授权。

Doca 打开“已安装 / 可升级”时检查，提供手动刷新，可缓存 15 分钟；安装操作后使该插件检查结果失效。失败显示“更新检查失败/未知”，不能显示“全部最新”。正在卸载的插件不提示升级。比较的是全局目标安装版本，运行版本与待重启状态另行显示。目录外 npm 包可从 registry 检查版本，但必须维持“未经审核”标识且不得自动安装。

批量响应上限 2 MiB、15 秒。局部未知以 items 状态表达；整体网络/限流/格式错误使用 HTTP 错误，不虚构正常结果。

## 8. 安装包及导航声明

npm tgz 内 `package/package.json`；本地 ZIP 内直接为 `package.json`，没有 wrapper。

```json
{
  "name": "@example/doca-mail",
  "version": "1.2.0",
  "type": "module",
  "files": ["manifest.json", "dist", "web"],
  "doca": {
    "dataVersion": "1",
    "manifest": "./manifest.json",
    "server": "./dist/server.js",
    "web": {"directory":"./web","entry":"./index.js"},
    "mobileHostRange": "^1.0.0",
    "navigation": [{
      "id": "example.mail.inbox",
      "title": {"zh":"邮箱","en":"Mail"},
      "icon": "mail",
      "webPath": "/plugins/example.mail/inbox",
      "mobile": true,
      "allowedSlots": ["web.left","web.top","web.topRight","web.right","web.user","web.home","web.more","mobile.drawer","mobile.bottom","mobile.topRight","mobile.account","mobile.home","mobile.more"],
      "defaults": ["web.left","mobile.drawer"],
      "order": 60,
      "adminOnly": false
    }]
  }
}
```

插件必须预编译并打包完整运行依赖，不允许宿主源代码别名、全局桥接或 pnpm 符号链接树。服务端默认导出插件工厂；Web 默认导出 `host => bundle`，React 使用宿主注入。业务数据库由插件自己管理，卸载不删除。

导航由静态 package.json 声明，id 必须在插件命名空间内，webPath 必须位于 `/plugins/<plugin-id>/`；对应页面仍须在 Web bundle 注册。navigation 最多 30 项，allowedSlots/defaults 去重，defaults 是 allowedSlots 子集。无 mobile 声明不得出现 mobile 槽；声明 mobile 必须提供 Web 页面及 mobileHostRange。

完整位置集合为上述 13 个以及 `web.admin`。web.right 表示右侧**入口工具栏**；它不会自动把任意页面嵌成侧边面板。第一版入口打开页面，任意面板/抽屉组件协议另行定义，不得声称已经支持。

管理员在 Doca 内按 Web/App 调整显示、位置、排序和分组，布局不是远端商城配置。插件只能提供默认值和支持范围。底部等区域有容量限制，溢出入口进入“更多”；插件停用后不出现在运行目录。导航隐藏不撤销路由/API 权限，后者仍由宿主与插件逐请求校验。

商城审核需核对 targets 与实际 web/mobile 声明、sdkRange、dataVersion、dependencies、npm 包身份和版本一致；商城不替代宿主再次校验。Release 不复制完整导航配置，安装包是能力声明的来源。

App 需要先发布包含移动插件宿主的版本。此后符合协议的页面通过受控 WebView 加载，不下载执行 React Native 模块。登录使用宿主一次性票据，不把长期 App bearer token 传给插件脚本。App 插件页面跳转与宿主调用范围由开发手册定义。

## 9. 错误、缓存、审核撤回

```json
{"protocolVersion":1,"error":{"code":"not_found","message":"Plugin not found"}}
```

HTTP：400 invalid_request/cursor_mismatch，404 not_found，410 cursor_expired，429 rate_limited（Retry-After 秒数），503 unavailable。message 为纯文本，客户端不依赖它做逻辑判断。远端不返回登录 HTML、重定向或堆栈信息。查询失败保留本地管理，显示可重试错误；无法校验时不得继续安装。

详情及单版本审核状态建议缓存最长 60 秒；安装前精确版本请求要求重新验证，不使用离线缓存。审核不是绝对安全保证，Doca 服务端插件仍在受信进程执行，不能以“已审核”宣传沙箱隔离。

商城内部审核、作者发布、GitHub 登录和点赞写接口由商城自定，不属于 Doca 对接范围。发布顺序：先发布 npm 包 → 获取真实不可变字节 → 审核扫描与能力核对 → 发布 approved Release → 更新摘要和检索索引。

## 10. 多实例与生效时机

安装事务将完整包归档及全局目标状态写入共享宿主数据库，各实例使用私有可写插件目录。启动时逐文件核验和补齐，禁止运行半包；启动不访问 npm/商城。缺失或损坏的共享归档应明确报错。

安装、升级、启用、禁用、卸载需逐个重启实例。管理页展示响应实例的运行版本，不宣称集群全部生效。建议 Docker Compose：`docker compose restart doca`；Kubernetes 等由运维逐实例滚动重启，API 不兼容时需排空旧实例流量。

历史版本 Web 静态资源可从共享归档补齐，不等于不同版本业务 API 兼容。导航布局发布后客户端刷新生效，无需重启；插件能力声明变更属于包升级，仍需重启。卸载保留业务数据、不可变归档及数据版本标记。

## 11. 联调交付清单

远端至少提供以下 fixture / 用例：

1. 空列表，超过两页的列表，搜索/分类/平台筛选，四种排序；游标过期和参数不匹配。
2. 完整摘要，未知统计，已暂停插件详情，合法富文本与未知节点降级。
3. 版本分页；最新版不兼容但存在较低兼容更新；所有新版不兼容；当前版本撤回；未知插件/包名不匹配。
4. 已审核 npm 包及真实 SRI/长度，包被替换、摘要错误、声明不一致、下载重定向、解压穿越等拒绝场景。
5. 429/503/超时；远端故障不影响已安装插件列表与 App 当前业务使用。
6. Doca 安装到一个实例，第二实例空目录且 npm/商城离线时重启自动补齐；损坏本地缓存后修复。
7. Web/App 声明与导航位置核对；无移动声明的插件不出现在 App；数据结构不兼容升级拒绝。
8. 点赞按钮仅打开配置商城同源详情页，不调用点赞接口，不启动 Doca OAuth 流程。

邮箱可直接按 [邮箱插件对接手册 v1](plugin-mail-integration-v1.md) 开始。

开发手册入口：[插件开发](plugin-development.md)、[中文插件开发](plugin-development.zh-CN.md)、[SDK 能力边界](plugin-sdk-contract.md)。这些文档正在随实现更新；遇到冲突以已导出的 SDK 类型与本页远端协议分别为准，不猜测尚未实现的宿主 API。

## 跨仓库验收

运行 `pnpm exec tsx scripts/verify-plugin-store-contract.ts ../doca-plugin-store`，使用商城实际路由和内存数据库验证 Doca 客户端对分类（含零数量）、搜索、平台过滤、游标分页、详情、版本、更新及游标过期的兼容性；不会读写商城业务数据库或发布 npm 包。

当前辅助列表为 `/categories`，不是自由多标签系统；插件使用单一 `categoryId`。分类数量为全商城已上架插件数量，不随当前搜索条件变化；列表 `page.total` 为当前查询快照数量。未知下载/点赞数量显示破折号，零显示 0。

商城审核需检查与宿主一致的静态导航字段：双语 title（各 1–80 字符）、icon、order、非空 allowedSlots 及合法 defaults，拒绝未知字段；server 必须为已构建 JS/mjs/cjs 文件，Web 入口为 JS，manifest 为静态 JSON。审核与安装均不得执行包内安装脚本。

### 官方身份和版本说明显示

`PluginSummary.official`（列表和详情的 `plugin`）为必填布尔值，表示商城标注的官方插件身份，与版本审核状态分开。客户端仅在值为 `true` 时展示“官方插件”，不能根据安装来源推断；缺失字段的响应视为协议错误。

`Release.changelog` 为必填字符串，表示该版本的纯文本更新说明，版本列表及单版本接口均须返回。空字符串表示未提供，客户端按纯文本保留换行展示，不执行 HTML。Doca 接收长度上限为 100000 字符。
