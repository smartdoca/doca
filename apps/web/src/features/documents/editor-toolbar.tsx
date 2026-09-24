import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { RichTextEditorHandle, BlockType } from "slatetsx-kit-editor";
import { FONT_FAMILIES } from "slatetsx-kit-editor";
import { Editor, Range, Transforms, type Range as SlateRange } from "slate";
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Eraser,
  Table2,
  Columns3,
  Plus,
  MoreHorizontal,
  ChevronDown,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Baseline,
  Highlighter,
  Palette,
  ImagePlus,
  Paperclip,
  FolderOpen,
  Square,
  Minus,
  Quote,
  Sigma,
} from "lucide-react";
import { visibleToolbarCount } from "@web/shared/utils/toolbar-layout.js";
import { EmojiPicker } from "@web/shared/components/emoji-picker.js";
import { DocumentLinkControl } from "@web/features/documents/document-link-control.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";
import { fileUrl, type FileItem } from "@web/shared/api.js";

export function EditorToolbar({
  handle,
  disabled,
}: {
  handle: RichTextEditorHandle | null;
  disabled: boolean;
  selectionRevision?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const savedSelection = useRef<SlateRange | null>(null);
  const savedColorSelection = useRef<SlateRange | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [tableSize, setTableSize] = useState({ rows: 0, columns: 0 });
  const [fileKind, setFileKind] = useState<"media" | "attachment">("media");
  const [folderPicker, setFolderPicker] = useState(false);
  const [sourcePicker, setSourcePicker] = useState(false);
  const [width, setWidth] = useState(1000),
    [error, setError] = useState("");
  useEffect(() => {
    const o = new ResizeObserver(([e]) =>
      setWidth(e?.contentRect.width ?? 1000),
    );
    if (host.current) o.observe(host.current);
    return () => o.disconnect();
  }, []);
  const rememberSelection = () => {
    const selection = handle?.editor.selection;
    if (selection && Range.isExpanded(selection))
      savedSelection.current = structuredClone(selection);
  };
  const holdSelection = (event: { preventDefault(): void }) => {
    event.preventDefault();
    rememberSelection();
  };
  const run = (
    fn: (h: RichTextEditorHandle) => void,
    preserveSelection = false,
  ) => {
    if (!handle || disabled) return;
    const editor = handle.editor;
    try {
      // Restore the range captured on mousedown, before the command. A live
      // range tracked through the mark split, then selected again, is what
      // moves the highlight: the browser expands it when <u>/<s> leaves mount,
      // and slate-react adopts that wider DOM range. The editor command already
      // keeps the model selection on the same characters.
      if (preserveSelection && savedSelection.current) {
        const current = editor.selection;
        if (!current || !Range.equals(current, savedSelection.current))
          Transforms.select(editor, savedSelection.current);
      }
      fn(handle);
      if (
        preserveSelection &&
        editor.selection &&
        Range.isExpanded(editor.selection)
      )
        savedSelection.current = structuredClone(editor.selection);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const tools = [
    {
      name: "撤销",
      icon: Undo2,
      action: (h: RichTextEditorHandle) => h.commands.undo(),
    },
    {
      name: "重做",
      icon: Redo2,
      action: (h: RichTextEditorHandle) => h.commands.redo(),
    },
    ...(
      [
        ["加粗", Bold, "bold"],
        ["斜体", Italic, "italic"],
        ["下划线", Underline, "underline"],
        ["删除线", Strikethrough, "strikethrough"],
        ["行内代码", Code, "code"],
      ] as const
    ).map(([name, icon, mark]) => ({
      name,
      icon,
      active: !!handle?.query.isMarkActive(mark),
      preserveSelection: true,
      action: (h: RichTextEditorHandle) => h.commands.toggleMark(mark),
    })),
    {
      name: "清除格式",
      icon: Eraser,
      preserveSelection: true,
      action: (h: RichTextEditorHandle) => h.commands.clearFormatting(),
    },
    ...(
      [
        ["左对齐", AlignLeft, "left"],
        ["居中", AlignCenter, "center"],
        ["右对齐", AlignRight, "right"],
      ] as const
    ).map(([name, icon, align]) => ({
      name,
      icon,
      active:
        !!handle?.editor.selection &&
        [
          ...Editor.nodes(handle.editor, {
            match: (n) =>
              !Editor.isEditor(n) && "align" in n && n.align === align,
            mode: "lowest",
          }),
        ].length > 0,
      action: (h: RichTextEditorHandle) =>
        Transforms.setNodes(
          h.editor,
          { align },
          { match: (n) => Editor.isBlock(h.editor, n as any), mode: "lowest" },
        ),
    })),
  ];
  const button = (t: (typeof tools)[number], label = false) => (
    <button
      type="button"
      key={t.name}
      disabled={disabled}
      title={t.name}
      aria-label={t.name}
      aria-pressed={"active" in t ? t.active : undefined}
      onMouseDown={(e) =>
        "preserveSelection" in t && t.preserveSelection
          ? holdSelection(e)
          : e.preventDefault()
      }
      onClick={() =>
        run(t.action, "preserveSelection" in t && t.preserveSelection)
      }
    >
      <t.icon size={16} />
      {label && t.name}
    </button>
  );
  const marks = handle?.query.getSelection()?.marks;
  const sizeMenu = (
    <details className="menu">
      <summary aria-label="字号" onMouseDown={rememberSelection}>
        {marks?.fontSize ?? 16}
        <ChevronDown size={12} />
      </summary>
      <div className="toolbar-font-sizes">
        {[12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64].map((size) => (
          <button
            key={size}
            disabled={disabled}
            aria-pressed={marks?.fontSize === size}
            onMouseDown={holdSelection}
            onClick={() =>
              run((h) => h.commands.toggleMark("fontSize", size), true)
            }
          >
            {size}
          </button>
        ))}
      </div>
    </details>
  );
  const colorMenu = (background: boolean) => (
    <details className="menu">
      <summary
        className="toolbar-color-trigger"
        style={
          {
            "--mark-color": background
              ? marks?.backgroundColor || "#fff1b8"
              : marks?.color || "#1f2329",
          } as CSSProperties
        }
        aria-label={background ? "背景色" : "文字颜色"}
        onMouseDown={rememberSelection}
      >
        {background ? <Highlighter size={16} /> : <Palette size={16} />}
      </summary>
      <div className="toolbar-color-panel">
        <button
          disabled={disabled}
          onMouseDown={holdSelection}
          onClick={() =>
            run(
              (h) =>
                h.editor.removeMark(background ? "backgroundColor" : "color"),
              true,
            )
          }
        >
          {background ? "清除背景色" : "默认颜色"}
        </button>
        <div className="toolbar-colors">
          {(background
            ? [
                "#fff1b8",
                "#dbeafe",
                "#dcfce7",
                "#fce7f3",
                "#f3e8ff",
                "#fee2e2",
                "#ffedd5",
                "#e5e7eb",
              ]
            : [
                "#1f2329",
                "#646a73",
                "#3370ff",
                "#245bdb",
                "#13a870",
                "#d97706",
                "#e5484d",
                "#8b5cf6",
              ]
          ).map((color) => (
            <button
              key={color}
              disabled={disabled}
              aria-label={color === "transparent" ? "清除背景色" : color}
              title={color}
              style={{ background: color }}
              aria-pressed={
                (background ? marks?.backgroundColor : marks?.color) === color
              }
              onMouseDown={holdSelection}
              onClick={() =>
                run(
                  (h) =>
                    h.commands.toggleMark(
                      background ? "backgroundColor" : "color",
                      color,
                    ),
                  true,
                )
              }
            ></button>
          ))}
        </div>
        <label className="custom-color-picker">
          自定义颜色
          <input
            type="color"
            aria-label={background ? "自定义背景色" : "自定义文字颜色"}
            disabled={disabled}
            defaultValue={background ? "#fff1b8" : "#1f2329"}
            onMouseDown={(e) => {
              e.stopPropagation();
              savedColorSelection.current = handle?.editor.selection
                ? structuredClone(handle.editor.selection)
                : null;
            }}
            onChange={(e) =>
              run((h) => {
                if (savedColorSelection.current)
                  Transforms.select(h.editor, savedColorSelection.current);
                h.commands.toggleMark(
                  background ? "backgroundColor" : "color",
                  e.target.value,
                );
              })
            }
          />
        </label>
      </div>
    </details>
  );
  const items = [
    ...tools
      .slice(0, 2)
      .map((t) => ({ key: t.name, width: 30, node: button(t) })),
    {
      key: "撤销分隔",
      width: 10,
      node: (
        <span
          className="toolbar-divider"
          role="separator"
          aria-orientation="vertical"
        />
      ),
    },
    {
      key: "段落样式",
      width: 78,
      node: (
        <details className="menu">
          <summary aria-label="段落样式">
            正文 <ChevronDown size={12} />
          </summary>
          <div>
            {(
              [
                ["paragraph", "正文"],
                ["heading-one", "一级标题"],
                ["heading-two", "二级标题"],
                ["heading-three", "三级标题"],
                ["heading-four", "四级标题"],
                ["heading-five", "五级标题"],
                ["bulleted-list", "无序列表"],
                ["numbered-list", "有序列表"],
                ["todo", "待办事项"],
                ["block-quote", "引用"],
              ] as [BlockType, string][]
            ).map(([type, label]) => (
              <button
                key={type}
                disabled={disabled}
                aria-pressed={!!handle?.query.isBlockActive(type)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run((h) => h.commands.toggleBlock(type))}
              >
                {label}
              </button>
            ))}
          </div>
        </details>
      ),
    },
    {
      key: "字体",
      width: 82,
      node: (
        <details className="menu">
          <summary aria-label="字体" onMouseDown={rememberSelection}>
            {
              ["默认字体", "黑体", "宋体", "楷体", "等宽字体"][
                Math.max(
                  0,
                  FONT_FAMILIES.findIndex(
                    (f) => f.value === (marks?.fontFamily ?? ""),
                  ),
                )
              ]
            }
            <ChevronDown size={12} />
          </summary>
          <div>
            {FONT_FAMILIES.map((family, index) => (
              <button
                key={family.key}
                disabled={disabled}
                aria-pressed={(marks?.fontFamily ?? "") === family.value}
                style={{ fontFamily: family.value || undefined }}
                onMouseDown={holdSelection}
                onClick={() =>
                  run((h) => h.commands.setFontFamily(family.value), true)
                }
              >
                {["默认字体", "黑体", "宋体", "楷体", "等宽字体"][index]}
              </button>
            ))}
          </div>
        </details>
      ),
    },
    { key: "字号", width: 52, node: sizeMenu },
    { key: "文字颜色", width: 30, node: colorMenu(false) },
    { key: "背景色", width: 30, node: colorMenu(true) },
    ...tools.slice(2).map((t) => ({ key: t.name, width: 30, node: button(t) })),
    {
      key: "超链接",
      width: 30,
      node: <DocumentLinkControl handle={handle} disabled={disabled} />,
    },
    {
      key: "表情",
      width: 30,
      node: (
        <EmojiPicker
          disabled={disabled}
          insert={(emoji) =>
            run((h) => {
              h.commands.focus();
              h.editor.insertText(emoji);
            })
          }
        />
      ),
    },
    {
      key: "插入分隔",
      width: 10,
      node: (
        <span
          className="toolbar-divider"
          role="separator"
          aria-orientation="vertical"
        />
      ),
    },
    ...[
      {
        name: "代码块",
        icon: Code,
        action: (h: RichTextEditorHandle) =>
          h.commands.insertBlock({
            id: crypto.randomUUID(),
            type: "code-block",
            language: "typescript",
            code: "",
            children: [{ text: "" }],
          }),
      },
      {
        name: "公式",
        icon: Sigma,
        action: (h: RichTextEditorHandle) => h.commands.insertFormula(),
      },
      {
        name: "引用",
        icon: Quote,
        action: (h: RichTextEditorHandle) =>
          h.commands.toggleBlock("block-quote"),
      },
      {
        name: "分割线",
        icon: Minus,
        action: (h: RichTextEditorHandle) =>
          h.commands.insertBlock({
            id: crypto.randomUUID(),
            type: "divider",
            children: [{ text: "" }],
          }),
      },
      {
        name: "卡片",
        icon: Square,
        action: (h: RichTextEditorHandle) =>
          h.commands.insertBlock({
            id: crypto.randomUUID(),
            type: "card",
            children: [
              {
                id: crypto.randomUUID(),
                type: "paragraph",
                children: [{ text: "" }],
              },
            ],
          }),
      },
      {
        name: "图片 / 视频",
        icon: ImagePlus,
        action: () => {
          setFileKind("media");
          setSourcePicker(true);
        },
      },
      {
        name: "附件",
        icon: Paperclip,
        action: () => {
          setFileKind("attachment");
          setSourcePicker(true);
        },
      },
    ].map((t) => ({ key: t.name, width: 30, node: button(t) })),
    {
      key: "插入表格",
      width: 46,
      node: (
        <details className="menu">
          <summary aria-label="插入表格">
            <Table2 size={16} />
            <ChevronDown size={12} />
          </summary>
          <div
            className="toolbar-table-grid"
            onMouseLeave={() => setTableSize({ rows: 0, columns: 0 })}
          >
            {Array.from({ length: 36 }, (_, i) => ({
              rows: Math.floor(i / 6) + 1,
              columns: (i % 6) + 1,
            })).map(({ rows, columns }) => (
              <button
                key={`${rows}:${columns}`}
                aria-label={`${rows} 行 ${columns} 列表格`}
                title={`${rows} 行 ${columns} 列`}
                className={
                  rows <= tableSize.rows && columns <= tableSize.columns
                    ? "in-range"
                    : ""
                }
                onMouseEnter={() => setTableSize({ rows, columns })}
                onFocus={() => setTableSize({ rows, columns })}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  run((h) => h.commands.insertTable(rows, columns))
                }
              >
                <span />
              </button>
            ))}
          </div>
        </details>
      ),
    },
    {
      key: "插入分列",
      width: 46,
      node: (
        <details className="menu">
          <summary aria-label="插入分列">
            <Columns3 size={16} />
            <ChevronDown size={12} />
          </summary>
          <div>
            {([2, 3, 4] as const).map((n) => (
              <button
                key={n}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run((h) => h.commands.insertColumns(n))}
              >
                {n} 列布局
              </button>
            ))}
          </div>
        </details>
      ),
    },
  ];
  const mobileEditor =
    typeof document !== "undefined" &&
    document.documentElement.dataset.editorShell === "mobile";
  const mobileTools = new Set([
    "段落样式",
    "加粗",
    "斜体",
    "下划线",
    "删除线",
    "左对齐",
    "居中",
    "右对齐",
    "超链接",
    "引用",
    "图片 / 视频",
    "分割线",
  ]);
  const toolbarItems = mobileEditor
    ? items.filter((item) => mobileTools.has(item.key))
    : items;
  const count = visibleToolbarCount(
    width,
    toolbarItems.map((item) => item.width),
  );
  const overflow = toolbarItems
    .slice(count)
    .filter((item) => !item.key.endsWith("分隔"));
  return (
    <div
      className="editor-fixed-toolbar"
      role="toolbar"
      aria-label="文档操作栏"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="editor-toolbar-buttons" ref={host}>
        {toolbarItems.slice(0, count).map((item) => (
          <div
            className="toolbar-item"
            key={item.key}
            style={{ width: item.width }}
          >
            {item.node}
          </div>
        ))}
        {overflow.length > 0 && (
          <details className="menu toolbar-overflow">
            <summary aria-label="更多文字工具">
              <MoreHorizontal size={17} />
            </summary>
            <div className="toolbar-overflow-panel">
              {overflow.map((item) => (
                <div className="toolbar-overflow-item" key={item.key}>
                  {item.node}
                  <span>{item.key}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      <input
        ref={file}
        hidden
        type="file"
        accept={
          fileKind === "media" ? "image/*,.svg,image/svg+xml,video/*" : undefined
        }
        onChange={(e) => {
          const selected = e.target.files?.[0];
          e.target.value = "";
          if (!selected || !handle || disabled) return;
          void (
            fileKind === "media"
              ? handle.commands.uploadMedia(selected)
              : handle.commands.uploadAttachment(selected)
          ).catch((e) => setError(e.message));
        }}
      />
      {error && <Feedback message={error} tone="error" />}
      {folderPicker && <FolderFilePicker close={() => setFolderPicker(false)} select={async (item: FileItem) => {
        if (!handle || disabled) return;
        const response = await fetch(fileUrl(item.id));
        if (!response.ok) throw new Error("文件读取失败");
        const selected = new File([await response.blob()], item.name, { type: item.mime });
        const svg = /\.svg$/i.test(item.name) || item.mime === "image/svg+xml";
        if (svg || item.mime.startsWith("image/") || item.mime.startsWith("video/")) await handle.commands.uploadMedia(selected);
        else await handle.commands.uploadAttachment(selected);
      }} />}
      {sourcePicker && <FileSourceDialog title={fileKind === "media" ? "添加图片或视频" : "添加附件"} close={() => setSourcePicker(false)} chooseDoca={() => setFolderPicker(true)} chooseLocal={() => requestAnimationFrame(() => file.current?.click())} />}
    </div>
  );
}
