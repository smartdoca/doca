# 参与 Doca

[English](CONTRIBUTING.md)

感谢关注 Doca。项目采用 [MIT 许可证](LICENSE)。

## 当前贡献状态

欢迎提交 Issue、可复现的缺陷报告、设计讨论、文档反馈和 Pull Request。贡献按
MIT 许可证许可。

请勿提交从其他项目复制、且你无权按 MIT 许可证再许可的代码。

## 开发检查

使用 Node.js 22.12 或更高版本，以及 `package.json` 中声明的 pnpm 版本。启动应用前先按[开发环境](docs/development.zh-CN.md)完成配置。

```sh
pnpm install --frozen-lockfile
pnpm check
```

测试必须使用隔离的数据库、文档、插件目录和账号，禁止对用户数据运行协同或迁移测试。

## 变更要求

- 公共 API 必须有文档和测试。
- 公共 SDK 或能力包不得导入宿主私有源码路径。
- 用户可见文案进入 i18n 字典；公共标识符和代码注释使用英文。
- 保留第三方版权、许可证与署名声明。
- 禁止提交凭据、用户数据、本地数据库或生成的验收输出。
- 优先更新英文文档，并保持中文译文有链接且内容同步。
- 遵守 [AGENTS.md](AGENTS.md)，兼容性变化须事先确认，数据库改动须遵守[升级规范](docs/database-schema-evolution.zh-CN.md)。生成的验收产物写入 `artifacts/`，审阅后的摘要提交到 `docs/verification/`。
- 文档改动运行 `pnpm docs:check` 和 `pnpm docs:build`。

安全漏洞请通过 README 中的作者邮箱 [smartdoca@163.com](mailto:smartdoca@163.com) 私下报告，不在公开 Issue 中披露利用细节或凭据。
