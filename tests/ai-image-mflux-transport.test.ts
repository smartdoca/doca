import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { mfluxFetch } from "../apps/server/src/services/ai/image-mflux-transport.js";

it("posts UTF-8 JSON once and reads delayed headers and a chunked response", async () => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    received.push(Buffer.concat(parts).toString());
    await new Promise((resolve) => setTimeout(resolve, 30));
    response.writeHead(200, { "Content-Type": "application/json", "x-request-id": "one-local-operation" });
    response.write('{"version":1,');
    await new Promise((resolve) => setTimeout(resolve, 20));
    response.end('"status":"completed"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Expected local server");
    const body = JSON.stringify({ prompt: "给人物自然融合", version: 1 });
    const response = await mfluxFetch(`http://127.0.0.1:${address.port}/v1/images`, { method: "POST", redirect: "error", body, headers: { Authorization: "Bearer mock-only" }, signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("one-local-operation");
    expect(await response.json()).toEqual({ version: 1, status: "completed" });
    expect(received).toEqual([body]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("aborts a pending native request without a second POST or redirect follow", async () => {
  let requests = 0;
  const server = createServer((_request, _response) => { requests++; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Expected local server");
    await expect(mfluxFetch(`http://127.0.0.1:${address.port}/v1/images`, { method: "POST", redirect: "error", body: "{}", signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requests).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("keeps a string cancellation reason and rejects without a duplicate request", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Expected local server");
    const controller = new AbortController();
    const promise = mfluxFetch(`http://127.0.0.1:${address.port}/v1/images`, { method: "POST", redirect: "error", body: "{}", signal: controller.signal });
    setTimeout(() => controller.abort("user cancellation"), 30);
    await expect(promise).rejects.toBe("user cancellation");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("returns a redirect rejection response without contacting the target", async () => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.url!);
    response.writeHead(307, { Location: "/second-post" });
    response.end("redirect");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Expected local server");
    const response = await mfluxFetch(`http://127.0.0.1:${address.port}/v1/images`, { method: "POST", redirect: "error", body: "{}" });
    expect(response.status).toBe(307);
    expect(await response.text()).toBe("redirect");
    expect(received).toEqual(["/v1/images"]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
