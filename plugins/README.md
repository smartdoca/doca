# 业务插件安装

业务插件安装到独立的 `DOCA_PLUGINS_DIR`，默认是 `data/plugins`，不从本源码目录加载。

在安装目录维护 package.json 与锁文件，将已构建插件安装为直接依赖，重启 Doca 即可加载。

包格式、公开服务和验证要求见 [插件开发规范](../docs/plugin-development.md) 与 [部署说明](../docs/plugin-deployment.md)。
