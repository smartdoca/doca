import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { ResourceList } from "../../src/resource-list";

export default function Library() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "知识库" });
  }, [navigation, title]);
  return (
    <ResourceList
      params={{ scope: "all", libraryId: id, tree: "true" }}
      empty="这个知识库还没有文档"
    />
  );
}
