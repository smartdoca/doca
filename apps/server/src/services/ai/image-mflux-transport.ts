import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { fail } from "@core/shared/errors.js";

/** One native JSON POST, bounded by the caller's abort signal. This avoids
 * fetch's independent five-minute header timeout on long local inference. */
export const mfluxFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["http:", "https:"].includes(url.protocol) || init?.method !== "POST" || typeof init.body !== "string" || init.redirect !== "error")
    fail(400, "本地图片请求无效", { code: "image_mflux_request_invalid" });
  const body = init.body;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  headers["content-length"] = String(Buffer.byteLength(body));
  init.signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    let incoming: IncomingMessage | undefined;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: "POST", headers }, (response) => {
      incoming = response;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          response.on("end", () => { cleanup(); controller.close(); });
          response.on("error", (error) => { cleanup(); controller.error(error); });
        },
        cancel() { cleanup(); response.destroy(); request.destroy(); },
      });
      resolve(new Response(stream, { status: response.statusCode ?? 502, headers: responseHeaders }));
    });
    const abort = () => {
      const reason = init.signal?.reason ?? new DOMException("Aborted", "AbortError");
      const error = reason instanceof Error ? reason : new Error(String(reason));
      request.destroy(error);
      incoming?.destroy(error);
      reject(reason);
    };
    const cleanup = () => init.signal?.removeEventListener("abort", abort);
    request.on("error", (error) => { cleanup(); reject(error); });
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) { abort(); return; }
    request.end(body);
  });
};
