# 插件启动 AI 助手

[English](plugin-assistant.md)

当前 SDK 0.1.7 源码提供 `PluginWebHost.ai.open(input)`，Web 打开完整个人助手，App 插件 WebView 打开原生会话页。源码验证不代表 npm 已发布或 App 已更新。该接口不是服务端后台执行 API。

```ts
import type { PluginAssistantOpenInput } from "@smartdoca/plugin-sdk/web";

const input: PluginAssistantOpenInput = {
  prompt: "总结这封邮件并列出待办事项",
  context: mail.plainText,
  documentIds: [document.id],
  attachmentFileIds: [attachment.fileId],
};
const { sessionId } = await host.ai.open(input);
```

| 参数 | 行为与限制 |
| --- | --- |
| `prompt` | 输入框初始文本，可编辑 |
| `context` | 普通文本，追加到 `prompt` 后；两者合计最多 20,000 字符，作为用户消息而非系统指令 |
| `documentIds` | 最多 20 个不同的宿主文档 UUID；宿主读取当前可访问的标题、格式并显示引用标签 |
| `attachmentFileIds` | 最多 8 个不同的宿主文件 UUID；每个最多 20 MiB，总计最多 25 MiB，通过授权接口复制为 AI 附件 |
| `sessionId` | 指定当前用户的已有会话 UUID；省略时创建新会话，归档会话须先恢复 |
| `modelId` | 指定可用模型；省略时依次使用会话模型、用户默认模型、站点默认模型 |
| `autoSend` | 默认为预填。显式 `true` 才提交消息，且必须有非空 `prompt` 或 `context` |

`host.ai.open()` 可打开一个新的空会话。返回 `Promise<{sessionId: string; jobId?: string}>`；只有立即发送成功提交任务时才有 `jobId`，它不代表模型任务已完成。同一客户端启动期间的重复调用会拒绝；每次成功的新调用都是一次独立启动，不自动重试消息。

```ts
const { sessionId, jobId } = await host.ai.open({
  prompt: "生成回复草稿",
  context: mail.plainText,
  autoSend: true,
});
```

引用、文件、会话、模型和发送都经过当前宿主授权。身份来自登录会话，不能传入 `userId`、令牌或系统提示词；未知字段、重复 ID、无效 UUID、超限参数均拒绝。插件负责确认其业务内容允许提供给该用户和 AI。启动不会扩大资源权限，也不会跳过模型执行策略、工具审批或使用量记录。

权限拒绝、不可用模型、归档/他人会话、附件超限、网络错误和账号切换会使 Promise 拒绝。尚在解析的附件可以预填；立即发送会明确报错，插件可稍后重试或打开预填会话。失败不删除用户数据，已创建的普通附件或空会话按宿主现有规则保留。

预填内容仅保存在当前界面进程内存中，刷新或进程退出不保留；地址栏只包含会话 ID，以及 App 内部一次性启动标识，不包含正文或附件参数。App 原生 `assistant.open` 请求使用当前插件命名空间和固定账号凭据，离开插件页或切换账号会取消未完成请求；凭据不进入 WebView。Web 和 App 的引用/附件均可在发送前移除。

没有新增数据库结构、旧格式读取、数据迁移或旧宿主适配。已有会话仍使用宿主现有会话和消息格式；回滚源代码不需要转换或删除它们。缺少该方法的宿主或缺少 `assistant.open` 的原生容器不能提供该能力，必须部署相应的新产物；独立 npm 发布和真机验收仍需另外完成。
