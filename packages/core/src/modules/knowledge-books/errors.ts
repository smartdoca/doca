import { fail } from "../../shared/errors.js";
const codes: Record<number, string> = {
  400: "book_invalid",
  403: "book_forbidden",
  404: "book_not_found",
  409: "book_conflict",
  413: "book_size_limit",
  422: "book_acceptance",
  502: "book_model_output",
  503: "book_model_unavailable",
};
/** New book errors carry presentation codes; model-facing messages stay precise. */
export function bookFail(status: number, message: string): never {
  return fail(status, message, { code: codes[status] ?? "book_failed" });
}
