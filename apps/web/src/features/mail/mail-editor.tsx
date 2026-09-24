import { useEffect, useRef } from "react";
import {
  Bold,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Type,
  Underline,
} from "lucide-react";
import { htmlToText, sanitizeMailHtml, textToHtml } from "@web/features/mail/mail-html.js";

const commands = [
  ["bold", "加粗", Bold],
  ["italic", "斜体", Italic],
  ["underline", "下划线", Underline],
  ["strikeThrough", "删除线", Strikethrough],
  ["insertUnorderedList", "无序列表", List],
  ["insertOrderedList", "有序列表", ListOrdered],
  ["formatBlock", "引用", Quote],
  ["createLink", "链接", Link],
  ["removeFormat", "清除格式", Type],
] as const;

export function MailRichEditor({
  html,
  text,
  resetKey,
  placeholder = "输入正文",
  onChange,
}: {
  html?: string;
  text?: string;
  resetKey: string;
  placeholder?: string;
  onChange: (html: string, text: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = editor.current;
    if (!node) return;
    const next = html?.trim() ? sanitizeMailHtml(html) : text ? textToHtml(text) : "";
    if (node.innerHTML !== next) node.innerHTML = next;
  }, [resetKey]);

  function emit() {
    const node = editor.current;
    if (!node) return;
    const next = sanitizeMailHtml(node.innerHTML);
    onChange(next, htmlToText(next));
  }

  function run(command: (typeof commands)[number][0]) {
    editor.current?.focus();
    if (command === "createLink") {
      const href = window.prompt("链接地址", "https://");
      if (href) document.execCommand("createLink", false, href);
    } else if (command === "formatBlock") {
      document.execCommand("formatBlock", false, "blockquote");
    } else {
      document.execCommand(command, false);
    }
    emit();
  }

  return (
    <div className="mail-rich">
      <div className="mail-rich-toolbar" role="toolbar" aria-label="邮件格式">
        {commands.map(([command, label, Icon]) => (
          <button key={command} type="button" className="icon" title={label} aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={() => run(command)}>
            <Icon size={15} />
          </button>
        ))}
      </div>
      <div
        ref={editor}
        className="mail-rich-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={emit}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text/html");
          if (!pasted) return;
          event.preventDefault();
          document.execCommand("insertHTML", false, sanitizeMailHtml(pasted));
          emit();
        }}
      />
    </div>
  );
}
