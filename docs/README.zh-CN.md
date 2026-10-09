# Doca 文档

[English](README.md)

Doca 是面向个人和小团队的文档与知识工作台。本套文档覆盖 0.1.15 发行版，并注明相关组件契约与实现限制。

[Demo 体验](https://d.smartdoca.cc) · [插件商城](https://store.smartdoca.cc)

**Demo 数据会不定期清理，请不要存放重要数据。**

## 开始使用

- [快速开始](quickstart.zh-CN.md)：拉取代码 → 配置 `.env` → 拉取镜像 → 启动 → 初始化管理员密码。
- [功能与边界](features.zh-CN.md)：核心、独立插件及尚未提供的能力。
- [配置说明](configuration.zh-CN.md)：必填配置和可选服务。
- [使用指南](user-guide.zh-CN.md)：文档、知识库、文件、搜索与 AI。
- [常见问题与排障](faq.zh-CN.md)。

## 使用指南

[文档与分享](document-experience.zh-CN.md) · [权限](permission-inheritance.zh-CN.md) · [发现与收录](public-resource-discovery.zh-CN.md) · [评论与通知](comments-and-community.zh-CN.md) · [知识册](knowledge-books.zh-CN.md)

## 部署运维

[部署说明](deployment.zh-CN.md) · [文件存储](storage.zh-CN.md) · [水平扩展](horizontal-scaling.zh-CN.md) · [身份认证](authentication.zh-CN.md) · [服务凭据](service-credentials.zh-CN.md) · [Webhook](webhooks.zh-CN.md)

## 开发与扩展

[开发环境](development.zh-CN.md) · [项目架构](architecture.zh-CN.md) · [编辑器集成](editor-integration.zh-CN.md) · [实时协同](collaboration.zh-CN.md) · [国际化](i18n.zh-CN.md) · [插件开发](plugin-development.zh-CN.md) · [插件部署](plugin-deployment.zh-CN.md)

## 技术参考与项目记录

[HTTP API](api.zh-CN.md) · [数据库](database.zh-CN.md) · [插件 SDK 契约](plugin-sdk-contract.zh-CN.md) · [插件存储契约](plugin-horizontal-scaling.zh-CN.md) · [协同契约](collaboration-sdk-contract.zh-CN.md) · [文件交换](editor-file-exchange-contract.zh-CN.md) · [0.1.15 发行说明](releases/0.1.15.zh-CN.md) · [文档维护](documentation.zh-CN.md) · [研发与验收资料](research.zh-CN.md)

运行中的应用提供 `/api/openapi.json`。相关契约会标明拟议能力；设计记录不代表接口已经导出。研发资料保留原始语言和日期。
