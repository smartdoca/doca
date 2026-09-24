import { useMemo, useRef, useState } from "react";
import { Editor, Element, Node, Transforms } from "slate";
import {
  RichTextEditor,
  type RichTextEditorHandle,
  type ResourceConfig,
  type UploadContext,
  type UploadResult,
  type EditorPlugin,
  type ResourceUploadState,
} from "slatetsx-kit-editor";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  ListTodo,
  ImagePlus,
  Paperclip,
  FolderOpen,
  Undo2,
  Redo2,
  Type,
} from "lucide-react";
import { assetUrl, fileUrl, type FileItem } from "@web/shared/api.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";
import {
  displayNoteContent,
  noteContentSchema,
  type NoteContent,
} from "@core/shared/quick-notes.js";
import "slatetsx-kit-editor/style.css";

const resourcesForReading: ResourceConfig = {
  resolveUrl: (path) => (/^[a-f0-9-]{36}$/.test(path) ? assetUrl(path) : ""),
  resolveDownloadUrl: (path) =>
    /^[a-f0-9-]{36}$/.test(path) ? assetUrl(path) + "?download=1" : "",
};
const supportedBlocks = new Set([
  "paragraph",
  "image",
  "attachment",
  "code-block",
  "divider",
]);
// Preserve SDK editing/clipboard behavior. Complex pasted structures become text;
// this host schema restriction is separate from the SDK's insertion-menu settings.
const notePlugins: EditorPlugin[] = [
  {
    key: "quick-note-content",
    withEditor(editor) {
      const normalize = editor.normalizeNode;
      editor.normalizeNode = (entry) => {
        const [node, path] = entry;
        if (
          path.length === 1 &&
          Element.isElement(node) &&
          !supportedBlocks.has(node.type)
        ) {
          const text = Node.string(node);
          Editor.withoutNormalizing(editor, () => {
            Transforms.removeNodes(editor, { at: path });
            Transforms.insertNodes(
              editor,
              { id: node.id, type: "paragraph", children: [{ text }] },
              { at: path },
            );
          });
          return;
        }
        if (
          Element.isElement(node) &&
          node.type === "link" &&
          !/^(https?:\/\/|mailto:)/i.test(node.url)
        ) {
          Transforms.unwrapNodes(editor, { at: path });
          return;
        }
        normalize(entry);
      };
      return editor;
    },
  },
];

export function QuickNoteEditor({
  initial,
  onChange,
  upload,
  onUploading,
  submit,
  disabled = false,
  autoFocus = false,
}: {
  initial: NoteContent;
  onChange: (content: NoteContent) => void;
  upload: (file: File, context: UploadContext) => Promise<UploadResult>;
  onUploading: (pending: boolean) => void;
  submit: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const handle = useRef<RichTextEditorHandle | null>(null);
  const callbacks = useRef({ onChange, upload, onUploading });
  callbacks.current = { onChange, upload, onUploading };
  const [formatsOpen, setFormatsOpen] = useState(false);
  const [folderPicker, setFolderPicker] = useState(false);
  const [sourceKind, setSourceKind] = useState<"image" | "attachment" | null>(null);
  const sourceKindRef = useRef<"image" | "attachment">("attachment");
  const localFile = useRef<HTMLInputElement>(null);
  const [, refresh] = useState(0);
  const [error, setError] = useState("");
  const lastValue = useRef(initial);
  const states = useRef<readonly ResourceUploadState[]>([]);
  const invalid = useRef(false);
  const reportPending = () => {
    const value = handle.current?.getValue() ?? initial;
    const ids = new Set(value.flatMap((n) => ("id" in n ? [n.id] : [])));
    callbacks.current.onUploading(
      invalid.current ||
        states.current.some((s) => ids.has(s.blockId)) ||
        value.some(
          (n) =>
            "type" in n &&
            (n.type === "image" || n.type === "attachment") &&
            !n.path,
        ),
    );
  };
  const resources = useMemo<ResourceConfig>(
    () => ({
      ...resourcesForReading,
      uploadImage: (file, context) => callbacks.current.upload(file, context),
      uploadAttachment: (file, context) =>
        callbacks.current.upload(file, context),
    }),
    [],
  );
  const command = (action: (h: RichTextEditorHandle) => void) => {
    const h = handle.current;
    if (!h) return;
    if (!h.editor.selection)
      Transforms.select(h.editor, Editor.end(h.editor, []));
    action(h);
    h.commands.focus();
  };
  return (
    <div
      className="quick-note-editor"
      onKeyDownCapture={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter"
        ) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      <div
        className="note-toolbar note-toolbar-primary"
        role="toolbar"
        aria-label="快捷记录"
      >
        <button type="button" className="note-upload" title="添加图片" aria-label="添加图片" disabled={disabled} onClick={() => { sourceKindRef.current = "image"; setSourceKind("image"); }}><ImagePlus size={18} /></button>
        <button type="button" className="note-upload" title="添加附件" aria-label="添加附件" disabled={disabled} onClick={() => { sourceKindRef.current = "attachment"; setSourceKind("attachment"); }}><Paperclip size={18} /></button>
        <input ref={localFile} hidden type="file" accept={sourceKind === "image" ? "image/*,.svg,image/svg+xml" : undefined} multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; command((h) => { for (const file of files) void (sourceKindRef.current === "image" ? h.commands.uploadImage(file) : h.commands.uploadAttachment(file)).catch((e) => setError(String(e))); }); }} />
        <button
          type="button"
          className="note-todo-control"
          title="待办清单"
          aria-label="待办清单"
          aria-pressed={handle.current?.query.isBlockActive("todo") ?? false}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command((h) => h.commands.toggleBlock("todo"))}
        >
          <ListTodo size={18} />
        </button>
        <button
          type="button"
          title="文字格式"
          aria-label="文字格式"
          aria-expanded={formatsOpen}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFormatsOpen((v) => !v)}
        >
          <Type size={17} />
        </button>
      </div>
      {formatsOpen && (
        <div
          className="note-toolbar note-toolbar-formats"
          role="toolbar"
          aria-label="随手记格式"
        >
          {(
            [
              ["加粗", Bold, "bold"],
              ["斜体", Italic, "italic"],
              ["删除线", Strikethrough, "strikethrough"],
            ] as const
          ).map(([label, Icon, mark]) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={handle.current?.query.isMarkActive(mark) ?? false}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command((h) => h.commands.toggleMark(mark))}
            >
              <Icon size={16} />
            </button>
          ))}
          {(
            [
              ["无序列表", List, "bulleted-list"],
              ["有序列表", ListOrdered, "numbered-list"],
            ] as const
          ).map(([label, Icon, block]) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command((h) => h.commands.toggleBlock(block))}
            >
              <Icon size={16} />
            </button>
          ))}
          <button
            type="button"
            aria-label="撤销"
            title="撤销"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => command((h) => h.commands.undo())}
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            aria-label="重做"
            title="重做"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => command((h) => h.commands.redo())}
          >
            <Redo2 size={15} />
          </button>
        </div>
      )}
      <RichTextEditor
        initialValue={initial}
        autoFocus={autoFocus}
        firstLineTitle={false}
        ariaLabel="随手记正文"
        placeholder="记你想记…"
        mode={disabled ? "readonly" : "edit"}
        plugins={notePlugins}
        resources={resources}
        largeDocumentThreshold={false}
        onReady={(h) => {
          handle.current = h;
        }}
        onUploadStateChange={(value) => {
          states.current = value;
          reportPending();
        }}
        onChange={(value) => {
          refresh((n) => n + 1);
          if (value === lastValue.current) return;
          const parsed = noteContentSchema.safeParse(value);
          if (!parsed.success) {
            invalid.current = true;
            reportPending();
            setError("部分内容暂不支持保存，请撤销刚才的操作或改为普通文字。");
            return;
          }
          invalid.current = false;
          reportPending();
          setError("");
          if (JSON.stringify(parsed.data) === JSON.stringify(lastValue.current))
            return;
          lastValue.current = value as NoteContent;
          callbacks.current.onChange(parsed.data);
        }}
      />
      {error && (
        <p className="note-error" role="alert">
          {error}
        </p>
      )}
      {folderPicker && <FolderFilePicker close={() => setFolderPicker(false)} select={async (item: FileItem) => { const response = await fetch(fileUrl(item.id)); if (!response.ok) throw new Error("文件读取失败"); const selected = new File([await response.blob()], item.name, { type: item.mime }); command((editor) => { void (item.mime.startsWith("image/") ? editor.commands.uploadImage(selected) : editor.commands.uploadAttachment(selected)).catch((error) => setError(String(error))); }); }} />}
      {sourceKind && <FileSourceDialog title={sourceKind === "image" ? "添加图片" : "添加附件"} close={() => setSourceKind(null)} chooseDoca={() => setFolderPicker(true)} chooseLocal={() => localFile.current?.click()} />}
    </div>
  );
}

export function QuickNoteBody({ content }: { content: NoteContent }) {
  const value = useMemo(() => displayNoteContent(content), [content]);
  if (!value.length) return null;
  return (
    <div className="note-body">
      <RichTextEditor
        key={JSON.stringify(value)}
        initialValue={value}
        mode="readonly"
        firstLineTitle={false}
        resources={resourcesForReading}
        largeDocumentThreshold={false}
      />
    </div>
  );
}
