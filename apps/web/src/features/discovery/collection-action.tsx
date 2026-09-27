import { useState } from "react";
import { BookmarkPlus, BookmarkCheck } from "lucide-react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import type { PublicResourceKind } from "@core/modules/deployment/policies.js";
export function CollectionAction({
  id,
  kind,
  collected,
  changed,
  onError,
}: {
  id: string;
  kind: PublicResourceKind;
  collected: boolean;
  changed: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      className={
        collected ? "collection-action is-collected" : "collection-action"
      }
      aria-label={t(collected ? "discovery.remove" : "discovery.collect")}
      aria-pressed={collected}
      title={t(collected ? "discovery.remove" : "discovery.collect")}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await api(`/discovery/entries/${kind}/${id}`, "PUT", {
            collected: !collected,
          });
          changed();
          window.dispatchEvent(new Event("doca-collections-changed"));
        } catch (e) {
          onError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {collected ? <BookmarkCheck size={15} /> : <BookmarkPlus size={15} />}
      <span className="collection-action-label">{t(collected ? "discovery.remove" : "discovery.collect")}</span>
    </button>
  );
}
