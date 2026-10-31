import { useEffect, useId, useRef, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Popover } from "antd";
import { ownsControlledPopup } from "@web/shared/components/popup-ownership.js";

type MemberPage = {
  items: {
    id: string;
    display_name: string;
    public_id: string | null;
    avatar: string | null;
    avatar_asset_id: string | null;
  }[];
  total: number;
  nextCursor: string | null;
};
const previewSize = 3;
export function GroupGrantMembers({
  basePath,
  groupId,
  revision,
}: {
  basePath: string;
  groupId: string;
  revision: number;
}) {
  const { t } = useI18n();
  const listId = useId();
  const preview = useRef<HTMLDivElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const [page, setPage] = useState<MemberPage>(),
    [expanded, setExpanded] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const endpoint = `${basePath}/group-grants/${groupId}/members`;
  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPage(undefined);
    setExpanded(false);
    setLoading(true);
    setError("");
    void api<MemberPage>(
      `${endpoint}?limit=${previewSize}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setPage)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => request.current?.abort();
  }, [endpoint, revision, retry]);
  async function more() {
    if (!page || loading) return;
    if (expanded && !page.nextCursor) return;
    const cursor = expanded ? page.nextCursor : null;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await api<MemberPage>(
        cursor ? `${endpoint}?cursor=${encodeURIComponent(cursor)}` : endpoint,
        "GET",
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPage((current) => ({
          ...next,
          items: cursor
            ? [...(current?.items ?? []), ...next.items]
            : next.items,
        }));
        setExpanded(true);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (
        (e as { status?: number }).status === 403 ||
        (e as { status?: number }).status === 404
      )
        setPage(undefined);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (
        preview.current?.contains(target) ||
        popup.current?.contains(target) ||
        ownsControlledPopup(target, [preview.current, popup.current])
      )
        return;
      closeMore();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  const avatar = (member: MemberPage["items"][number]) => (
    <span className="group-grant-member" key={member.id}>
      <UserBadge id={member.id} name={member.display_name} avatarOnly />
    </span>
  );
  function closeMore() {
    request.current?.abort();
    setLoading(false);
    setExpanded(false);
  }
  return (
    <div
      ref={preview}
      className="group-grant-members"
      aria-label={t("groups.members")}
    >
      {error && <Feedback tone="error" message={error} />}
      <div className="group-grant-member-list" id={listId}>
        {page?.items.slice(0, previewSize).map(avatar)}
      </div>
      {loading && !page && (
        <span className="group-member-loading" role="status">
          {t("groups.membersLoading")}
        </span>
      )}
      {page?.total === 0 && (
        <span className="group-member-loading">{t("groups.noMembers")}</span>
      )}
      {error && !page && (
        <button
          type="button"
          className="group-members-more"
          disabled={loading}
          onClick={() => setRetry((value) => value + 1)}
        >
          {t("groups.retryMembers")}
        </button>
      )}
      {page && page.total > previewSize && (
        <Popover
          open={expanded}
          trigger={[]}
          placement="bottomLeft"
          destroyOnHidden
          autoAdjustOverflow
          content={
            <div
              ref={popup}
              className="group-grant-member-panel"
              data-permissions-popup="true"
              aria-label={t("groups.members")}
              id={`${listId}-all`}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  closeMore();
                }
              }}
            >
              <div className="group-grant-avatar-grid">
                {page.items.map(avatar)}
              </div>
              {page.nextCursor && (
                <button
                  type="button"
                  className="group-members-more"
                  disabled={loading}
                  onClick={() => void more()}
                >
                  {loading ? t("groups.membersLoading") : t("common.more")}
                </button>
              )}
            </div>
          }
        >
          <button
            type="button"
            className="group-members-more"
            disabled={loading}
            onClick={() => {
              if (expanded) closeMore();
              else void more();
            }}
            aria-expanded={expanded}
            aria-controls={expanded ? `${listId}-all` : listId}
            onKeyDown={(event) => {
              if (event.key === "Escape" && expanded) {
                event.stopPropagation();
                closeMore();
              }
            }}
          >
            {loading
              ? t("groups.membersLoading")
              : expanded
                ? t("groups.collapseMembers")
                : t("groups.moreMembers", { count: page.total - previewSize })}
          </button>
        </Popover>
      )}
    </div>
  );
}
