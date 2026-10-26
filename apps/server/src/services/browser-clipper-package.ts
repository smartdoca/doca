import { readdir, readFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";

export async function browserExtensionRelease() {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../browser-extension/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const version: string = manifest.version;
  if (!/^\d+(?:\.\d+){0,3}$/.test(version))
    throw Error("clipper_invalid_package_version");
  return { version, filename: `doca-browser-assistant-${version}.zip` };
}

const files = [
  "manifest.json",
  "background.js",
  "image-processing.js",
  "svg-image.js",
  "content.js",
  "select.js",
  "login-bridge.js",
  "capture.js",
  "ui.html",
  "ui.js",
  "ui.css",
  "messages.js",
  "icon.svg",
  "icon.png",
] as const;

/** Immutable, complete code template. The configured site address is added to this response only. */
export async function browserExtensionPackage() {
  const entries: (readonly [string, Uint8Array])[] = await Promise.all(
    files.map(
      async (name) =>
        [
          name,
          new Uint8Array(
            await readFile(
              new URL(`../../../browser-extension/${name}`, import.meta.url),
            ),
          ),
        ] as const,
    ),
  );
  const generated = new URL(
    "../../../browser-extension/generated/",
    import.meta.url,
  );
  async function assets(
    directory: URL,
    prefix = "generated/",
  ): Promise<(readonly [string, Uint8Array])[]> {
    const entries = [];
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || file.isSymbolicLink())
        throw Error("clipper_invalid_package_asset");
      const target = new URL(
        file.name + (file.isDirectory() ? "/" : ""),
        directory,
      );
      if (file.isDirectory())
        entries.push(...(await assets(target, prefix + file.name + "/")));
      else if (file.isFile())
        entries.push([
          prefix + file.name,
          new Uint8Array(await readFile(target)),
        ] as const);
      else throw Error("clipper_invalid_package_asset");
    }
    return entries;
  }
  const built = await assets(generated);
  for (const required of ["generated/assistant.js", "generated/assistant.css"])
    if (!built.some(([name]) => name === required))
      throw Error("clipper_package_build_missing");
  entries.push(...built);
  return (config: { origin: string } & Record<string, unknown>) => {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        entries.find(([name]) => name === "manifest.json")![1],
      ),
    );
    // The page toolbar and image transfers require HTTP(S) site access.
    // Authentication and destinations remain restricted to the configured Doca origin.
    manifest.host_permissions = ["http://*/*", "https://*/*"];
    return Buffer.from(
      zipSync(
        {
          ...Object.fromEntries(
            entries.filter(([name]) => name !== "manifest.json"),
          ),
          "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
          "connection.json": strToU8(JSON.stringify(config)),
          "INSTALL.txt": strToU8(
            "Doca 浏览器助手\n解压后打开 chrome://extensions 或 edge://extensions，开启开发者模式，加载已解压的扩展程序。\n下载包仅包含Doca站点地址。使用时跟随当前浏览器的Doca登录状态；未登录时打开Doca登录页。\n\n升级或回退前：停止队列发送，关闭所有旧版Doca网页和浏览器助手，不要同时运行新旧发送器。保留原localStorage、IndexedDB及所有历史记录。旧待发送消息需逐条明确继续或撤回，不会自动转换或发送。\n回退须保持新旧队列发送停用，不把IndexedDB导回localStorage，也不自动启用旧发送器；旧版没有安全停用发送功能时，不能恢复旧队列发送。\n\nBefore upgrading or rolling back, stop queue sending and close all older Doca pages and extensions. Do not run old and new senders together. Preserve both browser stores and all history. Previous pending messages require an explicit Continue or Withdraw. Rollback must keep queue sending disabled; do not export IndexedDB to localStorage or re-enable an older sender without a safe sender-disable facility.\n",
          ),
        },
        { level: 6 },
      ),
    );
  };
}
