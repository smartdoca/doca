import type { meteredModel } from "./model.js";
/** Consume the provider stream even for structured work, avoiding idle HTTP gateway timeouts. */
export async function knowledgeGenerate(
  model: Awaited<ReturnType<typeof meteredModel>>,
  options: Parameters<typeof model.doGenerate>[0],
) {
  const result = await model.doStream(options);
  const reader = result.stream.getReader();
  const content: any[] = [];
  let text = "",
    finishReason: any;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      const chunk = value.value;
      if (chunk.type === "error") throw new Error("知识模型输出中断，请重试");
      if (chunk.type === "text-delta") text += chunk.delta;
      if (chunk.type === "tool-call") content.push(chunk);
      if (chunk.type === "finish") finishReason = chunk.finishReason;
    }
  } finally {
    reader.releaseLock();
  }
  if (!finishReason) throw new Error("知识模型连接提前关闭，未提交不完整结果");
  if (text) content.unshift({ type: "text", text });
  return { content, finishReason };
}
