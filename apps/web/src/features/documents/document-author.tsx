import { useI18n } from "@web/shared/i18n.js";
import { UserBadge } from "@web/shared/components/user-badge.js";

/** Self labels use stable IDs, never a display-name comparison. */
export function DocumentAuthor({
  id,
  name,
  currentUserId,
}: {
  id: string;
  name?: string;
  currentUserId?: string;
}) {
  const { t } = useI18n();
  return id === currentUserId ? (
    <span className="document-author-self">{t("time.me")}</span>
  ) : (
    <UserBadge id={id} name={name} />
  );
}
