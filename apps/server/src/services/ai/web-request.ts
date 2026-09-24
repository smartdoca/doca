import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fail, AppError } from "@core/shared/errors.js";
import {
  isPublicAddress,
  publicWebUrl,
} from "./web-fetch.js";
import ipaddr from "ipaddr.js";

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof httpMethods)[number];

const maxBody = 100_000;
const maxResponse = 80_000;
const maxBytes = 256 * 1024;
const headerAllow =
  /^(authorization|content-type|accept|accept-language|user-agent|cookie|api-key|x-[\w-]+)$/i;

export function sanitizeHttpHeaders(input: Record<string, string> | undefined) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!headerAllow.test(key) || typeof value !== "string") continue;
    const next = value.trim().slice(0, 4000);
    if (next) headers[key] = next;
  }
  return headers;
}

type Address = { address: string; family: number };

function dottedFromInteger(host: string) {
  if (!/^\d{1,10}$/.test(host)) return null;
  const value = Number(host);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

async function resolvePublic(host: string, signal: AbortSignal) {
  const literal = dottedFromInteger(host) ?? host;
  if (
    /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(
      host,
    )
  )
    fail(400, "链接指向本机或内网，无法请求");
  if (ipaddr.isValid(literal)) {
    const address = literal;
    if (!isPublicAddress(address)) fail(400, "链接指向本机或内网，无法请求");
    return {
      address,
      family: ipaddr.parse(literal).kind() === "ipv4" ? 4 : 6,
    } satisfies Address;
  }
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  ]);
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    fail(400, "链接指向本机或内网，无法请求");
  return addresses[0]!;
}

function sendPinned(
  url: URL,
  address: Address,
  init: {
    method: HttpMethod;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: init.method,
        agent: false,
        signal: init.signal,
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [
                { address: address.address, family: address.family },
              ])
            : callback(null, address.address, address.family),
        headers: {
          Accept: "application/json, text/plain, text/html;q=0.8, */*;q=0.5",
          "Accept-Encoding": "identity",
          "User-Agent": "Doca-HttpRequest/1.0",
          ...init.headers,
          ...(init.body
            ? { "Content-Length": String(Buffer.byteLength(init.body)) }
            : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const announced = Number(res.headers["content-length"]);
        if (Number.isFinite(announced) && announced > maxBytes) {
          resolve({ status: 413, headers: res.headers, body: Buffer.alloc(0) });
          res.destroy();
          return;
        }
        const parts: Buffer[] = [];
        let bytes = 0;
        res.on("data", (part: Buffer) => {
          bytes += part.length;
          if (bytes > maxBytes)
            res.destroy(new Error("response too large"));
          else parts.push(part);
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
    if (init.body) req.write(init.body);
    req.end();
  });
}

export async function requestPublicHttp(
  input: {
    url: string;
    method?: HttpMethod;
    headers?: Record<string, string>;
    body?: string;
  },
  signal?: AbortSignal,
) {
  const method = input.method ?? "GET";
  if (!httpMethods.includes(method)) fail(400, "不支持的 HTTP 方法");
  if (input.body && input.body.length > maxBody)
    fail(400, "请求正文不能超过 100KB");
  const headers = sanitizeHttpHeaders(input.headers);
  const abort = AbortSignal.any([
    AbortSignal.timeout(25000),
    ...(signal ? [signal] : []),
  ]);
  let url = publicWebUrl(input.url);
  try {
    for (let hop = 0; hop <= 4; hop++) {
      abort.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const address = await resolvePublic(host, abort);
      const res = await sendPinned(url, address, {
        method: hop && method !== "GET" ? "GET" : method,
        headers,
        body: hop ? undefined : input.body,
        signal: abort,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location;
        if (typeof location !== "string") fail(502, "跳转地址无效");
        url = publicWebUrl(new URL(location, url).href);
        if (method !== "GET" && hop === 0 && ![301, 302, 303].includes(res.status))
          continue;
        if (method !== "GET")
          return {
            url: url.href,
            status: res.status,
            contentType: String(res.headers["content-type"] ?? ""),
            text: "请求被重定向，未自动跟随非 GET 跳转。",
            truncated: false,
          };
        continue;
      }
      if (res.status === 413) fail(413, "响应超过 256KB 上限");
      const type = String(res.headers["content-type"] ?? "");
      let text = res.body.toString("utf8");
      const truncated = text.length > maxResponse;
      if (truncated) text = text.slice(0, maxResponse);
      return {
        url: url.href,
        status: res.status,
        contentType: type.slice(0, 200),
        text,
        truncated,
      };
    }
    fail(502, "跳转次数过多");
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AppError) throw error;
    fail(502, "网络请求失败、响应过大或超时");
  }
}
