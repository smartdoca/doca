import { expect, it } from "vitest";
import { renderProcess } from "@server/services/render-process.js";

it("hard-stops an unresponsive renderer on timeout and cancellation", async () => {
  await expect(
    renderProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], "", {
      timeout: 80,
    }),
  ).rejects.toThrow("render_timeout");
  const controller = new AbortController();
  const job = renderProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    "",
    { timeout: 5000, signal: controller.signal },
  );
  controller.abort(new Error("isolated render cancellation"));
  await expect(job).rejects.toThrow("isolated render cancellation");
});

it("rejects an oversized renderer response and surfaces a missing executable", async () => {
  await expect(
    renderProcess(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(2048))"],
      "",
      { timeout: 5000, maxBytes: 1024 },
    ),
  ).rejects.toThrow("render_output_too_large");
  await expect(
    renderProcess("/doca-isolated-missing-renderer", [], "", { timeout: 5000 }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
