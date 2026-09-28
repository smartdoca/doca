# 界面国际化审计（2026-09-25）

## 结论

当前是「基础翻译设施已具备，但业务界面迁移不完整」。英文导航并不代表页面已完成国际化：设置页、弹窗、嵌套表单、工具函数和服务端返回值分别存在遗漏。不能以字典 key 对齐或某个页面调用了 `useI18n` 作为覆盖完成的证据。

已进行两轮修复，范围扩展到截图之外的文件、权限、账号和 AI 界面，并扫描网页、移动端和邮件扩展；全系统仍有明确遗漏。

## 第一轮修复

- 首页列表的相对时间、今天/昨天和绝对日期按当前界面语言格式化；作者本人标签使用 `time.me`。文档标题、作者真实姓名和知识库名称保持原值。
- 默认分发策略：文档/知识库可见范围、授权方式、列表规则、审批人信息、公共发现和待处理分享。
- 文件识别：说明、策略、模型选项、OCR、文件类型、来源目录、状态和保存反馈。
- 搜索管理：连接、索引、对账、重试信息、向量配置、模型任务状态、删除确认和相关度设置。
- 共用服务凭据：搜索、SSO、存储、验证码网关和 CDN 表单，包括隐藏密钥的占位符和高级设置。
- 搜索结果、文档编辑时间与历史记录日期显式使用当前语言，避免跟随浏览器默认区域。
- 两处已有类型检查问题：知识库页面补上 `Feedback` 导入，运行记录计数返回已验证的数值对象，确保能作为翻译参数传入。

第一轮新增 252 个稳定英文消息 key；中英文 key 和占位符一致。没有翻译用户内容，也没有修改编辑器文档、协同实例或数据库数据。

## 第二轮扩展修复

此次覆盖超出截图页面：AI 对话、登录注册策略、账号设置、用户字段、安全验证、用户管理、文件管理、文件夹权限、文档权限、访问管理和分享弹窗，均迁移了页面内文案及动态插值。另补齐多个上传、预览、个人资料、目录和 AI 辅助组件的共用文案；这些辅助模块仍有剩余项，不能视为整页完成。

- 文件、分享链接和访问记录日期跟随 locale。
- 文件夹系统名称按类型和稳定 ID 翻译；自定义目录名称保留原值。
- 管理员用户接口只返回结构化 `loginMethodDetails`，界面据此翻译登录方式；自定义身份提供方名称保留原值。
- AI 欢迎提示、示例操作、会话状态、批量管理、附件和审批控件接入字典。已有对话标题和生成内容保留。
- 表单字段复用 useFieldLabels；邮箱字段使用 Email，避免误用代表邮箱功能入口的 Mailbox。

## 剩余问题：已人工确认的例子

| 范围                 | 证据文件                                                                                | 例子 / 根因                                                |
| -------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| AI 管理              | `apps/web/src/features/ai/ai-admin.tsx`                                                 | 模型、工具、文档格式选项和配置说明仍大量写死。             |
| AI 个人配置          | `apps/web/src/features/ai/ai-user-settings.tsx`                                         | AI 设置、用量、个人偏好及嵌套配置。                        |
| 导入导出             | `apps/web/src/features/documents/file-transfer.tsx`                                     | 在线演示文稿、格式能力限制、导入提示。                     |
| 存储管理             | `apps/web/src/features/admin/storage-settings.tsx`                                      | 存储用途说明、加载失败与加载状态。                         |
| 上传组件             | `apps/web/src/features/documents/uploads.tsx`                                           | 封面预览、上传说明与辅助标签。                             |
| 注册审核             | `apps/web/src/features/admin/registration-reviews.tsx`                                  | 状态选项及操作反馈。                                       |
| 个人资料与用户卡     | `apps/web/src/features/account/profile.tsx`、`features/settings/user-card-settings.tsx` | 头像替代文本、自动保存反馈、跳转说明。                     |
| 文档及知识库辅助界面 | `features/documents/document-editor.tsx`、`tree.tsx`、`template-picker.tsx`             | 操作说明、空状态、模板和树形操作仍需逐项核对。             |
| 移动端               | `apps/mobile/src/document-panel.tsx`、`folder-browser.tsx`、`ai-trace.tsx`              | 文档面板、文件浏览器、AI 执行过程等仍硬编码。              |
| 邮件扩展             | `../doca-mail/src/web`                                                                  | 单独扫描，不能用主仓库字典测试代替插件验收。未修改此仓库。 |

## 字典迁移之外的根因

1. **后端中文直接穿透到界面。** `shared/api.ts` 将 `data.message` 直接作为 Error 文本；`packages/core/src/modules/ai/embeddings.ts` 返回「模型已停用」「模型厂商尚未配置密钥」等字符串。搜索向量配置直接展示 `model.issue`、`task.notice` 和 `config.notice`，所以本轮界面字典补齐后，服务端诊断仍可能是中文。应逐步提供稳定消息代码和参数，按显示语言翻译；外部服务原始诊断作为原文保留。不要全局字符串替换未知响应。
2. **格式化绕开 locale。** 存在固定 `zh-CN`、无参数 `toLocaleString()`、数字格式以及按浏览器区域显示的代码。时间戳/ID排序和 API 日键是协议逻辑，不能机械改成语言相关排序或日期。
3. **仅迁移顶层页面。** 页面接入 `useI18n`，但子组件、下拉选项、默认参数、弹窗和模块级数组仍保存中文。选项应保存 key，在渲染时翻译。
4. **翻译字符串被存入状态。** 一些通知、错误回退、对话标题保存的是已翻译文本，显示期间再次切换语言仍可能保留旧语言。应在后续迁移中将自有通知状态保存为消息代码和参数，避免重建业务状态来刷新文案。
5. **编辑器和插件是独立边界。** 富文本、表格、Markdown、画布、幻灯片挂载处均能找到 locale 传入；这只证明宿主传值，不证明各子包的工具栏、错误、只读预览已覆盖。需要按已安装版本的实际 API 和独立字典验证，不改文档内容，不因语言变化重建协同实例。
6. **现有测试主要检查字典结构。** 中英文 key 集合一致，不能发现业务代码根本没使用字典。需要逐模块增加源码覆盖门禁和渲染验证。

## 可重复检查

```sh
pnpm exec tsx scripts/audit-i18n.ts
pnpm exec tsx scripts/audit-i18n.ts --json
pnpm exec tsx scripts/audit-i18n.ts apps/web/src/features/files --json
pnpm exec tsx scripts/audit-i18n.ts ../doca-mail/src/web --json
```

扫描器通过 TypeScript 语法树区分 JSX 文本、属性、字符串、模板和固定/隐式区域格式化，忽略注释。默认覆盖网页和移动端，不扫描外部编辑器包；额外目录可以显式传入。

输出是**人工审计候选**，不是确认缺陷数。中文提示词、文档默认内容、文件名规则、协议数据等可能被列出；反过来，硬编码英文、服务端动态消息、第三方组件内部文案不会被中文扫描完整发现。不得以机械替换或“扫描为零”作为唯一验收。

`tests/i18n-coverage.test.ts` 对本轮迁移页面增加未翻译中文门禁，校验所有目录的占位符，验证中英默认权限页渲染和日期格式。`tests/document-author.test.ts` 验证本人标签翻译与用户姓名保持不变。

## 后续验收顺序

1. AI 管理与个人配置、导入导出、存储和上传：补全选项、弹窗、异常状态与辅助标签。
2. 文档/知识库辅助界面、个人资料和剩余管理员子页。
3. 服务端自有错误改为稳定代码和参数，外部原始诊断保留。
4. 移动端、邮件插件和编辑器子包：独立目录、实际版本、语言切换及长英文布局检查。
5. 每个模块同时验收中文、英文、页面内切换、空/成功/错误状态、日期和数量，以及用户内容不变。

## 第二轮扫描快照

- 网页：856 处候选，81 个文件。
- 移动端：187 处候选，13 个文件。
- 邮件扩展：405 处候选，9 个文件（独立仓库，只读扫描）。

数量是待人工核对的语法节点，不是确认缺陷数。当前工作区另有插件拆分，部分文件被移除，因此不能把与首轮的数量差全部算作国际化修复。

| 文件                                                      | 候选数 |
| --------------------------------------------------------- | -----: |
| `apps/web/src/features/ai/ai-admin.tsx`                   |    198 |
| `apps/mobile/src/document-panel.tsx`                      |     86 |
| `apps/web/src/features/documents/file-transfer.tsx`       |     48 |
| `apps/mobile/src/folder-browser.tsx`                      |     40 |
| `apps/web/src/features/documents/document-editor.tsx`     |     39 |
| `apps/web/src/features/admin/storage-settings.tsx`        |     34 |
| `apps/web/src/features/ai/ai-user-settings.tsx`           |     26 |
| `apps/web/src/features/documents/uploads.tsx`             |     26 |
| `apps/mobile/src/ai-trace.tsx`                            |     25 |
| `apps/web/src/features/admin/registration-reviews.tsx`    |     19 |
| `apps/web/src/features/account/profile.tsx`               |     16 |
| `apps/web/src/features/quick-notes/quick-note-editor.tsx` |     15 |
| `apps/web/src/features/settings/directory-settings.tsx`   |     15 |
| `apps/web/src/features/admin/template-settings.tsx`       |     14 |
| `apps/web/src/features/ai/ai-note.tsx`                    |     14 |
| `apps/web/src/features/ai/ai-pending-queue.tsx`           |     14 |
| `apps/web/src/features/documents/spreadsheet-editor.tsx`  |     14 |
| `apps/web/src/features/ai/ai-reference-tag.tsx`           |     13 |
| `apps/web/src/features/documents/access-tasks.tsx`        |     13 |
| `apps/web/src/features/documents/tree.tsx`                |     13 |

逐项位置、类型和片段见 `docs/i18n-audit-candidates.json`。时间戳排序、语言选择器的“中文”、系统目录内部旧名称、内容协议和提示词需要分类处理；不得机械替换。

## 第二轮验证结果

- 全量类型检查通过。
- 国际化、日期与作者相关 4 个文件、43 项测试通过。
- 生产构建通过，仍有产物体积提示。
- 独立模拟数据页面已验证登录设置的中英即时切换、注册规则和字段表单；未提交任何真实配置。
- 浏览器后续连接中断，未完成文件选择器及全系统长英文布局验收。临时验证入口已移除。
- 当前全量测试：124 个文件通过、5 个失败；795 项通过、24 项失败、1 项跳过。失败位于 mail、mail-external、mail-wildduck、knowledge-records 和 server-plugin-adapters，主要为邮件路由 404 和邮件插件注册预期不符。
- 本轮改动的空白检查通过；工作区其他测试文件仍有尾随空白。
- 第一轮的 836 项通过属于历史结果，不代表当前工作区全量结果。
