# 插件托管存储实施状态

2026-10-03：用户确认不兼容旧版，具体实现和部署约束见 [统一存储实现](unified-storage-implementation.md)。早期升级工具、八表租约系统和临时工作区的拟议方案不属于本次已实现能力。

SDK 源码 0.1.8 已提供 `@smartdoca/plugin-sdk/storage`：

- `pluginDatabaseToken` / `storage.sql.v1`：安装身份绑定的关系库，完整 schema 声明与精确核对、结构化查询/写入、一次执行的事务回调。
- `pluginObjectStorageToken` / `storage.objects.v1`：特殊私有对象，宿主生成 ID/路径，完整上传后发布引用，读回校验、持久化回收意图。
- `pluginCredentialToken` / `storage.credentials.v1`：服务端加密凭证创建/读取/元数据/按修订号更新和删除，绑定插件身份与安装代次。
- 常规数据使用既有 `files.v1` 文件夹系统；内容、模板、素材使用既有通用 SDK。

外部包必须声明 `doca.storage:"host"`，最低 SDK 范围至少为 0.1.7，并覆盖当前宿主 SDK。拒绝旧声明/清单/宿主数据库，不自动建立空业务库来承接自管旧数据。全部实例仍由运维逐个重启。

新增 namespace/private-object/garbage 表和改造后的归档、存储元数据表只在新空宿主数据库建立。原自动补建插件管理表入口已经退出。停用保留存储；卸载在事务中使旧代次失效并清理私有业务表、凭证及对象引用，用户文件、权限、回执和发行包保留。

SDK 源码 0.1.8 已开放凭证服务，宿主源码 0.1.10 需配置 DOCA_CREDENTIAL_MASTER_KEY，并使用新 credentials-v2 基线。临时工作区、业务任务调度和强制进程隔离尚未交付，见[凭证接口](plugin-credentials.md)。npm 发布、生产部署和原生设备验收未执行。
