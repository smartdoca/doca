# 监控与遥测

[English](plugin-monitoring.md)

SDK 源码 **0.1.11** 已实现。通过 `@smartdoca/plugin-sdk/monitoring` 导入 `monitoringServiceToken`（`monitoring.v1`）、`telemetryServiceToken`（`telemetry.v1`）及类型。SDK 0.1.11 的 npm 验证记录见下方发布章节，生产部署另行验收。

## 声明与访问权限

把所用服务写入 `injections.required`，声明从 0.1.11 开始的范围，例如 `sdkRange: "^0.1.11"`。缺少服务或使用更早的 SDK 范围会明确失败。新服务不适配旧宿主；原有 SDK 方法、`events.v1`、数据库结构和持久化格式保持原行为。

服务端插件是管理员安装的可信代码。声明并注入监控服务意味着该服务端插件可以在后台采集全站运行事实，不意味着普通用户可以读取这些记录。插件自己的路由、后台任务和 AI 工具仍须授权，不得自动把全站日志或审计数据提供给普通用户或模型。

在 mount 注入 monitoring 才会启用插件的 Web 读取权限。`host.platform.monitoring` 经 `/api/v1/plugin-platform/<pluginId>/monitoring.<method>` 调用同一组固定方法；宿主每次复核插件监控作用域和数据库中当前账号的 active、admin 状态。未安装或未运行的插件由原平台入口拒绝。没有通用服务分发或浏览器遥测写入口。插件 dispose 撤销作用域以及保留的服务句柄；遥测写入绑定安装身份。

```ts
import { definePlugin } from "@smartdoca/plugin-sdk";
import { monitoringServiceToken, telemetryServiceToken } from "@smartdoca/plugin-sdk/monitoring";
import { httpServiceToken } from "@smartdoca/plugin-sdk/platform";
import manifest from "../manifest.json" with { type: "json" };

export default () => definePlugin({
  manifest, // sdkRange: "^0.1.11"；package.json 同时声明 doca.storage: "host"
  injections: { required: [monitoringServiceToken, telemetryServiceToken, httpServiceToken] },
  async uninstall() {},
  async mount(context) {
    const monitoring = context.inject(monitoringServiceToken);
    const telemetry = context.inject(telemetryServiceToken);
    telemetry.log(manifest.id, { level: "info", module: manifest.id, message: "Collector started" });
    await context.inject(httpServiceToken).register(manifest.id, [{
      method: "GET", path: "/metrics", admin: true,
      handle: request => monitoring.metrics({ scope: "cluster", windowSeconds: 60 }, { signal: request.signal }),
    }]);
  },
});
```

Web 插件可调用 `await host.platform.monitoring.stats({})`、`await host.platform.monitoring.logs({cursor})`，返回类型化 DTO、采集覆盖和缺口信息。调用选项接受 AbortSignal，在 I/O 前后检查取消，不承诺终止已经提交的数据库语句。

## 读取接口

| 方法 | 数据与限制 |
| --- | --- |
| `stats({})` | 共享数据库中的未删除文档、知识库和文件数量，全部/活跃账号数量，逻辑文件字节、登记文件对象数量与字节。同一对象的多份引用可能重复计入逻辑文件字节。对象字节是 `file_storage_objects` 清单，不是磁盘或桶容量，不含插件私有对象、发行包归档和未登记对象。 |
| `online({offset?,limit?})` | 实时查询连接，按 userId 去重人数、连接数、活跃文档数，以及用户/文档 ID 分页。默认 100、最多 200。local 模式是单实例，Redis 模式是集群。新接口不用旧心跳备用路径；实时来源不可用就失败。 |
| `metrics({scope?,windowSeconds?})` | HTTP 完成请求数、4xx、5xx、中断、进行中、QPS、5xx 错误率和耗时直方图，路由模板分组及插件指标。窗口默认 60 秒、支持 1–300 秒。scope 默认 cluster，未配置 Redis 时返回的真实 scope 为 instance。 |
| `logs({scope?,cursor?,limit?,level?,pluginId?,module?,requestId?,since?})` | 有界结构化日志，保留每个 epoch 的顺序，以各实例队首时间合并；时钟回拨也不会越过未处理的序号。默认 100、最多 200。筛选是精确匹配，level 不是最低级别。游标最多 64 KiB；空页也应保存返回游标。 |
| `audit({source,...})` | 宿主已有的持久安全/资源审计。source 必填 security 或 resource，可按 action、actorId 及对应来源的 userId/resourceId、ISO since/until、cursor、limit 查询；不适用的筛选明确失败。安全详情脱敏，无法解析或不是对象时返回 details=null、detailsValid=false，不改写原记录。 |
| `jobs({})` | 共享数据库的 AI、projection、file-extract 状态分组，过期 AI/projection 租约与待删除私有对象数。projection 包括已有队列中的不同 kind，不声称所有业务插件都使用宿主队列。 |
| `jobErrors({source,limit?})` | 最近的 AI/projection/file-extract 错误样本，不含提示词、任务 payload 或结果。这是有上限的诊断样本，不是完整错误历史分页；nextCursor 恒为 null。projection 没有可靠的错误更新时间，因此 updatedAt=null，按 available_at 排序。 |
| `aiUsage({...})` | 共享 AI 原始账本快照分页，按 userId/modelId/state、ISO since/until 筛选，返回调用/任务/模型 ID、状态、折算 Token 与供应商原始数值指标。未知用量返回 null，不从旧 SQL 数字列推测。已确认但不符合当前表示的记录标记 usageStatus=invalid，原记录保留。省略凭据、供应商原始响应和模型配置快照。 |
| `health({scope?})` | 宿主版本、实例、进程 RSS/堆内存/累计 CPU/事件循环 P95，数据库读取探测，以及实时集群和监控缓存就绪状态。存储、搜索、AI 网络探测明确标记 not-probed，不调用收费模型或写入探测对象。 |

审计与 AI 用量分页默认 100、最多 200。游标固定上界时间，绑定筛选条件，按 created_at、ID 排序；错误或跨查询游标拒绝。它们是快照读取，不是增量变更流：之前 pending 的 AI 调用可能在创建时间分页之后才结算。持久消费结算仍用原有 `events.v1` / `ai.usage.recorded`。原审计与用量接口保留原来的行为。

## 请求与插件指标

HTTP 指标包括管理、平台和健康请求等正常 HTTP 路由，不包括 WebSocket 握手与消息；连接使用在线来源。中断单独统计。错误率为 5xx/完成请求，空窗口为 null。QPS 为各实例实际覆盖窗口请求速率之和，窗口裁剪到启动时间。采样时间与启动时间随结果返回，可判断采样延迟。

耗时使用互斥的毫秒桶：1、5、10、25、50、100、250、500、1000、2500、5000、10000 和无上限。P50/P95/P99 取桶上界估计，并裁剪到观测最大值；集群合并桶计数，不平均实例分位数。空分布的最小值、最大值和分位数为 null。路由标签来自注册模板，不使用动态资源 URL 或查询字符串；每个进程 epoch 保留前 64 个路由/方法分组，超出的汇总至 `[other-routes]`。

```ts
telemetry.record(manifest.id, {
  name: manifest.id + ".sync.completed", kind: "counter", value: 1,
  labels: { source: "mail" },
});
telemetry.record(manifest.id, {
  name: manifest.id + ".sync.duration_ms", kind: "histogram", value: 120,
});
```

指标名称必须以插件 ID 加点开头。counter 为非负增量，gauge 为最近的有限数值，histogram 为非负观察值并使用同一组数值桶。同名指标更改 kind 或标签键返回 409。最多 6 个标签、每值 100 字符，每插件 200 条、每实例 1000 条自定义序列；超额新序列返回 429，并增加 rejectedMetricSeries。凭据标签和数值溢出拒绝。标签应使用有界分类，不使用用户、文档和 requestId。自定义指标按实例/epoch 返回，计数器重置与 gauge 汇总由消费者明确处理；数值是启动以来的累计值或最近值，不随 HTTP 窗口裁剪。插件可用这些指标报告自己的任务与依赖状态。

## 日志保留与集群覆盖

宿主日志包括启用宿主 logging 时的结构化 Fastify 应用日志，以及不受 stdout 开关影响的 HTTP 错误、中断和耗时至少两秒的请求；普通成功请求行用指标表示。插件日志带宿主绑定的 pluginId、epoch、实例、序号、创建时间和可选 requestId。敏感键、请求正文、提示词、payload、模型配置和错误栈删除或脱敏；URL 账号/密码、查询、hash 及常见凭据串过滤。模式匹配无法识别任意裸文本秘密，作者不得把凭据或文档正文放入 message、module、requestId、fields。

每实例最多保留 2000 条、序列化日志最多 2 MiB。数量/字节淘汰会提高最早序号和 dropped；游标落后时返回明确的 evicted 缺口与丢失数量。进程重启生成新的 epoch，即使 instanceId 相同。之前的 epoch 不可读取时返回 instance-unavailable 缺口；不符合新缓存协议的记录标记不可用，保留至过期，不适配、不返回其内容。

配置 Redis 时，在独立的 `monitoring:v1` 命名空间每五秒发布 version 1 快照。已关闭实例或超过 15 秒的快照标记 stale，排除出当前指标总量，保留日志仍可补拉。快照及已知实例记录一小时过期；过期、缺失、格式错误使 complete=false。集群读取刷新应答实例，再读取其他实例的快照。最多 128 个保留 epoch、每份快照 16 MiB，超过明确失败。Redis 失败不把集群查询降级成单实例；显式 instance 查询仍可诊断本实例。这是临时缓存，不保证持久投递或发现混合版本集群：旧宿主没有新发布器，不会出现在监控清单。

监控插件通过宿主管理的存储保存历史聚合、日志、游标、缺口和告警状态。按日志 id 去重，把记录与游标放入同一插件事务提交，缺口按缺口处理。采样不会重建已丢失的请求窗口。安全审计和原始 AI 用量由宿主保管，插件不能通过本 SDK 删除。

## 升级、回滚与验证

不修改宿主数据库表、基线、审计格式、AI 账本格式或现有插件数据结构；旧在线心跳和 AI 历史读取回退留在原路径。新的运行事实从升级后的进程启动开始，不导入历史 stdout。新插件必须使用 SDK 0.1.11，旧宿主明确拒绝。恢复旧程序保留原持久数据和插件历史记录；启动旧宿主前停用依赖新服务的插件。临时监控缓存可过期，不影响原始数据。

使用隔离数据库/文档和独立 Redis 命名空间，验证请求与直方图合并、在线去重、筛选分页和游标淘汰、脱敏、普通用户/撤销管理员权限拒绝、命名空间/版本/生命周期，以及失效/缺失/错误缓存和重启 epoch。另验证 SDK 构建与独立 JavaScript/声明消费。npm 发布、实际生产监控插件和生产部署属于另外的交付。

## SDK 发布 — 2026-10-13

`@smartdoca/plugin-sdk@0.1.11` 已发布至 npm。公共注册表依赖消费者检查全部 16 个入口、监控与遥测 token 以及准确 SDK 版本；这不代表生产监控插件或移动设备验收完成。
