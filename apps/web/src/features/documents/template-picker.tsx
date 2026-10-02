import { useState } from "react";
import { api, type Resource } from "@web/shared/api.js";
import { CreationTemplatePicker } from "@web/features/creation-resources/pickers.js";
import type { TemplateSelection } from "@smartdoca/plugin-contracts";
import { useI18n } from "@web/shared/i18n.js";
export function TemplatePicker({
  format,
  parentId,
  libraryId,
  close,
  created,
}: {
  format: Resource["format"];
  parentId: string | null;
  libraryId: string | null;
  close: () => void;
  created: (id: string) => void;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  async function create(template?: TemplateSelection) {
    if (creating) return;
    setCreating(true);
    try {
      const card = template
        ? await api<{ title: string }>(
            "/creation-resources/templates/describe",
            "POST",
            template.ref,
          )
        : undefined;
      const resource = await api<Resource>("/resources", "POST", {
        kind: "document",
        format,
        title: card?.title ?? t("resources.untitled"),
        parentId,
        libraryId,
        ...(template ? { template } : {}),
      });
      created(resource.id);
    } catch (e) {
      setCreating(false);
      throw e;
    }
  }
  return (
    <CreationTemplatePicker
      contract={{ id: `doca.document.${format}`, version: 1 }}
      contentType={{
        id: `doca.native.${format}`,
        version: format === "presentation" ? 2 : 1,
      }}
      close={creating ? () => {} : close}
      blank={() => create()}
      select={(selection) => create(selection)}
    />
  );
}
