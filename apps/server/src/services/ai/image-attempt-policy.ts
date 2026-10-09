export const IMAGE_PAGE_ATTEMPT_LIMIT_ENV =
  "DOCA_AI_IMAGE_MAX_ATTEMPTS_PER_PAGE";

export function parseImagePageAttemptLimit(value: string | undefined): number {
  if (value === undefined) return 5;
  const limit = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(
      `${IMAGE_PAGE_ATTEMPT_LIMIT_ENV} must be a positive safe decimal integer`,
    );
  return limit;
}

let processLimit: number | undefined;
/** Initialize after dotenv has loaded, then keep one policy until process restart. */
export function imagePageAttemptLimit(): number {
  return (processLimit ??= parseImagePageAttemptLimit(
    process.env[IMAGE_PAGE_ATTEMPT_LIMIT_ENV],
  ));
}
