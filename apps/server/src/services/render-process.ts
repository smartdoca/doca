import { spawn } from "node:child_process";

/** A disposable renderer: bounded input/output, hard deadline, no shell. */
export function renderProcess(
  command: string,
  args: string[],
  input: string,
  options: {
    signal?: AbortSignal;
    timeout: number;
    maxBytes?: number;
  },
): Promise<Buffer> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let length = 0,
      errors = "",
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () =>
      stop(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("render_cancelled"),
      );
    const timer = setTimeout(
      () => stop(new Error("render_timeout")),
      options.timeout,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > (options.maxBytes ?? 64 * 1024 * 1024))
        stop(new Error("render_output_too_large"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-8192);
    });
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`render_failed: ${errors.trim()}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
