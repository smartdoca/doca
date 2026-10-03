import {
  YjsDocument as BaseRuntime,
  type YjsInlineCodec,
} from "@smartdoca/slate/yjs";
import type { Doc } from "yjs";
import { validatePluginElementPayload } from "@smartdoca/plugin-contracts";
const codec = (type: `custom:${string}`, key: string): YjsInlineCodec => ({
  type,
  schemaVersion: 1,
  encode: (element) => {
    const data = element as unknown as Record<string, unknown>;
    const id = data[key],
      label = data.label;
    if (
      typeof id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      typeof label !== "string" ||
      label.length > 500
    )
      throw Error("业务元素数据无效");
    return { [key]: id, label };
  },
  decode: (data, { id }) => {
    if (
      typeof data[key] !== "string" ||
      !/^[a-f0-9-]{36}$/.test(data[key] as string) ||
      typeof data.label !== "string" ||
      data.label.length > 500 ||
      Object.keys(data).some((k) => ![key, "label"].includes(k))
    )
      throw Error("业务元素数据无效");
    return {
      type,
      id,
      [key]: data[key],
      label: data.label,
      children: [{ text: "" }],
    };
  },
});
export const referenceCodec = codec("custom:document-reference", "documentId");
export const mentionCodec = codec("custom:user-mention", "userId");
/** One permanent host codec: missing business renderers do not affect recovery. */
export const pluginElementCodec: YjsInlineCodec = {
  type: "custom:plugin-element",
  schemaVersion: 1,
  encode(element) {
    const payload = (element as unknown as Record<string, unknown>).payload;
    validatePluginElementPayload(payload);
    return { payload: structuredClone(payload) };
  },
  decode(data, { id }) {
    if (Object.keys(data).some(key => key !== "payload")) throw Error("Invalid plugin element codec data");
    validatePluginElementPayload(data.payload);
    return { type: "custom:plugin-element", id, payload: structuredClone(data.payload), label: typeof data.payload.text === "string" ? data.payload.text : "", children: [{ text: "" }] };
  },
};
export const inlineCodecs = [referenceCodec, mentionCodec, pluginElementCodec];
export class DocaYjsDocument extends BaseRuntime {
  constructor(doc: Doc) {
    super(doc, { inlineCodecs });
  }
}
