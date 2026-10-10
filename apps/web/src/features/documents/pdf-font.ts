const cjkFontUrl = new URL(
  "./assets/NotoSansSC-Regular.woff2",
  import.meta.url,
);
const cjkCharacters = /[\u2e80-\u2fff\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
let fontBytesPromise: Promise<Uint8Array> | undefined;

/** Loads the bundled OFL-licensed CJK font only when the exported text needs it. */
export function loadPdfFontBytes(markdown: string): Promise<Uint8Array | undefined> {
  if (!cjkCharacters.test(markdown)) return Promise.resolve(undefined);
  fontBytesPromise ??= fetch(cjkFontUrl)
    .then(async (response) => {
      if (!response.ok) throw Error("中文字体加载失败，PDF 导出已取消");
      return new Uint8Array(await response.arrayBuffer());
    })
    .catch(() => {
      fontBytesPromise = undefined;
      throw Error("中文字体加载失败，PDF 导出已取消");
    });
  return fontBytesPromise;
}
