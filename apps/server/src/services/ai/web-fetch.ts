import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Parser } from "htmlparser2";
import ipaddr from "ipaddr.js";
import Firecrawl from "@mendable/firecrawl-js";
import { fail, AppError } from "@core/shared/errors.js";
import type { AIConfig } from "@core/modules/ai/config.js";

const maxBytes = 2 * 1024 * 1024;
export const webFileLimit = 20 * 1024 * 1024;
export const webPageLimit = 200000;
const webFileFailureReasons = new WeakMap<
  Error,
  "temporary-http" | "temporary-network"
>();
/** Private runtime provenance only; public errors and persisted records stay unchanged. */
export function isRetryableWebFileFailure(error: unknown): boolean {
  return error instanceof Error && webFileFailureReasons.has(error);
}
const temporaryNetworkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
function temporaryNetworkFailure(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (error.name === "TimeoutError") return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && temporaryNetworkCodes.has(code))
      return true;
    error = error.cause;
  }
  return false;
}
export function publicWebUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(400, "请提供完整的 HTTP 或 HTTPS 网页链接");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > 4000
  )
    fail(400, "只支持不含账号密码的 HTTP 或 HTTPS 网页链接");
  url.hash = "";
  return url;
}
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
type Address = { address: string; family: number };
type PageResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};
export type PageTransport = (
  url: URL,
  address: Address,
  signal: AbortSignal,
) => Promise<PageResponse>;
function makeTransport(kind: "page" | "file"): PageTransport {
  const limit = kind === "file" ? webFileLimit : maxBytes;
  return (url, address, signal) =>
    new Promise((resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        url,
        {
          agent: false,
          signal,
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [
                  { address: address.address, family: address.family },
                ])
              : callback(null, address.address, address.family),
          headers: {
            Accept:
              kind === "file"
                ? "*/*"
                : "text/html, text/plain, text/markdown, application/json;q=0.8",
            "Accept-Encoding": "identity",
            "User-Agent":
              kind === "file"
                ? "Doca-FileDownloader/1.0"
                : "Doca-LinkReader/1.0",
          },
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const type = String(res.headers["content-type"] ?? "");
          if (
            status < 200 ||
            status >= 300 ||
            (kind === "page" && !supportedContent(type))
          ) {
            resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
            res.destroy();
            return;
          }
          const announced = Number(res.headers["content-length"]);
          if (Number.isFinite(announced) && announced > limit) {
            resolve({
              status: 413,
              headers: res.headers,
              body: Buffer.alloc(0),
            });
            res.destroy();
            return;
          }
          const parts: Buffer[] = [];
          let bytes = 0;
          res.on("data", (part: Buffer) => {
            bytes += part.length;
            if (bytes > limit) {
              const error = new Error(
                kind === "file" ? "file too large" : "page too large",
              );
              // Preserve the size failure even if destroying the socket also
              // emits a network error; validation failures never authorize retries.
              reject(error);
              res.destroy(error);
            } else parts.push(part);
          });
          res.on("end", () =>
            resolve({
              status,
              headers: res.headers,
              body: Buffer.concat(parts),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
}
// Pin the validated DNS result to the socket while retaining hostname/SNI for TLS.
const requestPage = makeTransport("page");
const requestAsset = makeTransport("file");
function supportedContent(type: string) {
  return /^(text\/(html|plain|markdown)|application\/(xhtml\+xml|json))(?:;|$)/i.test(
    type,
  );
}
export function extractWebText(html: string, base: string) {
  let title = "",
    titleDepth = 0,
    skip = 0;
  const stack: {
    skip: boolean;
    title: boolean;
    main: boolean;
    obsolete: boolean;
  }[] = [];
  let mainDepth = 0;
  const all: string[] = [],
    main: string[] = [],
    links: { title: string; url: string }[] = [];
  let anchor: { title: string; url: string } | undefined;
  const add = (text: string) => {
    if (!skip && !titleDepth) {
      all.push(text);
      if (mainDepth) main.push(text);
    }
  };
  const blocks =
    /^(p|div|section|article|main|h[1-6]|li|tr|br|pre|blockquote)$/;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const hidden =
          /^(script|style|noscript|template|svg|nav|footer|header|form)$/.test(
            name,
          ) ||
          "hidden" in attrs ||
          attrs["aria-hidden"] === "true";
        const isTitle = name === "title",
          isMain =
            name === "main" || name === "article" || attrs.role === "main";
        const obsolete =
          /^(del|s|strike)$/.test(name) ||
          /text-decoration(?:-line)?\s*:[^;]*line-through/i.test(
            attrs.style ?? "",
          );
        stack.push({ skip: hidden, title: isTitle, main: isMain, obsolete });
        if (hidden) skip++;
        if (isTitle) titleDepth++;
        if (isMain) mainDepth++;
        if (obsolete) add(" [已删除或废弃的原文：");
        if (blocks.test(name)) add("\n");
        if (name === "a" && attrs.href && !skip) {
          try {
            anchor = {
              title: "",
              url: publicWebUrl(new URL(attrs.href, base).href).href,
            };
          } catch {
            anchor = undefined;
          }
        }
      },
      ontext(text) {
        if (titleDepth) title += text;
        add(text);
        if (anchor && !skip) anchor.title += text;
      },
      onclosetag(name) {
        if (blocks.test(name)) add("\n");
        if (name === "a" && anchor) {
          if (links.length < 50 && anchor.title.trim())
            links.push({
              title: anchor.title.trim().slice(0, 200),
              url: anchor.url,
            });
          anchor = undefined;
        }
        const state = stack.pop();
        if (state?.obsolete) add("（不作为现行结论）] ");
        if (state?.skip) skip--;
        if (state?.title) titleDepth--;
        if (state?.main) mainDepth--;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  const normalize = (s: string) =>
    s
      .replace(/[\t \u00a0]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return {
    title: normalize(title).slice(0, 300),
    text: normalize((main.join("").trim() ? main : all).join("")),
    links,
  };
}
export type WebFetchConfig = NonNullable<AIConfig["webFetch"]>;
type FirecrawlClient = Pick<InstanceType<typeof Firecrawl>, "scrape">;
type FirecrawlFactory = (options: {
  apiKey?: string | null;
  apiUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}) => FirecrawlClient;

async function publicWebAddresses(
  url: URL,
  signal: AbortSignal,
  resolve: ((host: string) => Promise<Address[]>) | undefined,
  intranetMessage: string,
) {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let cancelLookup: (() => void) | undefined;
  let addresses: Address[];
  try {
    addresses = ipaddr.isValid(host)
      ? [
          {
            address: host,
            family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6,
          },
        ]
      : await Promise.race([
          (resolve ?? ((host) => lookup(host, { all: true })))(host),
          new Promise<never>((_, reject) => {
            const onAbort = () => reject(signal.reason);
            cancelLookup = () => signal.removeEventListener("abort", onAbort);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
  } finally {
    cancelLookup?.();
  }
  // VPN fake-IP DNS uses the benchmark range. Resolve the same public hostname
  // over a fixed HTTPS DNS endpoint, then validate the real result.
  // Literal IPs and ordinary private DNS records never take this path.
  if (
    !resolve &&
    !ipaddr.isValid(host) &&
    addresses.some(
      (a) =>
        ipaddr.parse(a.address).kind() === "ipv4" &&
        ipaddr.parse(a.address).match(ipaddr.parseCIDR("198.18.0.0/15")),
    )
  ) {
    const response = await fetch(
      "https://cloudflare-dns.com/dns-query?" +
        new URLSearchParams({ name: host, type: "A" }),
      {
        headers: { Accept: "application/dns-json" },
        redirect: "error",
        signal,
      },
    );
    if (!response.ok || !response.body) throw new Error("DNS unavailable");
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of response.body as any) {
      size += part.byteLength;
      if (size > 65536) throw new Error("DNS response too large");
      parts.push(part);
    }
    const answer = JSON.parse(Buffer.concat(parts).toString());
    addresses = (answer.Answer ?? [])
      .filter((a: any) => a.type === 1)
      .map((a: any) => ({ address: a.data, family: 4 }));
  }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    fail(400, intranetMessage);
  return addresses;
}

/** Knowledge sources remain public even when a configured reader fetches them. */
export async function validatePublicWebSourceUrl(
  value: string,
  signal?: AbortSignal,
  resolve?: (host: string) => Promise<Address[]>,
) {
  const abort = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(signal ? [signal] : []),
  ]);
  try {
    await publicWebAddresses(
      publicWebUrl(value),
      abort,
      resolve,
      "Web sources must use a public address",
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AppError) throw error;
    fail(502, "Web source address lookup failed or timed out");
  }
}

async function fetchPublicResponse(
  value: string,
  signal: AbortSignal | undefined,
  dependencies: {
    resolve?: (host: string) => Promise<Address[]>;
    request?: PageTransport;
  },
  options: {
    kind: "page" | "file";
    timeoutMs: number;
    defaultRequest: PageTransport;
    intranetMessage: string;
    loginMessage: string;
    statusMessage: (status: number) => string;
    fallbackMessage: string;
  },
) {
  let url = publicWebUrl(value);
  const abort = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  try {
    for (let redirect = 0; redirect <= 4; redirect++) {
      abort.throwIfAborted();
      const addresses = await publicWebAddresses(
        url,
        abort,
        dependencies.resolve,
        options.intranetMessage,
      );
      const res = await (dependencies.request ?? options.defaultRequest)(
        url,
        addresses[0]!,
        abort,
      );
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location;
        if (typeof location !== "string") fail(502, "网页跳转地址无效");
        url = publicWebUrl(new URL(location, url).href);
        continue;
      }
      if ([401, 403].includes(res.status)) fail(502, options.loginMessage);
      if (res.status < 200 || res.status >= 300) {
        const error = new AppError(502, options.statusMessage(res.status));
        if (
          options.kind === "file" &&
          (res.status === 429 || (res.status >= 500 && res.status <= 599))
        )
          webFileFailureReasons.set(error, "temporary-http");
        throw error;
      }
      return { url, res };
    }
    fail(502, "网页跳转次数过多");
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AppError) throw error;
    const publicError = new AppError(502, options.fallbackMessage);
    if (options.kind === "file" && temporaryNetworkFailure(error))
      webFileFailureReasons.set(publicError, "temporary-network");
    throw publicError;
  }
}

async function fetchBuiltinWebPage(
  value: string,
  signal?: AbortSignal,
  dependencies: {
    resolve?: (host: string) => Promise<Address[]>;
    request?: PageTransport;
  } = {},
) {
  const { url, res } = await fetchPublicResponse(value, signal, dependencies, {
    kind: "page",
    timeoutMs: 20000,
    defaultRequest: requestPage,
    intranetMessage: "链接指向本机或内网，无法作为公开网页读取",
    loginMessage: "该网页需要登录或拒绝自动读取，请提供可访问链接或上传内容",
    statusMessage: (status) => `网页读取失败（HTTP ${status}）`,
    fallbackMessage: "网页读取失败、响应过大或超时，请稍后重试或上传内容",
  });
  const contentType = String(res.headers["content-type"] ?? "");
  if (!supportedContent(contentType))
    fail(400, "该链接不是可读取的网页或文本；PDF、图片等文件请上传为附件");
  if (res.body.length > maxBytes) fail(413, "网页过大，请提供具体章节链接");
  const charset =
    contentType.match(/charset=["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
  let source: string;
  try {
    source = new TextDecoder(charset).decode(res.body);
  } catch {
    source = res.body.toString("utf8");
  }
  const page = /html/i.test(contentType)
    ? extractWebText(source, url.href)
    : { title: url.hostname, text: source.trim(), links: [] };
  if (!page.text)
    fail(
      502,
      "页面没有可读取正文，可能需要浏览器运行脚本或登录；请提供正文或上传文件",
    );
  return {
    ...page,
    title: page.title || url.hostname,
    text: page.text.slice(0, webPageLimit),
    truncated: page.text.length > webPageLimit,
    url: url.href,
    retrievedAt: new Date().toISOString(),
  };
}

function downloadFilename(url: URL, headers: PageResponse["headers"]) {
  const disposition = String(headers["content-disposition"] ?? "");
  const encoded = /filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i.exec(
    disposition,
  )?.[1];
  const quoted = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  let name = "";
  try {
    name = encoded ? decodeURIComponent(encoded.trim()) : quoted || "";
  } catch {
    name = quoted || "";
  }
  if (!name) {
    try {
      name = decodeURIComponent(url.pathname.split("/").pop() || "");
    } catch {
      name = url.pathname.split("/").pop() || "";
    }
  }
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  if (/^\.+$/.test(name)) name = "download";
  return (name || url.hostname || "download").slice(0, 255);
}

export async function fetchWebFile(
  value: string,
  signal?: AbortSignal,
  dependencies: {
    resolve?: (host: string) => Promise<Address[]>;
    request?: PageTransport;
  } = {},
) {
  const { url, res } = await fetchPublicResponse(value, signal, dependencies, {
    kind: "file",
    timeoutMs: 60000,
    defaultRequest: requestAsset,
    intranetMessage: "链接指向本机或内网，无法作为公开文件下载",
    loginMessage: "该文件需要登录或拒绝自动下载，请提供可访问链接或上传文件",
    statusMessage: (status) =>
      status === 413 ? "文件超过 20MB 上限" : `文件下载失败（HTTP ${status}）`,
    fallbackMessage: "文件下载失败、过大或超时，请稍后重试或上传文件",
  });
  if (res.status === 413 || res.body.length > webFileLimit)
    fail(413, "文件超过 20MB 上限");
  if (!res.body.length) fail(502, "没有下载到文件内容");
  const declared = String(res.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim();
  return {
    url: url.href,
    filename: downloadFilename(url, res.headers),
    mime: declared,
    body: res.body,
    retrievedAt: new Date().toISOString(),
  };
}

function externalEndpoint(
  baseUrl: string | undefined,
  fallback: string,
  path: string,
) {
  const base = (baseUrl || fallback).replace(/\/+$/, "");
  return base.endsWith(path) ? base : `${base}${path}`;
}

function firecrawlApiUrl(baseUrl?: string) {
  return (baseUrl || "https://api.firecrawl.dev")
    .replace(/\/+$/, "")
    .replace(/\/v2$/, "");
}

function markdownPage(markdown: string, sourceUrl: string, title?: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const links: { title: string; url: string }[] = [];
  for (const match of markdown.matchAll(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
  )) {
    try {
      const url = publicWebUrl(match[2]!).href;
      if (links.length < 50)
        links.push({ title: match[1]!.slice(0, 200), url });
    } catch {
      /* Ignore malformed provider links. */
    }
  }
  if (!text) fail(502, "网页读取服务没有返回正文");
  return {
    title: (title || heading || new URL(sourceUrl).hostname).slice(0, 300),
    text: text.slice(0, webPageLimit),
    links,
    truncated: text.length > webPageLimit,
    url: sourceUrl,
    retrievedAt: new Date().toISOString(),
  };
}

function externalPage(
  content: string,
  sourceUrl: string,
  title: string | undefined,
  format: "markdown" | "html",
): ReturnType<typeof markdownPage> & { html?: string } {
  if (format === "markdown") return markdownPage(content, sourceUrl, title);
  if (!content.trim()) fail(502, "Web reader did not return HTML");
  if (Buffer.byteLength(content) > webFileLimit)
    fail(413, "Web source HTML is too large");
  return {
    ...extractWebText(content, sourceUrl),
    html: content,
    url: sourceUrl,
    truncated: false,
    retrievedAt: new Date().toISOString(),
  };
}

async function fetchExternalWebPage(
  value: string,
  signal: AbortSignal | undefined,
  config: WebFetchConfig,
  fetcher: typeof fetch = fetch,
  firecrawlFactory: FirecrawlFactory = (options) => new Firecrawl(options),
  format: "markdown" | "html" = "markdown",
) {
  const sourceUrl = publicWebUrl(value).href;
  if (format === "html" && config.provider === "tavily")
    fail(
      422,
      "Tavily cannot read exact web source sections; configure Firecrawl or Jina, or select a whole-page URL",
    );
  const abort = AbortSignal.any([
    AbortSignal.timeout(60000),
    ...(signal ? [signal] : []),
  ]);
  abort.throwIfAborted();
  let endpoint = "";
  let init: RequestInit;
  if (config.provider === "jina") {
    endpoint = `${(config.baseUrl || "https://r.jina.ai").replace(/\/+$/, "")}/${sourceUrl}`;
    init = {
      method: "GET",
      headers: {
        Accept: format === "html" ? "text/plain" : "text/markdown",
        ...(format === "html" ? { "X-Respond-With": "html" } : {}),
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        "X-Engine": "browser",
        "X-Timeout": "60",
      },
    };
  } else if (config.provider === "firecrawl") {
    let cancelWait: (() => void) | undefined;
    try {
      const result = await Promise.race([
        firecrawlFactory({
          apiKey: config.apiKey?.trim() || "",
          apiUrl: firecrawlApiUrl(config.baseUrl),
          timeoutMs: 60000,
          maxRetries: 2,
        }).scrape(sourceUrl, {
          formats: format === "html" ? ["rawHtml"] : ["markdown"],
          ...(format === "html" ? { onlyMainContent: false } : {}),
          timeout: 60000,
        }),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(abort.reason);
          cancelWait = () => abort.removeEventListener("abort", onAbort);
          abort.addEventListener("abort", onAbort, { once: true });
          if (abort.aborted) onAbort();
        }),
      ]);
      abort.throwIfAborted();
      return externalPage(
        String(
          format === "html" ? (result.rawHtml ?? "") : (result.markdown ?? ""),
        ),
        sourceUrl,
        result.metadata?.title,
        format,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError) throw error;
      fail(502, "Firecrawl 网页读取失败，请检查服务地址、密钥和服务状态");
    } finally {
      cancelWait?.();
    }
  } else {
    endpoint = externalEndpoint(
      config.baseUrl,
      "https://api.tavily.com",
      "/extract",
    );
    init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ urls: [sourceUrl], extract_depth: "advanced" }),
    };
  }
  try {
    const response = await fetcher(endpoint, {
      ...init,
      redirect: "error",
      signal: abort,
    });
    const reader = response.body?.getReader();
    if (!reader) fail(502, "网页读取服务返回空响应");
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        fail(502, "网页读取服务返回内容过大");
      }
      parts.push(item.value);
    }
    const raw = Buffer.concat(parts).toString();
    if (!response.ok) {
      fail(
        response.status === 429 ? 429 : 502,
        [401, 403].includes(response.status)
          ? "网页读取服务认证失败，请管理员检查配置"
          : `网页读取服务暂不可用（HTTP ${response.status}）`,
      );
    }
    if (config.provider === "jina")
      return externalPage(raw, sourceUrl, undefined, format);
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      fail(502, "网页读取服务返回了无效结果");
    }
    const result = body.results?.[0];
    return markdownPage(
      String(result?.raw_content ?? result?.rawContent ?? ""),
      sourceUrl,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AppError) throw error;
    fail(502, "网页读取服务连接失败或超时，请检查配置后重试");
  }
}

/** Keep anchor IDs for exact source selection instead of guessing from Markdown. */
export async function fetchWebSourceHTML(
  value: string,
  signal?: AbortSignal,
  dependencies: Parameters<typeof fetchWebPage>[2] = {},
  config?: WebFetchConfig,
) {
  if (config?.provider && config.provider !== "builtin") {
    const page = await fetchExternalWebPage(
      value,
      signal,
      config,
      dependencies.fetcher,
      dependencies.firecrawlFactory,
      "html",
    );
    if (!("html" in page) || typeof page.html !== "string")
      fail(502, "Web reader did not return HTML");
    return { url: page.url, html: page.html };
  }
  const file = await fetchWebFile(value, signal, dependencies);
  if (!/html/i.test(file.mime))
    fail(400, "A section URL requires an HTML page");
  return { url: file.url, html: file.body.toString("utf8") };
}

export async function fetchWebPage(
  value: string,
  signal?: AbortSignal,
  dependencies: {
    resolve?: (host: string) => Promise<Address[]>;
    request?: PageTransport;
    fetcher?: typeof fetch;
    firecrawlFactory?: FirecrawlFactory;
  } = {},
  config?: WebFetchConfig,
) {
  if (config?.provider && config.provider !== "builtin")
    return fetchExternalWebPage(
      value,
      signal,
      config,
      dependencies.fetcher,
      dependencies.firecrawlFactory,
    );
  return fetchBuiltinWebPage(value, signal, dependencies);
}
