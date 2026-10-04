# 插件托管凭证

[English](plugin-credentials.md)

发行版本：宿主 0.1.10、SDK 0.1.9（包含此前源码 0.1.8 的凭证接口）。SDK 0.1.7 没有此接口。邮箱插件应声明 SDK 范围 `^0.1.9`，通过服务端公开 token 使用凭证，不导入宿主源码或自行持久化密码。

```ts
import { pluginCredentialToken } from '@smartdoca/plugin-sdk/storage';

// 插件 injections.required 声明 pluginCredentialToken。
const credentials = ctx.inject(pluginCredentialToken);
const created = await credentials.create({value: JSON.stringify({password: 'example'})});
// 将 created.id 存到插件关系库中，与业务账户及其授权关系关联。
const metadata = await credentials.inspect(created.id); // 无明文
const stored = await credentials.get(created.id); // 服务端明文或 null
if (stored) {
  const refreshed = await credentials.update({
    id: stored.credential.id,
    expectedRevision: stored.credential.revision,
    value: JSON.stringify({accessToken: 'new', refreshToken: 'new-refresh'}),
  });
  await credentials.remove({id: refreshed.id, expectedRevision: refreshed.revision});
}
```

元数据为 `{id, revision, createdAt, updatedAt}`。ID 由宿主生成，不接受插件指定 ID、插件作用域、库名或后端配置。`get` 为 `{credential: 元数据, value: string} | null`，`inspect` 为元数据或 null。值必须是有效 Unicode 的非空字符串，UTF-8 最大 64 KiB；OAuth 对象由插件显式序列化，不进行隐式格式转换。

更新和删除必须携带正整数 `expectedRevision`。并发更新只有一个成功；过期修订号返回 `conflict`，插件重新读取后按业务规则处理，不能盲目覆盖新 refresh token。删除不存在记录幂等成功。非法输入返回 `invalid-input`；安装失效、损坏记录、服务或数据库故障返回 `unavailable`。错误不含输入、SQL、连接配置或底层加密异常。更新不存在记录返回 `unavailable`。

宿主按 `plugin:<pluginId>`、安装代次、UUID 和修订号绑定 AES-256-GCM 认证加密。数据库只保存加密记录，每次写入采用新随机 nonce。其他插件无法读取、更新或删除此插件记录。停用和关闭保留数据；显式卸载在清单事务中清理对应代次的凭证，旧句柄失效；重装使用新代次。插件应先执行需要明文的外部撤销，再完成 uninstall。SDK 不提供业务账户权限判断；插件必须在读取前验证用户与账户的权限，不能把明文返回浏览器、AI 上下文、日志或普通配置接口。

凭证操作与插件业务库事务分别提交。创建凭证后写业务引用失败，需要补偿删除；外部 OAuth 刷新、数据库提交或响应丢失由插件按业务规则恢复。没有跨服务事务、凭证创建幂等键、通用任务协调或自动密钥轮换承诺。示例在 [plugin-storage](../examples/plugin-storage/README.md)。插件仍在受信任 Node.js 进程中运行，作用域 API 不构成操作系统沙箱。

## 部署环境

`DOCA_CREDENTIAL_MASTER_KEY` 必须为随机 32 字节编码成 64 个十六进制字符，可用 `openssl rand -hex 32` 生成。首次部署设置一次，重启保留，并单独备份。配置错误拒绝启动；数据库持久记录密钥指纹，不匹配的密钥拒绝启动且不重新加密数据。删除最后一个插件也不删除密钥身份记录。缺少密钥时宿主不提供此服务；声明必需凭证服务的插件启动失败，可选注入返回 undefined。所有使用同一数据库的部署进程应使用相同密钥。

数据库、文件存储的选择由部署方负责：本地文件与 SQLite 用于单实例；需要共享部署时设置数据库及云存储。插件 API 不判断部署方式。Compose 转发 `DOCA_DATABASE`、`DOCA_DATABASE_URL`、连接池、Webhook 数据库、Redis 与实例配置；详见 [docker.env.example](../docker.env.example)。

文件存储只通过 `DOCA_FILE_STORE_ID` 和严格 version 1 的 `DOCA_FILE_STORES_JSON` 配置，包括 S3/CDN 密钥。管理员页面只读展示存储状态，不能创建或修改后端/凭据；旧 storage 配置提交拒绝。S3/CDN 配置示例见 [统一存储实现](unified-storage-implementation.md)。宿主插件凭证主密钥与云存储连接凭据相互独立；本次不转换或重新加密身份/消息/搜索等既有平台配置。

本次使用数据库基线 `doca-2026-10-03-credentials-v2`。按已确认的不兼容规则，0.1.9 和更早的宿主库拒绝启动；原库、对象和部署保留，不自动补表、迁移、导入或清空。新版本使用新空数据库。回退使用原部署和原数据，新部署数据单独保留。SDK 0.1.7 的凭证缺口不能用自管本地文件绕过。
