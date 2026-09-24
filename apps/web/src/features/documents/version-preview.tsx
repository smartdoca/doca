import { RichTextEditor, type EditorValue } from "slatetsx-kit-editor";
import { renderKatex } from "slatetsx-kit-editor/katex";
import { assetUrl } from "@web/shared/api.js";
import "slatetsx-kit-editor/style.css";
import { mentionPlugin } from "@web/features/documents/document-mentions.js";
import { documentLinkPlugin } from "@web/features/documents/document-link.js";
const plugins = [mentionPlugin, documentLinkPlugin];
export default function VersionPreview({
  value,
  trash = false,
  audit = false,
}: {
  value: EditorValue;
  trash?: boolean;
  audit?: boolean;
}) {
  return (
    <div className="history-editor-preview">
      <RichTextEditor
        formulaRenderer={renderKatex}
        plugins={plugins}
        initialValue={value}
        mode="readonly"
        resources={{
          resolveUrl: (path) =>
            /^[a-f0-9-]{36}$/.test(path)
              ? assetUrl(path) + (audit ? "?audit=1" : trash ? "?trashPreview=1" : "")
              : "",
        }}
      />
    </div>
  );
}
