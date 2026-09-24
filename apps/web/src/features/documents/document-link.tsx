import { Editor, Element, Node, Transforms } from "slate";
import { FileText } from "lucide-react";
import { ReactEditor } from "slate-react";
import {
  createAtomicInlineExtension,
  type CustomElement,
  type EditorPlugin,
} from "slatetsx-kit-editor";
import { api, type Detail } from "@web/shared/api.js";
import { internalDocumentId } from "@web/features/documents/internal-document-id.js";
export { internalDocumentId } from "@web/features/documents/internal-document-id.js";

import { referenceCodec } from "@core/modules/documents/codecs/rich-runtime.js";
const extension = createAtomicInlineExtension({
  ...referenceCodec,
  decode: (data, identity) =>
    referenceCodec.decode(data, identity) as CustomElement,
  render: (e) => (
    <span className="document-inline-reference">
      <a
        href={`#/r/${e.documentId}`}
        target="_blank"
        rel="noopener noreferrer"
        onMouseDown={(event) => event.preventDefault()}
      >
        <FileText size={15} />
        {String(e.label)}
      </a>
    </span>
  ),
});
export const documentLinkPlugin: EditorPlugin = {
  ...extension.plugin,
  withEditor(editor) {
    const e = extension.plugin.withEditor?.(editor) ?? editor;
    const insertData = e.insertData;
    e.insertData = (data) => {
      const id = internalDocumentId(
        data.getData("text/plain").trim(),
        location.origin,
      );
      if (!id || data.files.length) return insertData(data);
      const nodeId = crypto.randomUUID();
      Transforms.insertNodes(e, {
        type: "custom:document-reference",
        id: nodeId,
        documentId: id,
        label: "文档链接",
        children: [{ text: "" }],
      });
      Transforms.move(e);
      void api<Detail>(`/resources/${id}`)
        .then((detail) => {
          if (detail.resource.kind !== "document" || ReactEditor.isReadOnly(e))
            return;
          const found = [
            ...Editor.nodes(e, {
              at: [],
              match: (n) => Element.isElement(n) && n.id === nodeId,
              voids: true,
            }),
          ][0];
          if (found && (found[0] as any).label === "文档链接")
            Transforms.setNodes(e, { label: detail.resource.title } as any, {
              at: found[1],
              voids: true,
            });
        })
        .catch(() => {});
    };
    return e;
  },
};
