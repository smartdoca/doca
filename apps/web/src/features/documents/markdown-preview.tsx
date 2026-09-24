import { MarkdownPreview } from "exmd-collaborative-editor";
import { assetUrl } from "@web/shared/api.js";
import { platformAssetId } from "@web/shared/utils/asset-path.js";
import "exmd-collaborative-editor/style.css";
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
  return (
    <div className="doca-markdown markdown-preview-only">
      <MarkdownPreview
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
