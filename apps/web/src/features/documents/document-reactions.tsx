import { useEffect, useState } from "react";
import { Pin, Star } from "lucide-react";
import { api, type Resource } from "@web/shared/api.js";
import { HoverTip } from "@web/shared/components/hover-tip.js";
import { useI18n } from "@web/shared/i18n.js";

export type ReactionChange = {
  id: string;
  favorite?: boolean;
  pinned?: boolean;
  resource?: Pick<Resource, "id" | "title" | "kind" | "format" | "favorite" | "pinned">;
};

export function publishReaction(change: ReactionChange) {
  window.dispatchEvent(new CustomEvent<ReactionChange>("resource-reaction", { detail: change }));
}

export function DocumentReactionButtons({
  resource,
  size = 14,
  onChange,
  onError,
}: {
  resource: ReactionChange["resource"] & { id: string };
  size?: number;
  onChange?: (patch: { favorite?: boolean; pinned?: boolean }) => void;
  onError?: (message: string) => void;
}) {
  const { t } = useI18n();
  const [favorite, setFavorite] = useState(!!resource.favorite);
  const [pinned, setPinned] = useState(!!resource.pinned);
  useEffect(() => {
    setFavorite(!!resource.favorite);
    setPinned(!!resource.pinned);
  }, [resource.id, resource.favorite, resource.pinned]);
  function apply(patch: { favorite?: boolean; pinned?: boolean }) {
    if (patch.favorite !== undefined) setFavorite(patch.favorite);
    if (patch.pinned !== undefined) setPinned(patch.pinned);
    onChange?.(patch);
    publishReaction({
      id: resource.id,
      ...patch,
      resource: {
        id: resource.id,
        title: resource.title ?? "",
        kind: resource.kind ?? "document",
        format: resource.format ?? "rich_text",
        favorite: patch.favorite ?? favorite,
        pinned: patch.pinned ?? pinned,
      },
    });
  }
  async function toggle(kind: "pin" | "favorite") {
    const current = kind === "pin" ? pinned : favorite;
    const enabled = !current;
    const patch = kind === "pin" ? { pinned: enabled } : { favorite: enabled };
    const revert = kind === "pin" ? { pinned: current } : { favorite: current };
    apply(patch);
    try {
      await api(`/resources/${resource.id}/reaction`, "PUT", { kind, enabled });
    } catch (e) {
      apply(revert);
      onError?.((e as Error).message);
    }
  }
  const pinLabel = pinned ? t("nav.unpin") : t("nav.pin");
  const favoriteLabel = favorite ? t("doc.unfavorite") : t("doc.favorite");
  return (
    <span className="document-reaction-buttons">
      <HoverTip label={pinLabel}>
        <button
          type="button"
          className={`icon pin${pinned ? " enabled" : ""}`}
          aria-label={pinLabel}
          aria-pressed={pinned}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void toggle("pin");
          }}
        >
          <Pin size={size} fill={pinned ? "currentColor" : "none"} />
        </button>
      </HoverTip>
      <HoverTip label={favoriteLabel}>
        <button
          type="button"
          className={`icon favorite${favorite ? " enabled" : ""}`}
          aria-label={favoriteLabel}
          aria-pressed={favorite}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void toggle("favorite");
          }}
        >
          <Star size={size} fill={favorite ? "currentColor" : "none"} />
        </button>
      </HoverTip>
    </span>
  );
}
