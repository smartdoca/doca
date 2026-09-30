# 业务插件安装

业务插件通过管理员插件商店安装，或停机后放入独立的 `DOCA_PLUGINS_DIR/<plugin-id>/`；默认根目录是 `data/plugins`。不从本源码目录加载，不使用根目录 npm 依赖清单。

插件包包含完整预构建代码和依赖。共享数据库保存清单与归档，每个实例启动时自动校验并补齐自己的缓存，重启生效。

包格式及远端交互见 [商店协议](../docs/plugin-store-protocol.md)，运行方式见 [部署说明](../docs/plugin-deployment.zh-CN.md)。
