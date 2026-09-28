import { useEffect, useState, type RefObject } from "react";
import { Editor, Element, Node, Path, Text, type Point } from "slate";
import { ReactEditor } from "slate-react";
import type { RichTextEditorHandle } from "@smartdoca/slate";
import type { YjsDocument } from "@smartdoca/slate/yjs";
import { realtime, toBase64, fromBase64 } from "@web/features/documents/realtime.js";

type TextPosition = { blockId: string; position: string; kind?: "text" };
type CodePosition = {
  blockId: string;
  kind: "code";
  offset: number;
  fingerprint: string;
};
type Position = TextPosition | CodePosition;
export function codeFingerprint(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
// Code is an independent native textarea, not a Slate text leaf. Measure a mirror
// with identical typography; never focus it or write to the actual code editor.
function codeCaret(host: HTMLElement, point: CodePosition): DOMRect | null {
  const input = host.querySelector<HTMLTextAreaElement>(
    `[data-block-id="${CSS.escape(point.blockId)}"] .sk-code-editor`,
  );
  if (
    !input ||
    codeFingerprint(input.value) !== point.fingerprint ||
    point.offset > input.value.length
  )
    return null;
  const style = getComputedStyle(input),
    box = input.getBoundingClientRect();
  const mirror = document.createElement("div"),
    marker = document.createElement("span");
  mirror.setAttribute("aria-hidden", "true");
  for (const key of [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "tab-size",
    "text-indent",
    "text-transform",
    "padding-top",
    "padding-left",
    "padding-right",
    "padding-bottom",
    "border-top-width",
    "border-left-width",
    "border-right-width",
    "border-bottom-width",
    "box-sizing",
    "word-break",
    "overflow-wrap",
  ])
    mirror.style.setProperty(key, style.getPropertyValue(key));
  Object.assign(mirror.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${box.width}px`,
    whiteSpace: input.wrap === "off" ? "pre" : "pre-wrap",
    borderStyle: "solid",
    visibility: "hidden",
  });
  mirror.textContent = input.value.slice(0, point.offset);
  marker.textContent = "\u200b";
  mirror.append(
    marker,
    document.createTextNode(input.value.slice(point.offset)),
  );
  document.body.append(mirror);
  try {
    const m = mirror.getBoundingClientRect(),
      r = marker.getBoundingClientRect();
    const x = box.left + r.left - m.left - input.scrollLeft;
    const y = box.top + r.top - m.top - input.scrollTop;
    if (x < box.left || x > box.right || y < box.top || y >= box.bottom)
      return null;
    return new DOMRect(x, y, 0, r.height || parseFloat(style.lineHeight) || 20);
  } finally {
    mirror.remove();
  }
}
type Peer = {
  connectionId: string;
  name: string;
  color: string;
  selection: { anchor: Position; focus: Position };
};
// SDK text offsets count UTF-16 code units; a mention counts as one object marker.
export function blockOffset(editor: Editor, point: Point) {
  const block = Editor.above(editor, {
    at: point,
    mode: "lowest",
    match: (n) => Element.isElement(n) && Editor.isBlock(editor, n),
  });
  if (!block || !Element.isElement(block[0])) throw new Error("没有文本块");
  let offset = 0,
    done = false;
  const walk = (node: Node, path: number[]) => {
    if (done) return;
    if (Text.isText(node)) {
      if (Path.equals(path, point.path)) {
        offset += point.offset;
        done = true;
      } else offset += node.text.length;
    } else if (Element.isElement(node) && String(node.type) === "mention") {
      if (Path.isAncestor(path, point.path)) done = true;
      else offset++;
    } else if ("children" in node)
      node.children.forEach((n, i) => walk(n, [...path, i]));
  };
  walk(block[0], block[1]);
  return { blockId: block[0].id, offset };
}
export function slatePoint(
  editor: Editor,
  blockId: string,
  offset: number,
): Point | null {
  const block = [
    ...Editor.nodes(editor, {
      at: [],
      match: (n) => Element.isElement(n) && n.id === blockId,
    }),
  ][0];
  if (!block) return null;
  let result: Point | null = null;
  const walk = (node: Node, path: number[]) => {
    if (result) return;
    if (Text.isText(node)) {
      if (offset <= node.text.length) result = { path, offset };
      else offset -= node.text.length;
    } else if (Element.isElement(node) && String(node.type) === "mention") {
      if (offset === 0) result = Editor.start(editor, path);
      else offset--;
    } else if ("children" in node)
      node.children.forEach((n, i) => walk(n, [...path, i]));
  };
  walk(block[0], block[1]);
  return result;
}
export function RemoteCursors({
  id,
  handle,
  runtime,
  editable,
  host,
}: {
  id: string;
  handle: RefObject<RichTextEditorHandle | null>;
  runtime: YjsDocument;
  editable: boolean;
  host: RefObject<HTMLElement | null>;
}) {
  const [marks, setMarks] = useState<
    {
      id: string;
      name: string;
      color: string;
      caret: { left: number; top: number; height: number };
      rects: { left: number; top: number; width: number; height: number }[];
      flip: boolean;
    }[]
  >([]);
  useEffect(() => {
    let peers: Peer[] = [],
      previous = "",
      frame = 0;
    function position(point: Point): Position {
      const p = blockOffset(handle.current!.editor, point);
      const a = runtime.createCommentAnchor(p.blockId, p.offset, p.offset);
      return { blockId: p.blockId, position: toBase64(a.start) };
    }
    function resolve(p: TextPosition) {
      const a = runtime.resolveCommentAnchor({
        blockId: p.blockId,
        quote: "",
        start: fromBase64(p.position),
        end: fromBase64(p.position),
      });
      // A collapsed anchor is marked orphaned by the comment API by definition.
      // Resolve its point only if the block still exists in the current Slate tree.
      return slatePoint(handle.current!.editor, p.blockId, a.start);
    }
    function draw() {
      const editor = handle.current?.editor,
        container = host.current;
      if (!editable || !editor || !container) {
        setMarks([]);
        return;
      }
      const origin = container.getBoundingClientRect();
      const scroller = container.closest(".main-scroll");
      const ceiling = scroller ? scroller.getBoundingClientRect().top : 0;
      const flip = (caretTop: number) =>
        origin.top + caretTop - 21 < ceiling + 2;
      const rect = (r: DOMRect) => ({
        left: r.left - origin.left,
        top: r.top - origin.top,
        width: r.width,
        height: r.height,
      });
      setMarks(
        peers.flatMap((p) => {
          try {
            if (p.selection.focus.kind === "code") {
              const r = codeCaret(container, p.selection.focus);
              return r
                ? [
                    {
                      id: p.connectionId,
                      name: p.name,
                      color: p.color,
                      caret: rect(r),
                      rects: [],
                      flip: flip(r.top - origin.top),
                    },
                  ]
                : [];
            }
            if (p.selection.anchor.kind === "code") return [];
            const anchor = resolve(p.selection.anchor),
              focus = resolve(p.selection.focus);
            if (!anchor || !focus) return [];
            const caret = ReactEditor.toDOMRange(editor, {
              anchor: focus,
              focus,
            });
            let r = caret.getClientRects()[0];
            if (!r || !r.height) {
              const [node] = ReactEditor.toDOMPoint(editor, focus);
              r = (
                node.nodeType === 1 ? (node as HTMLElement) : node.parentElement
              )?.getBoundingClientRect();
            }
            if (!r) return [];
            const selection = ReactEditor.toDOMRange(editor, { anchor, focus });
            return [
              {
                id: p.connectionId,
                name: p.name,
                color: p.color,
                caret: rect(r),
                rects: Array.from(selection.getClientRects())
                  .filter((r) => r.width > 0)
                  .map(rect),
                flip: flip(r.top - origin.top),
              },
            ];
          } catch {
            return [];
          }
        }),
      );
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const unsubscribe = realtime.subscribe((m) => {
      if (m.type === "disconnected") {
        peers = [];
        previous = "";
        schedule();
      }
      if (m.room === id && m.type === "cursors") {
        peers = m.sessions;
        schedule();
      }
      if (m.room === id && ["update", "sync-response"].includes(m.type))
        schedule();
    });
    // Rate limited, selection-only messages; never serialize/rewrite document content.
    const timer = setInterval(() => {
      const editor = handle.current?.editor;
      let selection = null;
      try {
        const active = document.activeElement;
        if (
          editable &&
          active instanceof HTMLTextAreaElement &&
          active.matches(".sk-code-editor") &&
          host.current?.contains(active)
        ) {
          const blockId =
            active.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
          if (blockId) {
            const fingerprint = codeFingerprint(active.value);
            const backward = active.selectionDirection === "backward";
            selection = {
              anchor: {
                blockId,
                kind: "code" as const,
                offset: backward ? active.selectionEnd : active.selectionStart,
                fingerprint,
              },
              focus: {
                blockId,
                kind: "code" as const,
                offset: backward ? active.selectionStart : active.selectionEnd,
                fingerprint,
              },
            };
          }
        } else if (
          editable &&
          editor?.selection &&
          ReactEditor.isFocused(editor)
        )
          selection = {
            anchor: position(editor.selection.anchor),
            focus: position(editor.selection.focus),
          };
      } catch {
        /* No valid caret in independent diagram/widget inputs. */
      }
      const next = JSON.stringify(selection);
      if (
        next !== previous &&
        realtime.send({
          type: "cursor",
          room: id,
          id: crypto.randomUUID(),
          selection,
        })
      )
        previous = next;
    }, 150);
    const observer = new ResizeObserver(schedule);
    if (host.current) observer.observe(host.current);
    document.addEventListener("scroll", schedule, true);
    runtime.doc.on("update", schedule);
    schedule();
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      document.removeEventListener("scroll", schedule, true);
      runtime.doc.off("update", schedule);
      realtime.send({
        type: "cursor",
        room: id,
        id: crypto.randomUUID(),
        selection: null,
      });
    };
  }, [id, runtime, editable, handle, host]);
  return (
    <div className="remote-cursors" aria-hidden="true">
      {editable &&
        marks.map((m) => (
          <div key={m.id}>
            {m.rects.map((r, i) => (
              <i
                key={i}
                className="remote-selection"
                style={{ ...r, background: m.color }}
              />
            ))}
            <span
              className="remote-caret"
              style={{ ...m.caret, borderColor: m.color }}
            >
              <span
                className={m.flip ? "flip" : undefined}
                style={{ background: m.color }}
              >
                {m.name}
              </span>
            </span>
          </div>
        ))}
    </div>
  );
}
