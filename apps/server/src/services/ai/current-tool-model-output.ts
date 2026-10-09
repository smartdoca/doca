import { isValidationError } from "@mastra/core/tools";

const validationMessageLimit = 4000;
const instruction =
  "此错误结果不是成功回执，不能用缺失的回执 ID 读取预览，也不能据此执行保存或付费生成。保留已有成果，按校验错误修正后再调用；参数过大或被截断时使用宿主提供的引用 ID、几何修边工具或拆小操作，不重抄大段坐标。";

function ownObject(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.getOwnPropertyDescriptors(value);
}

/**
 * Handle the installed Mastra SDK's current ValidationError channel before a
 * successful tool result is mapped to media. This neither reads nor repairs
 * receipts. Unknown/missing result shapes remain subject to their strict path.
 */
export function currentToolModelOutputError(
  output: unknown,
): { type: "text"; value: string } | undefined {
  try {
    const fields = ownObject(output);
    if (
      !fields ||
      Object.keys(fields).sort().join(",") !==
        "error,message,validationErrors" ||
      fields.error?.value !== true ||
      typeof fields.message?.value !== "string" ||
      !fields.message.value.length ||
      !fields.validationErrors ||
      !("value" in fields.validationErrors)
    )
      return undefined;
    const validationErrors = fields.validationErrors.value;
    const validation = ownObject(validationErrors);
    if (
      !validation ||
      Object.keys(validation).sort().join(",") !== "errors,fields" ||
      !Array.isArray(validation.errors?.value) ||
      !validation.fields ||
      !("value" in validation.fields) ||
      !ownObject(validation.fields.value)
    )
      return undefined;
    const error = {
      error: true,
      message: fields.message.value,
      validationErrors,
    };
    if (!isValidationError(error)) return undefined;
    return {
      type: "text",
      value: JSON.stringify({
        error: true,
        message:
          error.message.length <= validationMessageLimit
            ? error.message
            : `${error.message.slice(0, validationMessageLimit)}\n[truncated]`,
        instruction,
      }),
    };
  } catch {
    // Untrusted proxies/accessors are not a recognized SDK validation result.
    return undefined;
  }
}
