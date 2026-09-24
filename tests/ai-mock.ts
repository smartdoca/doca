export function completionResponse(body: any, streaming: boolean, delay = 0) {
  if (!streaming) return Response.json(body);
  const message = body.choices[0].message;
  const deltas: any[] = [{ role: "assistant" }];
  for (const field of ["reasoning_content", "content"])
    for (const part of String(message[field] ?? "").match(/.{1,6}/gs) ?? [])
      deltas.push({ [field]: part });
  if (message.tool_calls)
    deltas.push({
      tool_calls: message.tool_calls.map((t: any, index: number) => ({
        ...t,
        index,
      })),
    });
  const chunks = deltas.map((delta) => ({
    ...body,
    usage: undefined,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  chunks.push({
    ...body,
    object: "chat.completion.chunk",
    choices: [
      { index: 0, delta: {}, finish_reason: body.choices[0].finish_reason },
    ],
  });
  let index = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (index === chunks.length) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(chunks[index++])}\n\n`,
          ),
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
// OpenAI Responses API envelope for the same fixture messages.
export function responsesResponse(
  message: any,
  model: string,
  streaming: boolean,
  chunkDelay = 0,
) {
  const reasoning = message.reasoning_content
    ? {
        id: "rs_mock",
        type: "reasoning",
        summary: [{ type: "summary_text", text: message.reasoning_content }],
      }
    : null;
  const output: any[] = [
    ...(reasoning ? [reasoning] : []),
    ...(message.tool_calls
      ? message.tool_calls.map((t: any, index: number) => ({
          id: `fc_mock_${index}`,
          type: "function_call",
          call_id: t.id,
          name: t.function.name,
          arguments: t.function.arguments,
          status: "completed",
        }))
      : [
          {
            id: "msg_mock",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: String(message.content ?? ""),
                annotations: [],
              },
            ],
          },
        ]),
  ];
  const response = {
    id: "mock-response",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    output,
    usage: {
      input_tokens: 100_000,
      output_tokens: 40_000,
      total_tokens: 140_000,
      input_tokens_details: { cached_tokens: 20_000 },
    },
  };
  if (!streaming) return Response.json(response);
  const events: any[] = [
    { type: "response.created", response: { id: response.id, created_at: 1, model } },
  ];
  if (reasoning) {
    events.push(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: reasoning.id, type: "reasoning" },
      },
      {
        type: "response.reasoning_summary_part.added",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
      },
    );
    for (const part of message.reasoning_content.match(/.{1,6}/gs) ?? [])
      events.push({
        type: "response.reasoning_summary_text.delta",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        delta: part,
      });
    events.push(
      {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...reasoning, encrypted_content: null },
      },
    );
  }
  const textItem = output.at(-1);
  if (textItem.type === "message") {
    events.push({
      type: "response.output_item.added",
      output_index: output.length - 1,
      item: {
        id: textItem.id,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    for (const part of textItem.content[0].text.match(/.{1,6}/gs) ?? [])
      events.push({
        type: "response.output_text.delta",
        item_id: textItem.id,
        output_index: output.length - 1,
        content_index: 0,
        delta: part,
        logprobs: [],
      });
    events.push({
      type: "response.output_item.done",
      output_index: output.length - 1,
      item: textItem,
    });
  } else {
    for (const call of output.filter((i) => i.type === "function_call"))
      events.push(
        {
          type: "response.output_item.added",
          output_index: output.indexOf(call),
          item: { ...call, arguments: "" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: call.id,
          output_index: output.indexOf(call),
          arguments: call.arguments,
        },
        {
          type: "response.output_item.done",
          output_index: output.indexOf(call),
          item: call,
        },
      );
  }
  events.push({ type: "response.completed", response });
  let index = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (chunkDelay)
          await new Promise((resolve) => setTimeout(resolve, chunkDelay));
        if (index === events.length) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(events[index++])}\n\n`,
          ),
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
// Deterministic OpenAI-compatible fixture. It sees only the same prompts/tools as a provider.
export function mockAI(
  options: {
    delay?: number;
    record?: (body: any) => void;
    reasoning?: string;
    chunkDelay?: number;
  } = {},
): typeof fetch {
  return (async (_url, init) => {
    if (String(_url).endsWith("/models"))
      return Response.json({ data: [{ id: "isolated-mock" }] });
    const responsesApi = String(_url).endsWith("/responses");
    const body = JSON.parse(String(init?.body));
    if (responsesApi) {
      // Normalize the Responses envelope into the chat shape used below.
      body.messages = (body.input ?? [])
        .map((item: any) => {
          if (item.type === "function_call_output")
            return { role: "tool", content: item.output };
          if (item.type === "function_call")
            return {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: item.call_id,
                  type: "function",
                  function: { name: item.name, arguments: item.arguments },
                },
              ],
            };
          const parts = Array.isArray(item.content)
            ? item.content
            : [{ type: "input_text", text: String(item.content ?? "") }];
          return {
            role: item.role,
            content: parts
              .filter(
                (p: any) =>
                  p.type === "input_text" ||
                  p.type === "output_text" ||
                  p.type === "text",
              )
              .map((p: any) => ({ type: "text", text: p.text })),
          };
        })
        .filter((m: any) => m.role);
      body.tools = body.tools?.map((t: any) =>
        t.type === "function" && t.name
          ? { type: "function", function: { name: t.name } }
          : t,
      );
      if (body.tool_choice?.name)
        body.tool_choice = {
          type: "function",
          function: { name: body.tool_choice.name },
        };
    }
    options.record?.(body);
    if (options.delay)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, options.delay);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    const messages: any[] = body.messages;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const userContent = messages[lastUser]?.content;
    const combined = Array.isArray(userContent)
      ? userContent
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
      : String(userContent ?? "");
    // Intent matching uses the actual user request, not the host's per-turn context.
    const prompt = combined.startsWith("【本轮上下文】")
      ? combined
          .slice(combined.indexOf("【用户要求】") + "【用户要求】".length)
          .trim()
      : combined;
    const turns = messages.slice(lastUser + 1);
    const results = turns
      .filter((m) => m.role === "tool")
      .map((m) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return { error: String(m.content) };
        }
      });
    const source = JSON.stringify(messages.slice(0, lastUser + 1));
    const target =
      prompt.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0] ??
      source.match(/resourceId\\?"\s*:\s*\\?"([a-f0-9-]{36})/)?.[1];
    const call = (name: string, args: any) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "mock-tool-" + results.length,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    let message: any = {
      role: "assistant",
      content: "这是模拟 AI 的回答，用于验证会话、页面和积分。",
    };
    if (
      body.tools?.some((t: any) => t.function?.name === "submit_review")
    ) {
      const request = JSON.parse(prompt);
      const reads = results.filter((r) => r.resource);
      const current = reads.at(-1);
      if (current?.nextOffset != null)
        message = call("document_read", {
          resourceId: current.resource.id,
          offset: current.nextOffset,
          limit: 30000,
        });
      else {
        const remaining = request.artifacts.find(
          (id: string) => !reads.some((r) => r.resource.id === id),
        );
        message = remaining
          ? call("document_read", {
              resourceId: remaining,
              offset: 0,
              limit: 30000,
            })
          : results.some((r) => r.accepted)
            ? { role: "assistant", content: "模拟验收已完成。" }
            : call("submit_review", {
                verdict: request.artifacts.length ? "pass" : "revise",
                summary: "隔离测试：已回读模拟交付物。",
                checks: request.plan?.criteria?.length
                  ? request.plan.criteria.map(
                      (requirement: string, criterionIndex: number) => ({
                        requirement,
                        criterionIndex,
                        passed: !!request.artifacts.length,
                        evidence: `已读取 ${reads.length} 个成果片段。`,
                      }),
                    )
                  : [
                      {
                        requirement: "模拟成果已保存",
                        passed: !!request.artifacts.length,
                        evidence: `已读取 ${reads.length} 个成果片段。`,
                      },
                    ],
              });
      }
    } else if (results.some((r) => !r || r.error || r.isError))
      message.content = "模拟任务未完成：工具返回错误，请检查任务和文档权限。";
    else if (
      prompt.includes("联网") &&
      body.tools?.some((t: any) => t.function?.name === "web_search")
    ) {
      if (!results.length)
        message = call("web_search", { query: "SearXNG documentation" });
      else
        message.content =
          "联网结果：\n" +
          (results[0]?.sources ?? [])
            .map((r: any) => `[${r.title}](${r.url})：${r.snippet}`)
            .join("\n");
    } else if (prompt.includes("搜索") || prompt.includes("检索")) {
      if (!results.length)
        message = call("knowledge_search", {
          query: prompt.replace(/^.*?(搜索|检索)/, "").trim(),
          offset: 0,
        });
      else
        message.content =
          "检索结果：\n" +
          (results[0]?.items ?? [])
            .map((r: any) => `[${r.title}](${r.url})：${r.snippet}`)
            .join("\n");
    } else if (prompt.includes("整理成资料") && !prompt.includes("我的选择")) {
      // 类型不明确：先出选择卡片，等待用户下一轮选择
      message = call("ask_user", {
        title: "要创建哪种类型的文档？",
        options: ["富文本文档", "Markdown 文档", "表格", "演示文稿"],
      });
    } else if (prompt.includes("创建") || prompt.includes("我的选择")) {
      if (!results.length) {
        // 未明确格式时不传 format，交由工具默认 rich_text；审批恢复时从
        // 审批详情（类型：表格等）推导同一格式，保证重放参数一致。
        const format = /表格/.test(prompt)
          ? "spreadsheet"
          : /演示|PPT|幻灯片/.test(prompt)
            ? "presentation"
            : /markdown/i.test(prompt)
              ? "markdown"
              : undefined;
        message = call("document_create", {
          title: "AI 创建的项目计划",
          kind: "document",
          ...(format === "markdown"
            ? {
                format,
                markdown:
                  "# 项目计划\n\n## 目标\n完善文档协作。\n\n## 验收\n功能、权限和页面全部检查。",
              }
            : format
              ? { format }
              : {}),
        });
      } else message.content = `已创建 [项目计划](#/r/${results[0]?.id})。`;
    } else if (target) {
      if (!results.length)
        message = call("document_read", {
          resourceId: target,
          offset: 0,
          limit: 16000,
        });
      else if (
        results.length === 1 &&
        /添加|修改|公式|画图|幻灯片/.test(prompt)
      ) {
        const read = results[0],
          native = read.outline ?? JSON.parse(read.content ?? "null");
        const format = read.resource?.format;
        const title = (id: string, text: string, y: number, size: number) => ({
          id,
          type: "text",
          transform: {
            x: 914400,
            y,
            width: native.size.width - 1828800,
            height: 1200000,
            rotation: 0,
          },
          paragraphs: [
            {
              type: "paragraph",
              children: [{ text, fontSize: size, color: "#433064" }],
            },
          ],
        });
        const operations =
          format === "canvas"
            ? [
                {
                  type: "add",
                  element: {
                    id: "mock-node",
                    tag: "Rect",
                    x: 100,
                    y: 100,
                    width: 180,
                    height: 90,
                    fill: "#eee7ff",
                  },
                },
                {
                  type: "add",
                  element: {
                    id: "mock-label",
                    tag: "Text",
                    x: 130,
                    y: 130,
                    text: "需求评审",
                    fontSize: 22,
                    fill: "#51417b",
                  },
                },
              ]
            : format === "presentation"
              ? [
                  {
                    type: "addSlide",
                    slide: {
                      id: "mock-page",
                      name: "AI 项目计划",
                      background: "#f7f4fc",
                      elementOrder: ["mock-title", "mock-body"],
                      elements: {
                        "mock-title": title(
                          "mock-title",
                          "项目计划",
                          914400,
                          40,
                        ),
                        "mock-body": title(
                          "mock-body",
                          "明确目标 · 分步执行 · 验证交付",
                          2600000,
                          24,
                        ),
                      },
                    },
                  },
                ]
              : format === "spreadsheet"
                ? [
                    {
                      type: "cells",
                      sheetId: native.sheetOrder[0],
                      cells: {
                        0: {
                          0: { v: 10, f: null },
                          1: { v: null, f: "=A1*2" },
                        },
                      },
                    },
                  ]
                : [
                    {
                      type: "append",
                      text: "AI 模拟写入：明确目标，分步执行，检查交付结果。",
                    },
                  ];
        message = call(`${format}_edit`, {
          resourceId: target,
          seq: read.seq,
          epochId: read.epochId,
          operations,
        });
      } else if (results.length === 1 && prompt.includes("重命名")) {
        message = call("resource_manage", {
          action: "rename",
          resourceId: target,
          version: results[0].resource.version,
          title: "AI 整理后的文档",
        });
      } else
        message.content = /总结/.test(prompt)
          ? `根据已读取的 [文档](#/r/${target})：\n1. 本文用于验证在线协作与 AI 创作。\n2. 保留原文结构，按引用区域操作。\n3. 保存结果有独立回执。`
          : results.length > 1
            ? `操作已保存到 [文档](#/r/${target})。`
            : `已读取 [文档](#/r/${target})，请告诉我需要处理的内容。`;
    }
    const finalMessage = {
      ...message,
      ...(!message.tool_calls && options.reasoning
        ? { reasoning_content: options.reasoning }
        : {}),
    };
    if (responsesApi)
      return responsesResponse(
        finalMessage,
        body.model,
        !!body.stream,
        options.chunkDelay,
      );
    return completionResponse(
      {
        id: "mock-response",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: finalMessage,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 100_000,
          completion_tokens: 40_000,
          total_tokens: 140_000,
          prompt_cache_hit_tokens: 20_000,
        },
      },
      !!body.stream,
      options.chunkDelay,
    );
  }) as typeof fetch;
}
