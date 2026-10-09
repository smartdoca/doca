# 文档、分享与历史

[English](document-experience.md)

按宿主 0.1.10 当前源码核对；早期开发与临时包记录归入[研发资料](research.zh-CN.md)。

## 创建与编辑

创建菜单提供富文本、Markdown、表格、幻灯片和画布，五种格式均已接入编辑器和独立协同编码。模板需要已安装的提供者，默认仍可创建空白文档。个人文档为独立页面；知识库文档按库目录导航。

图片与附件走宿主上传、资产 ID 和授权下载。编辑需要 editor 或更高权限，保存以数据库提交后的回执为准。断网时保留当前页面的未确认更新，关闭页面不构成离线备份。工具、查找替换、在线选区与评论因格式而异，见[编辑器集成](editor-integration.zh-CN.md)。

## 分享与权限

分享面板管理阅读范围、邀请、成员授权来源和链接。变更检查版本或修订号；409 冲突需要刷新后重新操作。管理权限及所有权操作受各自授权规则约束，见[权限](permission-inheritance.zh-CN.md)。

链接使用 `#/s/{token}`，登录后预览和接受。链接总开关、具体链接停用/过期、成员来源撤销是不同操作；撤销某一来源不影响其他有效来源。公开阅读、发现、收录和收藏分别处理；收录不授予访问权，系统管理员也不会自动取得私有正文权限。

## 历史与恢复

- 文档菜单提供历史列表、快照预览和手动快照。历史读取默认需要编辑权限；开启阅读者历史权限后，可按资源阅读权查看。
- 富文本和 Markdown 的可恢复快照提供恢复操作，需要 manager 或 owner。提交 `expectedSeq` 校验当前正文；冲突后重新读取，避免旧预览覆盖新编辑。
- 表格、幻灯片、画布已有快照及只读预览，当前返回 `canRestore: false`，没有恢复按钮。
- 业务历史与协同 checkpoint 分别持久化。恢复依赖快照自身的格式、谱系及资产，不用当前正文冒充缺失历史。
- 访问与操作记录按当前权限读取，不是正文备份，也不能补出过去未保存的快照。

## 移动、复制与回收站

移动前检查目标和子文档权限，并确认授权重置的影响。所有权转移仅由所有者执行。复制创建独立资源及正文身份、重新绑定资产，不复制授权、评论或撤销历史。删除进入回收站；恢复遵循删除批次和父级状态。永久删除走明确的清理操作及权限检查，不等于删除所有共享存储对象。

## 接口与源码

路径以 `/api/v1` 为前缀：

| 接口 | 用途 |
| --- | --- |
| `GET /resources/:id/versions` | 历史列表 |
| `POST /resources/:id/versions` | 手动快照 |
| `GET /resources/:id/versions/:versionId` | 预览及当前正文序号 |
| `POST /resources/:id/versions/:versionId/restore` | `{expectedSeq}`，恢复支持的格式 |
| `POST /share/redeem` | `{token, accept?, consume?}`，预览/接受链接 |
| `GET /resources/:id/info` | 统计、访问或操作记录 |

实现见 [experience.ts](../apps/server/src/routes/experience.ts)、[历史服务](../packages/core/src/modules/history/service.ts)和[编辑器分派](../apps/web/src/features/documents/document-editor.tsx)。完整部署接口以 `/api/openapi.json` 和服务端校验为准。
