# 插件架构

[SDK 契约](plugin-sdk-contract.md) 定义核心与业务边界，[开发规范](plugin-development.md) 列出当前可用接口。

plugin-contracts 定义 manifest 与生命周期；plugin-sdk 提供注入、事件、贡献和 effect；plugin-host 校验依赖并管理启动和逆序关闭。composition 组装核心文件、文档、搜索和 AI，再从独立安装目录引入业务插件。

业务插件通过公开 files、users、permissions、http、data、policies、events 和 ai 服务对接宿主。注册归属插件实例，不通过宿主私有数据库类型或进程全局桥接获取服务。Web 插件提供独立构建产物，由活动清单动态加载。

宿主保留身份认证、授权、文件、文档协同、安全审计、AI 原始用量及按模型速率折算的统一 Token 用量。会员、积分、货币价格、内容审核和邮件不再包含核心表、专用工具或页面入口；未来邮箱插件独立管理业务后端、资料和验收。

通用目录树插槽、更多业务能力服务化和资金预留补偿协议仍以契约的实现状态表为准，不能把提案 API 当作可用导出。
