import { MarkdownPreview } from "@smartdoca/markdown";
import { useI18n } from "@web/shared/i18n.js";
import { assetUrl } from "@web/shared/api.js";
import { platformAssetId } from "@web/shared/utils/asset-path.js";
import "@smartdoca/markdown/style.css";
import "katex/dist/katex.min.css";
import "@web/features/documents/markdown.css";
export default function Preview({
  value,
  trash = false,
  audit = false,
}: {
  value: string;
  trash?: boolean;
  audit?: boolean;
}) {
  const { locale } = useI18n();
  return (
    <div className="doca-markdown markdown-preview-only">
      <MarkdownPreview
        locale={locale}
        value={value}
        resolveImageUrl={(path) =>
          platformAssetId(path)
            ? assetUrl(platformAssetId(path)!) +
              (audit ? "?audit=1" : trash ? "?trashPreview=1" : "")
            : ""
        }
      />
    </div>
  );
}
