import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";

const emoji = [
  "😀",
  "😄",
  "😊",
  "😍",
  "🥰",
  "😎",
  "🤔",
  "😅",
  "😂",
  "🥹",
  "😭",
  "😮",
  "👍",
  "👎",
  "👏",
  "🙌",
  "🙏",
  "💪",
  "❤️",
  "💛",
  "🎉",
  "✨",
  "🔥",
  "💡",
  "✅",
  "❓",
  "👀",
  "🚀",
  "☕",
  "🌷",
];
export function EmojiPicker({
  insert,
  disabled = false,
}: {
  insert: (emoji: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <span className="emoji-picker" ref={host}>
      <button
        type="button"
        title="插入表情"
        aria-label="插入表情"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Smile size={17} />
      </button>
      {open && (
        <span className="emoji-palette" role="dialog" aria-label="选择表情">
          {emoji.map((value) => (
            <button
              type="button"
              key={value}
              aria-label={value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                insert(value);
                setOpen(false);
              }}
            >
              {value}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
