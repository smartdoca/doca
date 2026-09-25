import type { JsonObject } from "./json.js";

export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export class ProtocolInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolInvariantError";
    this.code = code;
  }
}

export function errorDetails(error: unknown): ProtocolError {
  if (error instanceof ProtocolInvariantError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      retryable: false,
    });
  }
  if (error instanceof Error) {
    return Object.freeze({
      code: error.name === "AbortError" ? "cancelled" : "execution_error",
      message: error.message || error.name,
      retryable: false,
    });
  }
  return Object.freeze({
    code: "execution_error",
    message: typeof error === "string" ? error : "Unknown execution error",
    retryable: false,
  });
}
