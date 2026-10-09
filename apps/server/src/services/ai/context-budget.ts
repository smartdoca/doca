const RESULT_TYPES = new Set([
  "tool-result",
  "tool_result",
  "function_call_output",
]);
const KEEP_KEYS = [
  "resourceId",
  "id",
  "seq",
  "epochId",
  "ok",
  "status",
  "nextOffset",
  "nextCursor",
  "hasMore",
  "requiresApproval",
  "approvalId",
  "callId",
  "fileId",
  "assetId",
  "referenceImageId",
  "filename",
  "imageOffset",
  "imageLimit",
  "totalImages",
  "nextImageOffset",
  "jobId",
  "href",
  "code",
  "error",
  "title",
  "accepted",
  "verdict",
  "view",
  "done",
  "next",
];

function previewValue(value: unknown, max: number): unknown {
  if (value == null) return value;
  if (typeof value === "string")
    return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
  const json = JSON.stringify(value);
  if (!json || json.length <= max) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const slim: Record<string, unknown> = { truncated: true };
    for (const key of KEEP_KEYS)
      if (key in obj) slim[key] = previewValue(obj[key], Math.min(200, max));
    if (typeof obj.content === "string")
      slim.contentPreview = obj.content.slice(0, Math.min(200, max));
    return slim;
  }
  return `${json.slice(0, max)}…[truncated]`;
}

function isToolResultPart(part: any) {
  return (
    part &&
    (RESULT_TYPES.has(part.type) ||
      part.result !== undefined ||
      (part.output !== undefined && part.toolCallId))
  );
}

function resultPayload(part: any) {
  if (part.result !== undefined) return part.result;
  if (part.output && typeof part.output === "object" && "value" in part.output)
    return part.output.value;
  return part.output;
}

function withPayload(part: any, preview: unknown) {
  if (part.result !== undefined) return { ...part, result: preview };
  if (part.output && typeof part.output === "object" && "value" in part.output)
    return {
      ...part,
      output: {
        ...part.output,
        // The current SDK requires content.value to remain a part array. A
        // truncated summary is text, never the original diagnostic metadata.
        value: part.output.type === "content" && !Array.isArray(preview)
          ? [{ type: "text", text: typeof preview === "string" ? preview : JSON.stringify(preview) }]
          : preview,
      },
    };
  return { ...part, output: preview };
}

function cloneMessage(message: any) {
  if (!message || typeof message !== "object") return message;
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part: any) =>
          part && typeof part === "object" ? { ...part } : part,
        )
      : Array.isArray(message.content?.parts)
        ? {
            ...message.content,
            parts: message.content.parts.map((part: any) =>
              part && typeof part === "object" ? { ...part } : part,
            ),
          }
        : message.content,
  };
}

const CALL_TYPES = new Set(["tool-call", "tool_call", "function_call"]);
export const MODEL_INPUT_BYTE_FACTOR = 4;

function isToolCallPart(part: any) {
  return !!(part && CALL_TYPES.has(part.type) && !isToolResultPart(part));
}

function callPayload(part: any) {
  if (part.args !== undefined) return part.args;
  if (part.input !== undefined) return part.input;
  return part.parameters;
}

function withCallPayload(part: any, preview: unknown) {
  if (part.args !== undefined) return { ...part, args: preview };
  if (part.input !== undefined) return { ...part, input: preview };
  return { ...part, parameters: preview };
}

function messageParts(message: any): any[] {
  if (Array.isArray(message?.content)) return message.content;
  if (Array.isArray(message?.content?.parts)) return message.content.parts;
  return [];
}

/** Keep the latest tool results verbatim; older bulky payloads become recoverability stubs. */
export function trimToolResults(messages: any[], keepRecent = 2) {
  const cloned = messages.map(cloneMessage);
  const indexes: number[] = [];
  cloned.forEach((message, index) => {
    const parts = messageParts(message);
    if (parts.some(isToolResultPart)) indexes.push(index);
  });
  const keep = new Set(keepRecent > 0 ? indexes.slice(-keepRecent) : []);
  for (const [index, message] of cloned.entries()) {
    if (keep.has(index)) continue;
    const parts = messageParts(message).map((part: any) => {
      if (!isToolResultPart(part)) return part;
      const payload = resultPayload(part);
      const preview = previewValue(payload, 500);
      return preview === payload ? part : withPayload(part, preview);
    });
    if (Array.isArray(message?.content)) message.content = parts;
    else if (Array.isArray(message?.content?.parts))
      message.content.parts = parts;
  }
  return cloned;
}

/** Keep the latest tool-call arguments; older bulky payloads become recoverability stubs. */
export function trimToolCalls(messages: any[], keepRecent = 2) {
  const cloned = messages.map(cloneMessage);
  const indexes: number[] = [];
  cloned.forEach((message, index) => {
    if (messageParts(message).some(isToolCallPart)) indexes.push(index);
  });
  const keep = new Set(keepRecent > 0 ? indexes.slice(-keepRecent) : []);
  for (const [index, message] of cloned.entries()) {
    if (keep.has(index)) continue;
    const parts = messageParts(message).map((part: any) => {
      if (!isToolCallPart(part)) return part;
      const payload = callPayload(part);
      const preview = previewValue(payload, 240);
      return preview === payload ? part : withCallPayload(part, preview);
    });
    if (Array.isArray(message?.content)) message.content = parts;
    else if (Array.isArray(message?.content?.parts))
      message.content.parts = parts;
  }
  return cloned;
}

export function promptPayloadBytes(prompt: unknown, tools?: unknown) {
  return Buffer.byteLength(
    JSON.stringify({ prompt, tools }, (key, value) =>
      key === "data" || key === "image" ? "[binary]" : value,
    ),
  );
}

export function exceedsModelInput(
  prompt: unknown,
  maxInput: number,
  tools?: unknown,
) {
  return promptPayloadBytes(prompt, tools) > maxInput * MODEL_INPUT_BYTE_FACTOR;
}

export function taskStateFromMessages(messages: any[]) {
  let resourceId: string | undefined;
  let seq: number | undefined;
  let epochId: string | undefined;
  let plan: { goal?: string; steps?: string[] } | null | undefined;
  const applied: string[] = [];
  for (const message of messages) {
    for (const part of messageParts(message)) {
      if (!isToolResultPart(part)) continue;
      const payload = resultPayload(part);
      if (!payload || typeof payload !== "object") continue;
      const row = payload as Record<string, any>;
      if (typeof row.resourceId === "string") resourceId = row.resourceId;
      if (Number.isSafeInteger(row.seq)) seq = row.seq;
      if (typeof row.epochId === "string") epochId = row.epochId;
      if (row.plan && typeof row.plan === "object") plan = row.plan;
      if (Array.isArray(row.done))
        applied.push(...row.done.filter((item) => typeof item === "string"));
      if (Array.isArray(row.applied))
        applied.push(...row.applied.filter((item) => typeof item === "string"));
    }
  }
  return { resourceId, seq, epochId, plan, applied: [...new Set(applied)] };
}

function compactNote(messages: any[]) {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `【较早步骤已自动压缩】请根据回执继续未完成工作，不要重复已成功保存的操作。\n${JSON.stringify(taskStateHint(taskStateFromMessages(messages)))}`,
      },
    ],
  };
}

function lastUserIndex(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user") return i;
  return -1;
}

function exchangeComplete(group: any[]) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of group) {
    for (const part of messageParts(message)) {
      if (isToolCallPart(part) && part.toolCallId) calls.add(part.toolCallId);
      if (isToolResultPart(part) && part.toolCallId)
        results.add(part.toolCallId);
    }
  }
  return !calls.size || [...calls].every((id) => results.has(id));
}

/** Fold older completed assistant/tool groups after the latest user turn. */
export function collapseOlderExchanges(messages: any[], keepRecent = 2) {
  const start = lastUserIndex(messages);
  if (start < 0) return messages;
  const prefix = messages.slice(0, start + 1);
  const rest = messages.slice(start + 1);
  const groups: any[][] = [];
  for (const message of rest) {
    if (message.role === "assistant" || !groups.length) groups.push([]);
    groups.at(-1)!.push(message);
  }
  const tail =
    groups.length && !exchangeComplete(groups.at(-1)!) ? groups.pop()! : [];
  const keep = Math.max(0, keepRecent);
  if (groups.length <= keep) return messages;
  return [
    ...prefix.map(cloneMessage),
    compactNote(messages),
    ...(keep ? groups.slice(-keep) : []).flat().map(cloneMessage),
    ...tail.map(cloneMessage),
  ];
}

function historyTurnsOf(messages: any[]) {
  const system: any[] = [];
  const turns: any[][] = [];
  for (const message of messages) {
    if (message?.role === "system" && !turns.length) {
      system.push(message);
      continue;
    }
    if (message?.role === "user" || !turns.length) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return { system, turns };
}

/** Fold older user turns, keeping the current request. */
export function collapseOlderTurns(messages: any[], keepRecent = 1) {
  const { system, turns } = historyTurnsOf(messages);
  const keep = Math.max(1, keepRecent);
  if (turns.length <= keep) return messages;
  return [
    ...system.map(cloneMessage),
    compactNote(messages),
    ...turns.slice(-keep).flat().map(cloneMessage),
  ];
}

/** Shrink a model prompt until it fits the same byte budget meteredModel enforces. */
export function fitPromptToModelInput(
  prompt: any[],
  maxInput: number,
  tools?: unknown,
  protectedPrefix = 0,
) {
  if (!Array.isArray(prompt)) return prompt;
  if (
    !Number.isSafeInteger(protectedPrefix) ||
    protectedPrefix < 0 ||
    protectedPrefix > prompt.length
  )
    throw new RangeError(
      "Protected prompt prefix must name an existing message boundary",
    );
  if (!exceedsModelInput(prompt, maxInput, tools)) return prompt;
  const stages = [
    (items: any[]) => trimToolResults(items, 1),
    (items: any[]) => trimToolCalls(items, 1),
    (items: any[]) => collapseOlderExchanges(items, 2),
    (items: any[]) => collapseOlderTurns(items, 2),
    (items: any[]) => collapseOlderExchanges(items, 1),
    (items: any[]) => collapseOlderTurns(items, 1),
    (items: any[]) => trimToolResults(items, 1),
    (items: any[]) => trimToolCalls(items, 1),
    (items: any[]) => collapseOlderExchanges(items, 0),
    (items: any[]) => trimToolCalls(items, 0),
    (items: any[]) => trimToolResults(items, 0),
  ];
  // Host-authored task requirements are immutable. Every fit decision includes
  // their full bytes and the tool definitions; only execution history can shrink.
  const prefix = prompt.slice(0, protectedPrefix);
  let next = prompt.slice(protectedPrefix);
  for (const stage of stages) {
    next = stage(next);
    const full = [...prefix, ...next];
    if (!exceedsModelInput(full, maxInput, tools)) return full;
  }
  return [...prefix, ...next];
}

export function taskStateHint(state: {
  plan?: { goal?: string; steps?: string[] } | null;
  seq?: number;
  epochId?: string;
  resourceId?: string;
  applied?: string[];
}) {
  const current = {
    ...(state.resourceId ? { resourceId: state.resourceId } : {}),
    ...(state.seq != null ? { seq: state.seq } : {}),
    ...(state.epochId ? { epochId: state.epochId } : {}),
  };
  return {
    continueWith:
      "使用本回执的 seq/epochId 继续；不要回读全文。定位失败时 document_read 默认 outline，再按 blockId/slideId/sheetId/elementId 读区域。",
    ...current,
    current,
    ...(state.applied?.length ? { done: state.applied } : {}),
    ...(state.plan?.goal ? { goal: state.plan.goal } : {}),
    next:
      state.plan?.steps?.at(-1) ??
      "使用 current.seq/epochId 继续下一批，不要回读全文",
  };
}
