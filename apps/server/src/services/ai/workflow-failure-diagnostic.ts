// These are the transport codes recognized by the installed AI SDK. Keep this
// finite: arbitrary provider codes or prose must never enter local diagnostics.
const transportCodes = [
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
] as const;

type TransportCode = (typeof transportCodes)[number];
const transportCodeSet: ReadonlySet<string> = new Set(transportCodes);

function ownData(error: Error, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function transportFacts(failure: unknown): {
  errorStatus?: number;
  statusCode?: number;
  isRetryable?: boolean;
  transportCode?: TransportCode;
} {
  if (!isError(failure)) return {};
  const facts: ReturnType<typeof transportFacts> = {};
  // Mastra reifies tool errors as a plain Error while preserving their own
  // numeric host status. This is diagnostic evidence only, never transport
  // classification or a reason to replay a tool.
  const errorStatus = ownData(failure, "status");
  if (
    typeof errorStatus === "number" &&
    Number.isInteger(errorStatus) &&
    errorStatus >= 100 &&
    errorStatus <= 599
  )
    facts.errorStatus = errorStatus;
  const statusCode = ownData(failure, "statusCode");
  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
  )
    facts.statusCode = statusCode;
  const isRetryable = ownData(failure, "isRetryable");
  if (typeof isRetryable === "boolean") facts.isRetryable = isRetryable;

  // A retryable HTTP status alone is not network evidence. Only inspect Error
  // instances, the root and at most three own-data cause hops, without getters.
  const seen = new Set<Error>();
  let current: unknown = failure;
  for (let depth = 0; depth <= 3 && isError(current); depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = ownData(current, "code");
    if (typeof code === "string" && transportCodeSet.has(code)) {
      facts.transportCode = code as TransportCode;
      break;
    }
    if (depth < 3) current = ownData(current, "cause");
  }
  return facts;
}

/** Public job errors hide provider failures; local diagnostics keep safe facts and code locations only. */
export function workflowFailureDiagnostic(
  jobId: string,
  status: string,
  failure: unknown,
) {
  let errorType: string = typeof failure;
  let stackFrames: string[] = [];
  if (failure instanceof Error) {
    errorType = "Error";
    // Do not read an overridden name/message/cause or invoke custom accessors.
    const prototype = Object.getPrototypeOf(failure);
    const constructor = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor",
    )?.value;
    const name =
      typeof constructor === "function"
        ? Object.getOwnPropertyDescriptor(constructor, "name")?.value
        : undefined;
    if (
      typeof name === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
    )
      errorType = name;
    const stackProperty = Object.getOwnPropertyDescriptor(failure, "stack");
    let stack = stackProperty?.value;
    // V8 exposes even an assigned Error.stack via a native accessor on some
    // runtimes. Permit that builtin, but do not execute an application getter.
    if (
      stackProperty?.get &&
      /\[native code\]/.test(
        Function.prototype.toString.call(stackProperty.get),
      )
    ) {
      try {
        stack = stackProperty.get.call(failure);
      } catch {
        stack = undefined;
      }
    }
    if (typeof stack === "string") {
      stackFrames = stack
        .slice(0, 32768)
        .split("\n")
        .flatMap((line) => {
          if (!/^\s*at\s/.test(line)) return [];
          const location =
            /(?:\(|\s)((?:file:\/\/\/|\/)[^()\s]+):(\d+):(\d+)\)?$/.exec(
              line.trim(),
            );
          if (!location) return [];
          const path = location[1]!.replace(/^file:\/\//, "");
          // Only host/package code paths, never remote URLs, query data or prose.
          if (/[?#%\\]/.test(path) || path.includes("://")) return [];
          const host = path.indexOf("/apps/server/");
          const packages = path.indexOf("/node_modules/");
          const start = host >= 0 ? host : packages;
          if (start < 0) return [];
          const local = path.slice(start + 1);
          if (
            !/^(?:apps\/server|node_modules)\/[A-Za-z0-9@_+./-]+\.(?:[cm]?[jt]sx?)$/.test(
              local,
            ) ||
            local.split("/").some((segment) => segment === "..")
          )
            return [];
          return [`${local}:${location[2]}:${location[3]}`];
        })
        .slice(0, 12);
    }
  }
  return { jobId, status, errorType, stackFrames, ...transportFacts(failure) };
}
