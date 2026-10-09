/** One text-copy path for native Clipboard and approved HTTP browser support. */
export async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  document.body.append(field);
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    if (
      typeof document.execCommand !== "function" ||
      !document.execCommand("copy")
    )
      throw new Error("Copy failed");
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
