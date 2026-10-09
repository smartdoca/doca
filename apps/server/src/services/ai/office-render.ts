import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const execute = promisify(execFile);
/** A fresh LibreOffice profile per conversion; never use a user's editor profile. */
export async function officePdf(filename: string, bytes: Buffer) {
  const extension = filename.match(/\.(docx|pptx|xlsx)$/i)?.[1]?.toLowerCase();
  if (!extension) throw new Error("office_format_unsupported");
  const root = await mkdtemp(join(tmpdir(), "doca-office-render-"));
  try {
    const source = join(root, `source.${extension}`);
    await writeFile(source, bytes, { mode: 0o600 });
    await execute(
      process.env.DOCA_OFFICE_RENDERER || "soffice",
      [
        `-env:UserInstallation=${pathToFileURL(join(root, "profile")).href}`,
        "--headless",
        "--nologo",
        "--nodefault",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        root,
        source,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    const output = await readFile(join(root, "source.pdf"));
    if (output.subarray(0, 5).toString() !== "%PDF-")
      throw new Error("office_render_invalid");
    return output;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
