import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { RefreshControl, View } from "react-native";
import { List } from "react-native-paper";
import { api, formatLabel, type Resource } from "./api";
import { useAuth } from "./auth";
import { Card, EmptyState, LoadingState, colors } from "./chrome";
import { relativeTime } from "./format";
import { usePull } from "./query-cache";

const formatIcon: Record<Resource["format"], string> = {
  rich_text: "file-document-outline",
  markdown: "language-markdown",
  spreadsheet: "table",
  presentation: "presentation",
  canvas: "draw",
};

export function ResourceList({
  params,
  empty,
}: {
  params: Record<string, string>;
  empty: string;
}) {
  const router = useRouter();
  const { session } = useAuth();
  const queryText = new URLSearchParams(params).toString();
  type ResourcePage = {
    items: Resource[];
    nextCursor?: string | null;
    nextOffset: number | null;
  };
  const query = useInfiniteQuery({
    queryKey: ["resources", session?.origin, queryText],
    enabled: !!session,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<ResourcePage>(
        `/resources?${queryText}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const pull = usePull(() => query.refetch());
  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <FlashList
      data={items}
      estimatedItemSize={84}
      contentContainerStyle={{ paddingBottom: 24 }}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage)
          void query.fetchNextPage();
      }}
      refreshControl={
        <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
      ListEmptyComponent={<EmptyState title={empty} />}
      renderItem={({ item }) => (
        <Card>
          <List.Item
            title={item.title || "未命名"}
            titleStyle={{ color: colors.ink }}
            descriptionStyle={{ color: colors.muted }}
            description={
              item.kind === "library"
                ? `知识库 · ${relativeTime(item.updated_at)}`
                : `${formatLabel[item.format]} · ${relativeTime(
                    params.sort === "visited_at" ? item.visited_at || item.updated_at : item.updated_at,
                  )}`
            }
            left={(props) => (
              <List.Icon {...props} color={colors.accent} icon={item.kind === "library" ? "bookshelf" : formatIcon[item.format]} />
            )}
            onPress={() => {
              if (item.kind === "library") {
                router.push({ pathname: "/library/[id]", params: { id: item.id, title: item.title } });
                return;
              }
              router.push({ pathname: "/document/[id]", params: { id: item.id, title: item.title } });
            }}
          />
        </Card>
      )}
    />
    </View>
  );
}
