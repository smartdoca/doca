# Launch the AI assistant from a plugin

[中文](plugin-assistant.zh-CN.md)

SDK source 0.1.7 introduced `PluginWebHost.ai.open(input)`. Web opens the full personal assistant; an App plugin WebView opens the native conversation. Source verification does not establish npm publication or an updated App. This is a client launch API; server background execution has a separate contract.

```ts
import type { PluginAssistantOpenInput } from "@smartdoca/plugin-sdk/web";

const input: PluginAssistantOpenInput = {
  prompt: "Summarize this email and list action items",
  context: mail.plainText,
  documentIds: [document.id],
  attachmentFileIds: [attachment.fileId],
};
const { sessionId } = await host.ai.open(input);
```

| Parameter | Behavior and limits |
| --- | --- |
| `prompt` | Editable initial input text |
| `context` | Plain text appended after `prompt`; combined maximum 20,000 characters, as a user message rather than a system instruction |
| `documentIds` | At most 20 distinct host document UUIDs; the host reads currently authorized titles/formats and displays reference chips |
| `attachmentFileIds` | At most 8 distinct host file UUIDs, at most 20 MiB each and 25 MiB total; copied through authorized APIs into AI attachments |
| `sessionId` | An existing conversation UUID belonging to the current user; omission creates a conversation; archived conversations must first be restored |
| `modelId` | An available model; omission uses the conversation model, user default, then site default |
| `autoSend` | Prefill by default; explicit `true` submits a message and requires nonempty `prompt` or `context` |

`host.ai.open()` can open an empty conversation. It returns `Promise<{sessionId: string; jobId?: string}>`. `jobId` exists only when immediate sending submits a job; it does not mean the model finished. Concurrent duplicate launches in one client are rejected. Each successful new call is a separate launch and does not automatically retry the message.

```ts
const { sessionId, jobId } = await host.ai.open({
  prompt: "Draft a reply",
  context: mail.plainText,
  autoSend: true,
});
```

References, files, conversations, models, and sending all use current host authorization. Identity comes from the session. Inputs cannot provide `userId`, tokens, or system prompts. Unknown fields, duplicate IDs, invalid UUIDs, and excessive inputs are rejected. Plugins must ensure their business content may be given to that user and AI. Launching does not expand resource permissions or bypass model execution policies, tool approvals, or usage recording.

Denied permissions, unavailable models, archived/other-user conversations, attachment limits, network errors, and account switching reject the Promise. Attachments still being parsed can be prefilled; immediate sending reports an explicit error. The plugin can retry later or open a prefilled conversation. Failure deletes no user data; created ordinary attachments or empty conversations follow existing host retention rules.

Prefill exists only in the current UI process memory and is lost on refresh/exit. URLs contain only the conversation ID and an App internal one-time launch identifier, without body or attachment parameters. Native `assistant.open` uses the plugin namespace and fixed account credentials. Leaving the plugin or switching accounts cancels pending requests; credentials never enter the WebView. References and attachments can be removed before sending on Web and App.

This increment introduced no database schema, old-format reader, migration, or old-host adapter. Existing conversations retain the host's normal format; reverting source needs no conversion or deletion. A host lacking this method, or a native container lacking `assistant.open`, cannot provide the capability. Deploy the matching artifacts; independent npm publication and device acceptance require separate verification.
