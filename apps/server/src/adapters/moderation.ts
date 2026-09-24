import { createHash, createHmac } from "node:crypto";
import type { ModerationConfig } from "@core/modules/moderation/service.js";
export type Verdict = {
  suggestion: "Pass" | "Review" | "Block";
  label: string;
  requestId: string;
};
export type ModerationRuntime = { fetch?: typeof fetch };
/** Tencent Cloud TC3 signing. Fixed vendor endpoints keep credentials off arbitrary hosts. */
export function moderationHeaders(
  config: ModerationConfig,
  service: "tms" | "ims",
  action: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const host = `${service}.tencentcloudapi.com`,
    date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const hmac = (key: string | Buffer, text: string) =>
    createHmac("sha256", key).update(text).digest();
  const scope = `${date}/${service}/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json\nhost:${host}\n\ncontent-type;host\n${hash(body)}`;
  const secret = hmac(
    hmac(hmac(`TC3${config.secretKey}`, date), service),
    "tc3_request",
  );
  const signature = createHmac("sha256", secret)
    .update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": "2020-12-29",
    "X-TC-Region": config.region,
    "X-TC-Timestamp": String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
  };
}
export function createModerationProvider(runtime: ModerationRuntime = {}) {
  async function request(
    config: ModerationConfig,
    service: "tms" | "ims",
    input: Record<string, string>,
  ): Promise<Verdict> {
    const body = JSON.stringify(input);
    const res = await (runtime.fetch ?? fetch)(
      `https://${service}.tencentcloudapi.com`,
      {
        method: "POST",
        body,
        headers: moderationHeaders(
          config,
          service,
          service === "tms" ? "TextModeration" : "ImageModeration",
          body,
        ),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!res.ok) throw Error(`审核服务请求失败（${res.status}）`);
    const output = ((await res.json()) as any)?.Response;
    if (
      output?.Error ||
      !["Pass", "Review", "Block"].includes(output?.Suggestion)
    )
      throw Error("审核服务未返回有效结论，请检查配置或稍后重试");
    return {
      suggestion: output.Suggestion,
      label: String(output.Label ?? "").slice(0, 200),
      requestId: String(output.RequestId ?? "").slice(0, 200),
    };
  }
  return {
    async text(config: ModerationConfig, text: string, id: string) {
      const chars = Array.from(text),
        results: Verdict[] = [];
      // Preserve all Unicode characters; no silent truncation of long documents.
      for (let i = 0; i < chars.length; i += 9500) {
        results.push(
          await request(config, "tms", {
            Content: Buffer.from(chars.slice(i, i + 10000).join("")).toString(
              "base64",
            ),
            DataId: id,
            ...(config.textBizType ? { BizType: config.textBizType } : {}),
          }),
        );
      }
      return results;
    },
    async image(config: ModerationConfig, body: Buffer, id: string) {
      const content = body.toString("base64");
      if (content.length > 9 * 1024 * 1024)
        throw Error("图片超过云审核接口限制，请人工复核");
      return [
        await request(config, "ims", {
          FileContent: content,
          DataId: id,
          ...(config.imageBizType ? { BizType: config.imageBizType } : {}),
        }),
      ];
    },
  };
}
