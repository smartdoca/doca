import { fail } from "@core/shared/errors.js";
import type { AIConfig } from "@core/modules/ai/config.js";

export type WebSource = {
  title: string;
  url: string;
  snippet: string;
  retrievedAt: string;
};
export type WebSearchConstraints = {
  sites?: string[];
  exclude?: string[];
  freshness?: "day" | "week" | "month" | "year";
  language?: "zh" | "en";
  limit?: number;
};

const freshnessBrave = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

export function normalizeWebSites(value: string | undefined) {
  const parts = (value ?? "").split(/[\s,，;；]+/u).map((item) => item.trim()).filter(Boolean).slice(0, 5);
  const sites: string[] = [];
  for (const part of parts) {
    const host = part.replace(/^https?:\/\//iu, "").split(/[/?#]/u)[0]?.replace(/\.$/u, "") ?? "";
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/iu.test(host))
      fail(400, "网站限制需要写成域名，例如 example.com");
    sites.push(host.toLowerCase());
  }
  return sites;
}

export function normalizeWebExclude(value: string | undefined) {
  return (value ?? "")
    .split(/[\s,，;；]+/u)
    .map((item) => item.replace(/^[+-]+/u, "").trim())
    .filter((item) => item.length >= 1 && item.length <= 24 && /^[\p{L}\p{N}.-]+$/u.test(item))
    .slice(0, 8);
}

export function composeWebQuery(query: string, constraints?: WebSearchConstraints, includeSites = true) {
  const sites = includeSites ? constraints?.sites ?? [] : [];
  const exclude = constraints?.exclude ?? [];
  let text = query.trim();
  if (sites.length === 1) text += ` site:${sites[0]}`;
  else if (sites.length > 1) text += ` (${sites.map((site) => `site:${site}`).join(" OR ")})`;
  for (const term of exclude) text += ` -${term}`;
  return text.slice(0, 360);
}

// Search endpoints are fixed: model-supplied URLs never become server fetch targets.
export async function searchWeb(
  config: AIConfig["webSearch"],
  query: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  constraints?: WebSearchConstraints,
): Promise<{ sources: WebSource[]; provider: string; query: string }> {
  if (
    !config ||
    (config.provider === "searxng" ? !config.baseUrl : !config.apiKey)
  )
    fail(400, "联网搜索尚未配置，请管理员在 AI 设置中填写搜索服务配置");
  const abort = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(signal ? [signal] : []),
  ]);
  const tavily = config.provider === "tavily";
  const selfHosted = config.provider === "searxng";
  const limit = Math.min(8, Math.max(1, constraints?.limit ?? 5));
  const outbound = composeWebQuery(query, constraints, !tavily);
  const selfUrl = selfHosted
    ? new URL("search", config.baseUrl!.replace(/\/?$/, "/"))
    : null;
  if (selfUrl) {
    const params = new URLSearchParams({
      q: outbound,
      format: "json",
      categories: "general",
    });
    if (constraints?.language) params.set("language", constraints.language === "zh" ? "zh-CN" : "en");
    if (constraints?.freshness) params.set("time_range", constraints.freshness);
    selfUrl.search = params.toString();
  }
  const braveParams = new URLSearchParams({ q: outbound, count: String(limit), extra_snippets: "true" });
  if (constraints?.language) braveParams.set("search_lang", constraints.language === "zh" ? "zh-hans" : "en");
  if (constraints?.freshness) braveParams.set("freshness", freshnessBrave[constraints.freshness]);
  const url =
    selfUrl?.href ??
    (tavily
      ? "https://api.tavily.com/search"
      : `https://api.search.brave.com/res/v1/web/search?${braveParams}`);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: tavily ? "POST" : "GET",
      redirect: "error",
      signal: abort,
      headers: selfHosted
        ? {
            Accept: "application/json",
            ...(config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {}),
          }
        : tavily
          ? {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            }
          : {
              "X-Subscription-Token": config.apiKey!,
              Accept: "application/json",
            },
      ...(tavily
        ? {
            body: JSON.stringify({
              query: outbound,
              max_results: limit,
              search_depth: "advanced",
              include_answer: false,
              include_raw_content: false,
              ...(constraints?.sites?.length ? { include_domains: constraints.sites } : {}),
              ...(constraints?.freshness ? { time_range: constraints.freshness } : {}),
            }),
          }
        : {}),
    });
  } catch {
    signal?.throwIfAborted();
    fail(502, "联网搜索连接失败或超时，请稍后重试");
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail(
      response.status === 429 ? 429 : 502,
      [401, 403].includes(response.status)
        ? "搜索服务认证失败，请管理员检查密钥"
        : "搜索服务暂不可用，请稍后重试",
    );
  }
  // Bound remote payloads before parsing; never expose provider error bodies or credentials.
  const reader = response.body?.getReader();
  if (!reader) fail(502, "搜索服务返回空响应");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      fail(502, "搜索结果过大，请缩小检索范围");
    }
    parts.push(item.value);
  }
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    fail(502, "搜索服务返回了无效结果");
  }
  const rows = tavily || selfHosted ? body.results : body.web?.results;
  if (!Array.isArray(rows)) fail(502, "搜索服务返回了无效结果");
  const sources: WebSource[] = [];
  for (const row of rows.slice(0, limit)) {
    try {
      const u = new URL(row.url);
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        continue;
      sources.push({
        title: String(row.title ?? u.hostname).slice(0, 300),
        url: u.href,
        snippet: String(
          row.content ??
            [row.description, ...(row.extra_snippets ?? [])]
              .filter(Boolean)
              .join("\n"),
        ).slice(0, 6000),
        retrievedAt: new Date().toISOString(),
      });
    } catch {
      /* Invalid provider result is not a usable source. */
    }
  }
  return { sources, provider: config.provider, query: outbound };
}
