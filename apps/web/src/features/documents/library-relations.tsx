import { useEffect, useState } from "react";
import { Alert, Button, Card, Empty, Input, Modal, Space, Tag } from "antd";
import { api, roleRank, type Detail } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { SourcePicker } from "@web/features/knowledge/knowledge-source-picker.js";
import type { JsonObject } from "@smartdoca/plugin-sdk";

type Subscription = {
  id: string;
  name: string;
  sourceTitle: string;
  sourceKind: string;
  sourceId: string;
  status: string;
  url: string;
  groupId: string | null;
  canEdit: boolean;
  creator: { displayName: string };
};
type SourceGroup = {
  id: string;
  title: string;
  source_kind: string;
  config: string;
};
/** Editable libraries retain native subscriptions and grouped source management. */
export function LibrarySystemPage({
  detail,
}: {
  detail: Detail;
  changed: () => Promise<void>;
}) {
  const { t, locale } = useI18n(),
    id = detail.resource.id,
    canManage = roleRank(detail.resource.role) >= 4;
  const [items, setItems] = useState<Subscription[]>([]),
    [groups, setGroups] = useState<SourceGroup[]>([]),
    [editing, setEditing] = useState<SourceGroup | "new" | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const load = async () => {
    const value = await api<{ items: Subscription[]; groups: SourceGroup[] }>(
      `/knowledge/libraries/${id}/subscriptions`,
    );
    setItems(value.items);
    setGroups(value.groups);
  };
  useEffect(() => {
    if (canManage) void load().catch((e) => setError(e.message));
  }, [id, canManage]);
  const perform = async (
    path: string,
    method: "POST" | "PUT" | "DELETE",
    payload?: unknown,
  ) => {
    setBusy(true);
    setError("");
    try {
      await api(path, method, payload);
      await load();
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const members =
    typeof editing === "object" && editing
      ? items.filter(
          (item) => item.groupId === editing.id && item.status !== "detached",
        )
      : [];
  const configuration =
    editing && editing !== "new" && editing.source_kind === "content"
      ? (JSON.parse(editing.config) as { sourceId: string; config: JsonObject })
      : null;
  const groupedIds = new Set(
    items
      .filter((item) => item.groupId && item.status !== "detached")
      .map((item) => item.groupId),
  );
  const cards = [
    ...groups
      .filter((group) => groupedIds.has(group.id))
      .map((group) => ({
        group,
        members: items.filter(
          (item) => item.groupId === group.id && item.status !== "detached",
        ),
        title: group.title,
      })),
    ...items
      .filter((item) => !item.groupId && item.status !== "detached")
      .map((item) => ({
        group: null,
        members: [item],
        title: item.name || item.sourceTitle || t("books.restrictedSource"),
      })),
  ].filter(
    (card) =>
      !query ||
      card.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="knowledge-books-page">
      <Space>
        <Button
          disabled={!canManage}
          type="primary"
          onClick={() => setEditing("new")}
        >
          {t("books.addSource")}
        </Button>
        <a href="#/knowledge-books">{t("books.title")}</a>
      </Space>
      {error && <Alert type="error" message={error} />}
      <Input.Search
        allowClear
        placeholder={t("books.searchSources")}
        onChange={(e) => setQuery(e.target.value)}
        style={{ maxWidth: 360, display: "block", marginTop: 16 }}
      />
      <div className="book-cards">
        {cards.map((card) => (
          <Card
            key={card.group?.id || card.members[0]!.id}
            title={<span title={card.title}>{card.title}</span>}
            extra={
              card.group && card.members.every((item) => item.canEdit) ? (
                <Button onClick={() => setEditing(card.group)}>
                  {t("books.edit")}
                </Button>
              ) : undefined
            }
          >
            {card.members.map((item) => (
              <div key={item.id}>
                <Space>
                  <Tag>
                    {item.sourceKind === "content"
                      ? t("books.source.content")
                      : t(
                          `books.source.${item.sourceKind}` as Parameters<
                            typeof t
                          >[0],
                        )}
                  </Tag>
                  <Tag>
                    {t(
                      `library.status.${item.status}` as Parameters<
                        typeof t
                      >[0],
                    )}
                  </Tag>
                </Space>
                <p>{item.sourceTitle || item.name}</p>
                <p>{item.creator.displayName}</p>
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.url}
                  </a>
                )}
                <Space>
                  {item.status === "pending" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          `/knowledge/libraries/${id}/subscriptions/${item.id}/confirm`,
                          "POST",
                        )
                      }
                    >
                      {t("books.active")}
                    </Button>
                  )}
                  <Button
                    disabled={busy}
                    danger
                    onClick={() =>
                      void perform(
                        `/knowledge/libraries/${id}/subscriptions/${item.id}/detach`,
                        "POST",
                      )
                    }
                  >
                    {t("books.remove")}
                  </Button>
                </Space>
              </div>
            ))}
            {card.group && (
              <Button
                danger
                disabled={busy}
                onClick={() =>
                  void perform(
                    `/knowledge/libraries/${id}/source-groups/${card.group!.id}`,
                    "DELETE",
                  )
                }
              >
                {t("books.removeGroup")}
              </Button>
            )}
          </Card>
        ))}
      </div>
      {!cards.length && <Empty description={t("books.empty")} />}
      <Modal
        open={!!editing}
        title={t(editing === "new" ? "books.addSource" : "books.edit")}
        onCancel={() => setEditing(null)}
        footer={null}
        width={680}
        destroyOnHidden
      >
        {editing && (
          <SourcePicker
            key={editing === "new" ? "new" : editing.id}
            libraryId={id}
            locale={locale}
            busy={busy}
            initial={
              editing === "new" || configuration
                ? undefined
                : {
                    sourceKind: editing.source_kind,
                    title: editing.title,
                    sourceIds: members
                      .map((item) => item.sourceId)
                      .filter(Boolean),
                    urls: members.map((item) => item.url).filter(Boolean),
                  }
            }
            contentInitial={
              configuration && editing !== "new"
                ? {
                    groupId: editing.id,
                    sourceId: configuration.sourceId,
                    title: editing.title,
                    config: configuration.config,
                  }
                : undefined
            }
            contentAdded={() => {
              void load()
                .then(() => setEditing(null))
                .catch((e) => setError(e.message));
            }}
            bind={(sourceKind, sourceIds, urls, title) => {
              const payload = {
                title,
                ...(sourceKind === "url" ? { urls } : { sourceIds }),
              };
              void perform(
                editing === "new"
                  ? `/knowledge/libraries/${id}/subscriptions`
                  : `/knowledge/libraries/${id}/source-groups/${editing.id}`,
                editing === "new" ? "POST" : "PUT",
                editing === "new" ? { ...payload, sourceKind } : payload,
              );
            }}
          />
        )}
      </Modal>
    </section>
  );
}
