import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { LibraryTree } from "../../src/library-tree";

export default function Library() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "知识库" });
  }, [navigation, title]);
  return <LibraryTree libraryId={id} />;
}
