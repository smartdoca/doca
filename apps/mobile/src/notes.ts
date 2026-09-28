export type NoteNode = {
  id: string;
  type: string;
  path?: string;
  code?: string;
  children?: Array<{ text?: string; children?: Array<{ text?: string }> }>;
};

export type QuickNote = {
  id: string;
  content: NoteNode[];
  assets: { id: string }[];
  version: number;
  updated_at: string;
};

export function notePreview(note: QuickNote) {
  return noteText(note.content).replace(/\s+/g, " ").trim();
}

export function noteText(content: NoteNode[]) {
  return content
    .map((node) => {
      if (node.type === "image" || node.type === "attachment" || node.type === "divider") return "";
      if (node.type === "code-block" && node.code) return node.code;
      return (node.children ?? [])
        .map((child) => child.text ?? child.children?.map((part) => part.text ?? "").join("") ?? "")
        .join("");
    })
    .filter((line, index, all) => line || all[index - 1])
    .join("\n")
    .trim();
}

export function noteDraft(text: string, previous: NoteNode[] = []) {
  const lines = text.replace(/\n$/, "").split("\n");
  const paragraphs = (lines.length ? lines : [""]).map((line) => ({
    id: cryptoId(),
    type: "paragraph",
    children: [{ text: line }],
  }));
  const media = previous.filter((node) => node.type === "image" || node.type === "attachment");
  const content = text.trim() ? [...paragraphs, ...media] : media.length ? media : paragraphs;
  const assetIds = media.flatMap((node) => (node.path ? [node.path] : []));
  return { content, assetIds };
}

function cryptoId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0;
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}
