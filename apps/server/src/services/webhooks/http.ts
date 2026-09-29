import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fail } from "@core/shared/errors.js";
import { webhookEndpointUrl } from "@core/modules/automation/webhooks.js";
import ipaddr from "ipaddr.js";

export type WebhookAddress = { address: string; family: number };
export type WebhookResolve = (host: string) => Promise<WebhookAddress[]>;
export type WebhookPost = (input: {
  url: string;
  body: string;
  headers: Record<string, string>;
}) => Promise<{ status: number }>;

/** Resolve the callback. Private and loopback addresses are allowed for programs on this host or network. */
export async function resolveWebhookAddress(
  value: string,
  resolve?: WebhookResolve,
) {
  const url = webhookEndpointUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(host)
    ? [
        {
          address: host,
          family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6,
        },
      ]
    : await (resolve ?? ((name: string) => lookup(name, { all: true })))(host);
  if (!addresses.length) fail(400, "回调地址无法解析");
  return { url, address: addresses[0]! };
}

export async function postWebhook(
  input: { url: string; body: string; headers: Record<string, string> },
  resolve?: WebhookResolve,
) {
  const { url, address } = await resolveWebhookAddress(input.url, resolve);
  return await new Promise<{ status: number }>((resolvePromise, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        signal: AbortSignal.timeout(8000),
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [
                { address: address.address, family: address.family },
              ])
            : callback(null, address.address, address.family),
        headers: {
          ...input.headers,
          "content-length": String(Buffer.byteLength(input.body)),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(input.body);
  });
}
