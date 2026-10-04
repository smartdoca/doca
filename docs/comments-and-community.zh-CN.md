# 评论、用户可见范围与通知

[English](comments-and-community.md)

## 数据

当前基线同时支持 SQLite / PostgreSQL：

- `users.public_id`：独立于内部 UUID 的唯一用户标识，创建时归一化为小写，3–160 位，允许英文字母、数字和 `._@+-`。数据库唯一索引约束。注册和管理员创建可指定 `publicId`，省略则使用 login。创建后不随昵称变化。
- SSO 使用已验证身份中的 preferred_username（OIDC）、login（GitHub），否则使用 subject。若无效或本站已占用，则生成身份源命名空间下的标识。绝不因同名、同邮箱、同 public_id 合并账号；认证关联仍由 provider + subject 唯一确定。绑定新登录方式不修改原用户标识。
- `users.directory_mode`：可空，空表示跟随站点 `settings.directory_mode`。
- `comments.body_json`：当前富评论 JSON；`body` 是用于检索、摘要和通知的派生纯文本。未删除评论必须具有合法的 `body_json`。
- `notifications` 增加 actor_id、comment_id、dedupe_key。事件与业务修改在同一事务落库；dedupe_key 唯一索引抵御重复事件。

富评论结构：

```json
{
  "version": 1,
  "blocks": [
    {
      "type": "paragraph",
      "children": [
        { "type": "text", "text": "请确认 " },
        {
          "type": "mention",
          "userId": "内部UUID",
          "label": "昵称",
          "publicId": "alice"
        }
      ]
    },
    { "type": "image", "assetId": "附件UUID", "alt": "图片名称" }
  ]
}
```

后端从用户表填充提及名称和标识，不信任客户端 label。单条评论最多 5,000 字、9 张图片、50 个块；图片必须属于当前资源，且是有效的 comment_image 或 image attachment。上传后仍走原有私有存储、图片清洗和鉴权下载流程。评论者可以上传评论图片，但不能因此上传/修改正文附件。

## 用户可见范围

管理员 → 用户可见范围，支持站点默认和单用户覆盖：

| 模式    | 新用户候选                                                                       |
| ------- | -------------------------------------------------------------------------------- |
| all     | 本站正常用户                                                                     |
| related | 双方当前共同拥有显式权限的文档或知识库，包括权限继承、知识库拥有者和有效链接成员 |
| none    | 无候选，不允许绕过界面直接填写用户 UUID 添加新权限或新提及                       |

公开可见、登录可见不构成关联。权限撤销后关联消失。已有权限仍可修改/撤销，已有评论和正文提及不会因策略收紧而消失。管理员的用户管理列表不受该搜索策略限制。

接口（均以 `/api/v1` 为前缀）：

- `GET /users/lookup?q=`：按当前操作者范围查询正常用户，返回 id、public_id、display_name、头像信息。账号/标识前缀匹配，昵称模糊匹配；最多 20 项，搜索通配符按普通文字处理。
- `GET /admin/directory-policy` → `{mode, revision}`。
- `PUT /admin/directory-policy`：`{mode, revision}`，版本冲突返回 409。
- `PUT /admin/users/:id/directory`：`{mode: "all" | "related" | "none" | null}`，null 恢复跟随站点。
- `GET /me`、`GET /users/:id/profile`、管理员用户列表包含 public_id。

## 内容评论交互

- 编辑模式在原编辑器浮动选区工具栏末尾追加评论图标；只读模式独立显示评论图标，无格式修改工具。需要 commenter 或更高权限才能提交。
- 原生浏览器选区映射为 Slate 范围，再使用编辑器提供的 Yjs 相对位置锚点。当前包的锚点是**单段落/块内**，跨块选择会提示重新选择，不把不支持的范围静默截断。
- 未解决且原文仍存在的根线程各自呈现为独立卡片。默认黄色下划线，点击原文/卡片双向联动黄色背景和卡片边框。滚动、缩放和协同更新时重新测量位置。
- 原文被删空、锚点失效、根评论删除或解决后，卡片和高亮隐藏；数据库保留评论，以便历史/审计和未来恢复功能使用。撤销文本删除而恢复有效锚点时可重新显示未解决评论。
- 全文评论和内容评论共用富评论输入器：@ 搜索、图片上传、编辑、回复、删除、解决等图标操作。编辑版本检查保留，提交失败不清除输入。

接口：

- `POST /resources/:id/comments`：`{richBody, parentId, anchor?}`。回复继承根评论所属线程。
- `PATCH /resources/:id/comments/:commentId`：`{version, richBody?, deleted?, resolved?}`。
- `POST /assets?purpose=comment_image&resourceId=...&filename=...`：二进制上传，最多 5MB；后端执行图片验证和访问校验。

正文 @ 使用编辑器 mentions 扩展，候选同样来自范围受限的 lookup。用户提及节点保留用户 UUID，而非仅存显示名字。


五种格式各有永久评论锚点；上面的 Slate 选区说明仅适用于富文本。表格通过原生评论 API 捕获稳定行列 ID，结构变化后解析当前范围，服务端检查目标是否仍存在，见[实时协同](collaboration.zh-CN.md)。

## 通知

支持 comment.created、comment.mentioned、document.mentioned、resource.permissions_changed（新增邀请）、like.added、favorite.added 以及已有所有权转移事件。

- 不通知操作者自己；同条评论中被提及的拥有者/被回复人只收到提及通知，不再叠加普通评论通知。
- 提及不授予访问权限。接收者必须是正常用户，并且在提交时具有当前文档读取权限，否则跳过通知。
- 正文新增提及按稳定的 mention 节点标识判断。同一用户在另一新节点再次被 @ 会有新通知；旧更新重放、普通文字修改不重复通知。
- 查看通知列表时再次校验当前文档权限；撤销权限、文档删除后，相关通知不再展示，也不计入未读数。
- WebSocket 推送 `notifications.changed` 失效通知，前端重新获取自己的列表；不会广播通知正文。离线用户的事件已在数据库中，重新连接后补拉。
- `GET /notifications?offset=0` → `{items, unread, nextOffset}`，每页 50 项；包含操作者和文档标题。
- `POST /notifications/read`：`{ids:[]}`，最多 100 项，仅更新操作者自己的通知。
- `POST /notifications/read-all`：`{}`，将操作者自己的通知全部标为已读。

当前通知是站内通知，不发送邮件/短信/第三方推送。当前部署仍按单实例 WebSocket 模式运行，未引入多实例消息总线。

## 验证

测试覆盖用户标识冲突、SSO 标识、可见范围/单用户覆盖、公开文档非关联、权限绕过、结构化评论、图片资源隔离与评论者上传、通知去重、无权限跳过、撤销访问后的通知隐藏、只更新自己已读状态、协同更新重放和重复 @。

浏览器使用内存文档和模拟用户做隔离验收，不向真实文档写入测试评论。确认工具栏末尾按钮、只读按钮、富评论提及、双向黄色高亮、解决隐藏和原文删空隐藏。
