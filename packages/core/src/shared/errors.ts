import { encodeSystemError, type SystemErrorReason } from "@doca/i18n";

// Metadata must stay out of SDK/tool error serialisation and model context.
const reasons = new WeakMap<Error, SystemErrorReason>();

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    reason?: SystemErrorReason,
  ) {
    super(message);
    if (reason) reasons.set(this, reason);
  }
}
export function fail(status: number, message: string, reason?: SystemErrorReason): never {
  throw new AppError(status, message, reason);
}

export function systemErrorReason(error: unknown): SystemErrorReason | undefined {
  return error instanceof Error ? reasons.get(error) : undefined;
}

export function systemErrorText(error: AppError): string {
  const reason = systemErrorReason(error);
  return reason ? encodeSystemError(reason) : error.message;
}
