import { RichTextEditor, type EditorValue } from "@smartdoca/slate";
import { useI18n } from "@web/shared/i18n.js";
import { renderKatex } from "@smartdoca/slate/katex";
import { assetUrl } from "@web/shared/api.js";
import "@smartdoca/slate/style.css";
import { mentionPlugin } from "@web/features/documents/document-mentions.js";
import { documentLinkPlugin } from "@web/features/documents/document-link.js";
import { pluginElementPlugin } from "./rich-plugin-elements.js";
const plugins = [mentionPlugin, documentLinkPlugin, pluginElementPlugin];
export default function VersionPreview({
  value,
  trash = false,
  audit = false,
}: {
  value: EditorValue;
  trash?: boolean;
  audit?: boolean;
}) {
  const { locale } = useI18n();
  return (
    <div className="history-editor-preview">
      <RichTextEditor
        locale={locale}
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
