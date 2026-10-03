import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor, Element, Transforms, type RangeRef } from "slate";
import { HistoryEditor } from "slate-history";
import { ReactEditor, useReadOnly } from "slate-react";
import {
  createAtomicInlineExtension,
  type CustomElement,
  type RichTextEditorHandle,
} from "@smartdoca/slate";
import {
  isPluginElementPayload,
  type PluginElementPayload,
} from "@smartdoca/plugin-contracts";
import { pluginElementCodec } from "@core/modules/documents/codecs/rich-runtime.js";
import { webPluginRegistry } from "@web/plugins/registry.js";
import { useI18n } from "@web/shared/i18n.js";
import {
  ElementBoundary,
  ElementContent,
  ElementPlaceholder,
  PluginElementDialog,
  pluginElementState,
  usePluginElements,
  type ElementDialogSession,
} from "./plugin-elements.js";
import { PackagePlus, Settings2 } from "lucide-react";

const ElementSession = createContext<{
  documentId: string;
  edit(id: string): void;
} | null>(null);
function RichElementContent({ element }: { element: CustomElement }) {
  usePluginElements("rich_text");
  const session = useContext(ElementSession),
    readOnly = useReadOnly();
  const { locale, t } = useI18n();
  const payload = element.payload;
  const type =
    typeof (payload as any)?.type === "string"
      ? (payload as any).type
      : undefined;
  const provider = type ? webPluginRegistry.elements.get(type) : undefined;
  const state = useMemo(
    () => pluginElementState(payload, provider, "rich_text"),
    [payload, provider],
  );
  const abort = useMemo(
    () => new AbortController(),
    [session?.documentId, element.id, provider],
  );
  useEffect(() => () => abort.abort(), [abort]);
  return (
    <span className="plugin-element-inline" data-plugin-element={type}>
      <ElementBoundary
        key={`${type}:${(payload as any)?.dataVersion}:${webPluginRegistry.elements.snapshot()}`}
        type={type}
      >
        {state === "ready" ? (
          <ElementContent
            provider={provider!}
            payload={payload as unknown as PluginElementPayload}
            context={{
              documentId: session?.documentId ?? "",
              format: "rich_text",
              locale,
              readOnly,
              signal: abort.signal,
            }}
          />
        ) : (
          <ElementPlaceholder
            type={type}
            reason={state === "invalid" ? "invalid" : "unsupported"}
          />
        )}
      </ElementBoundary>
      {!readOnly && session && (
        <button
          type="button"
          className="plugin-element-configure"
          title={t("editor.element.edit")}
          aria-label={t("editor.element.edit")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => session.edit(element.id)}
        >
          <Settings2 size={13} />
        </button>
      )}
    </span>
  );
}
export const pluginElementPlugin = createAtomicInlineExtension({
  ...pluginElementCodec,
  decode: (data, identity) =>
    pluginElementCodec.decode(data, identity) as CustomElement,
  render: (element) => <RichElementContent element={element} />,
}).plugin;

export function RichPluginElements({
  documentId,
  handle,
  editable,
  children,
}: {
  documentId: string;
  handle: RichTextEditorHandle | null;
  editable: boolean;
  children: (insert: React.ReactNode) => React.ReactNode;
}) {
  const { t } = useI18n();
  const providers = usePluginElements("rich_text");
  const [session, setSession] = useState<ElementDialogSession | null>(null);
  const [range, setRange] = useState<RangeRef | null>(null);
  const active = useRef({ documentId, handle, editable });
  active.current = { documentId, handle, editable };
  const close = () => {
    range?.unref();
    setRange(null);
    setSession(null);
  };
  useEffect(() => {
    if (!editable) close();
  }, [editable]);
  useEffect(() => {
    close();
  }, [documentId, handle]);
  useEffect(
    () => () => {
      range?.unref();
    },
    [range],
  );
  const live = () => {
    if (
      !handle ||
      !editable ||
      !active.current.editable ||
      active.current.handle !== handle ||
      active.current.documentId !== documentId ||
      ReactEditor.isReadOnly(handle.editor)
    )
      throw Error("Editor unavailable");
    return handle.editor;
  };
  const edit = (id: string) => {
    const editor = live();
    const find = () =>
      [
        ...Editor.nodes(editor, {
          at: [],
          match: (node) =>
            Element.isElement(node) &&
            node.type === "custom:plugin-element" &&
            node.id === id,
          voids: true,
        }),
      ][0];
    const found = find();
    if (!found) return;
    const payload = (found[0] as CustomElement).payload;
    const current = isPluginElementPayload(payload) ? payload : null;
    setSession({
      type:
        typeof (payload as any)?.type === "string"
          ? (payload as any).type
          : "unsupported",
      unsupported:
        pluginElementState(
          payload,
          current ? webPluginRegistry.elements.get(current.type) : undefined,
          "rich_text",
        ) !== "ready",
      initialData: current?.data,
      commit(next) {
        live();
        const target = find();
        if (!target) throw Error("Element removed");
        // Do not overwrite a concurrently changed config with the stale form.
        if (
          JSON.stringify((target[0] as CustomElement).payload) !==
          JSON.stringify(payload)
        )
          throw Error("Element changed");
        if (
          !current ||
          next.dataVersion !== current.dataVersion ||
          next.type !== current.type
        )
          throw Error("Unsupported element version");
        HistoryEditor.withNewBatch(editor as HistoryEditor, () =>
          Transforms.setNodes(
            editor,
            { payload: next, label: next.text },
            { at: target[1], voids: true },
          ),
        );
      },
      remove() {
        live();
        const target = find();
        if (!target) throw Error("Element removed");
        if (
          JSON.stringify((target[0] as CustomElement).payload) !==
          JSON.stringify(payload)
        )
          throw Error("Element changed");
        HistoryEditor.withNewBatch(editor as HistoryEditor, () =>
          Transforms.removeNodes(editor, { at: target[1], voids: true }),
        );
      },
    });
  };
  const insert = providers.length ? (
    <button
      type="button"
      disabled={!handle || !editable}
      title={t("editor.element.insert")}
      aria-label={t("editor.element.insert")}
      onMouseDown={(event) => {
        event.preventDefault();
        if (handle?.editor.selection) {
          range?.unref();
          setRange(
            Editor.rangeRef(handle.editor, handle.editor.selection, {
              affinity: "inward",
            }),
          );
        }
      }}
      onClick={() => {
        const insertionRange =
          range ??
          (handle?.editor.selection
            ? Editor.rangeRef(handle.editor, handle.editor.selection, {
                affinity: "inward",
              })
            : null);
        if (!insertionRange?.current) return;
        if (insertionRange !== range) setRange(insertionRange);
        setSession({
          commit(payload) {
            const editor = live();
            if (!insertionRange.current)
              throw Error("Insertion position removed");
            ReactEditor.focus(editor);
            HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
              Transforms.select(editor, insertionRange.current!);
              Transforms.insertNodes(editor, {
                type: "custom:plugin-element",
                id: crypto.randomUUID(),
                payload,
                label: payload.text,
                children: [{ text: "" }],
              });
              Transforms.move(editor);
            });
          },
        });
      }}
    >
      <PackagePlus size={17} />
    </button>
  ) : null;
  return (
    <ElementSession.Provider value={{ documentId, edit }}>
      {children(insert)}
      {session && editable && (
        <PluginElementDialog
          documentId={documentId}
          format="rich_text"
          session={session}
          close={close}
        />
      )}
    </ElementSession.Provider>
  );
}
