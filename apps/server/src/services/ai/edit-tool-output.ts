import { isValidationError } from "@mastra/core/tools";

/** Explain the current SDK's array error without its misleading string-length hint. */
export function editToolModelOutput(output: any) {
  if (isValidationError(output)) {
    const fields = output.validationErrors as {
      fields?: Record<string, { errors?: string[] }>;
    };
    if (
      fields.fields?.operations?.errors?.some((error) =>
        error.includes("expected array"),
      )
    )
      return {
        type: "json" as const,
        value: {
          error: true,
          code: "edit_operations_array_required",
          message:
            'operations 必须直接传对象数组，例如 [{"type":"append","text":"正文"}]，不能传带引号的 JSON 字符串。',
          instruction:
            "80 限制的是操作数量，不是字符数。请重建合法对象数组，保留已读取的 resourceId、seq、epochId；缩短正文不能修复数组类型错误。尚未保存本批修改。",
        },
      };
  }
  return { type: "json" as const, value: output };
}
