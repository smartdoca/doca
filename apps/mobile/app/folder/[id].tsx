import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { FolderBrowser } from "../../src/folder-browser";

export default function Folder() {
  const { id, title, parentType } = useLocalSearchParams<{ id: string; title?: string; parentType?: string }>();
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "文件夹" });
  }, [navigation, title]);
  const type = parentType === "system" || parentType === "document" ? parentType : "folder";
  return <FolderBrowser parentType={type} parentId={id} />;
}
