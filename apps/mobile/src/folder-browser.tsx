import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import { useCallback, useRef, useState } from "react";
import { Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { Button, Dialog, FAB, List, Portal, Snackbar, Text, TextInput } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { api } from "./api";
import { useAuth } from "./auth";
import { Card, EmptyState, LoadingState, colors } from "./chrome";
import { fileSize } from "./format";
import { usePull } from "./query-cache";

type ParentType = "system" | "folder" | "document";
type Folder = {
  id: string;
  name: string;
  type: ParentType;
  virtual: boolean;
  locked: boolean;
  version: number;
};
type FileItem = {
  id: string;
  name: string;
  size: number;
  mime: string;
  locked: boolean;
  version: number;
};
type Preview =
  | { kind: "image" | "web" | "external"; uri: string; fileUri: string; name: string; mime: string }
  | { kind: "text"; name: string; text: string; mime: string };
type Page = { folders: Folder[]; files: FileItem[] };
type Row = ({ kind: "folder" } & Folder) | ({ kind: "file" } & FileItem);
type Prompt =
  | { kind: "create" }
  | { kind: "rename"; target: Row }
  | { kind: "delete"; target: Row };

function fileIcon(mime: string) {
  if (mime.startsWith("image/")) return "file-image";
  if (mime === "application/pdf") return "file-pdf-box";
  if (mime.startsWith("text/") || mime === "application/json") return "file-document-outline";
  if (mime.startsWith("video/")) return "file-video";
  if (mime.startsWith("audio/")) return "file-music";
  return "file-outline";
}

const systemFolders: Folder[] = [
  { id: "documents", name: "系统文件夹", type: "system", virtual: true, locked: true, version: 0 },
  { id: "ai", name: "AI助手", type: "system", virtual: true, locked: true, version: 0 },
  { id: "mail", name: "邮件", type: "system", virtual: true, locked: true, version: 0 },
  { id: "shared", name: "共享文件夹", type: "system", virtual: true, locked: true, version: 0 },
];

function previewKind(mime: string) {
  if (mime.startsWith("image/")) return "image" as const;
  if (mime === "application/pdf" || mime === "text/html" || mime.startsWith("video/") || mime.startsWith("audio/")) return "web" as const;
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml"))
    return "text" as const;
  return "external" as const;
}

function FileThumb({ id, origin, token }: { id: string; origin: string; token: string }) {
  const [full, setFull] = useState(false);
  return (
    <Image
      source={{
        uri: `${origin}/api/v1/files/items/${id}/content${full ? "" : "?variant=thumbnail"}`,
        headers: { Authorization: `Bearer ${token}` },
      }}
      style={styles.thumb}
      contentFit="cover"
      onError={() => {
        if (!full) setFull(true);
      }}
    />
  );
}

export function FolderBrowser({
  parentType,
  parentId,
}: {
  parentType: ParentType;
  parentId: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useQueryClient();
  const { session } = useAuth();
  const sheet = useRef<BottomSheetModal>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const writable = parentType !== "document";
  const query = useQuery({
    queryKey: ["files", session?.origin, parentType, parentId],
    enabled: !!session && !!parentId,
    queryFn: () => api<Page>(`/files?parentType=${parentType}&parentId=${encodeURIComponent(parentId)}`),
  });

  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["files", session?.origin, parentType, parentId] });
  }, [client, parentId, parentType, session?.origin]);
  const pull = usePull(refresh);

  const fail = (reason: unknown) => {
    setNotice(reason instanceof Error ? reason.message : "操作失败");
  };

  async function createFolder() {
    const next = name.trim();
    if (!next) return;
    setBusy(true);
    try {
      await api("/files/folders", {
        body: { name: next, parentId: parentType === "folder" ? parentId : null },
      });
      setPrompt(null);
      await refresh();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function rename(target: Row) {
    const next = name.trim();
    if (!next || next === target.name) {
      setPrompt(null);
      return;
    }
    setBusy(true);
    try {
      const path = target.kind === "folder" ? `/files/folders/${target.id}` : `/files/items/${target.id}`;
      await api(path, { method: "PATCH", body: { name: next, version: target.version } });
      setPrompt(null);
      await refresh();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: Row) {
    setBusy(true);
    try {
      const path = target.kind === "folder" ? `/files/folders/${target.id}` : `/files/items/${target.id}`;
      await api(path, { method: "DELETE", body: { version: target.version } });
      setPrompt(null);
      await refresh();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function upload(uri: string, filename: string) {
    if (!session) return;
    setBusy(true);
    sheet.current?.dismiss();
    try {
      const url =
        `${session.origin}/api/v1/files/items?parentType=${parentType}` +
        `&parentId=${encodeURIComponent(parentId)}&filename=${encodeURIComponent(filename)}`;
      const result = await FileSystem.uploadAsync(url, uri, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/octet-stream",
        },
      });
      if (result.status >= 400) {
        let message = "上传失败";
        try {
          message = JSON.parse(result.body).message ?? message;
        } catch {}
        throw new Error(message);
      }
      await refresh();
      setNotice("已上传");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  async function pickDocument() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    await upload(asset.uri, asset.name || "未命名文件");
  }

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNotice("需要相册权限才能选择图片");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    const filename = asset.fileName || `图片-${Date.now()}.jpg`;
    await upload(asset.uri, filename);
  }

  async function openFile(item: FileItem) {
    if (!session || !FileSystem.cacheDirectory) {
      setNotice("当前环境不能预览文件");
      return;
    }
    setBusy(true);
    try {
      const safe = item.name.replace(/[^\w.\u4e00-\u9fff-]+/g, "_");
      const destination = FileSystem.cacheDirectory + item.id + "-" + safe;
      const downloaded = await FileSystem.downloadAsync(
        `${session.origin}/api/v1/files/items/${item.id}/content`,
        destination,
        { headers: { Authorization: `Bearer ${session.token}` } },
      );
      const kind = previewKind(item.mime);
      if (kind === "text") {
        const text = await FileSystem.readAsStringAsync(downloaded.uri);
        setPreview({ kind, name: item.name, mime: item.mime, text: text.length > 20000 ? text.slice(0, 20000) + "\n…" : text });
        return;
      }
      const uri =
        kind === "web" && Platform.OS === "android"
          ? await FileSystem.getContentUriAsync(downloaded.uri).catch(() => downloaded.uri)
          : downloaded.uri;
      setPreviewFailed(false);
      setPreview({ kind, uri, fileUri: downloaded.uri, name: item.name, mime: item.mime });
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />,
    [],
  );

  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }
  const roots = parentType === "system" && parentId === "root" ? systemFolders : [];
  const rootIds = new Set(roots.map((item) => item.id));
  const rows: Row[] = [
    ...roots.map((item) => ({ kind: "folder" as const, ...item })),
    ...(query.data?.folders ?? [])
      .filter((item) => !rootIds.has(item.id))
      .map((item) => ({ kind: "folder" as const, ...item })),
    ...(query.data?.files ?? []).map((item) => ({ kind: "file" as const, ...item })),
  ];

  function openPrompt(next: Prompt) {
    sheet.current?.dismiss();
    setName(next.kind === "rename" ? next.target.name : "");
    setPrompt(next);
  }

  return (
    <View style={styles.page}>
      <FlashList
        data={rows}
        keyExtractor={(item) => `${item.kind}:${item.id}`}
        estimatedItemSize={76}
        contentContainerStyle={{ paddingBottom: writable ? 96 : 24 }}
        refreshControl={
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        ListEmptyComponent={<EmptyState title="这个文件夹是空的" detail={writable ? "点右下角可以新建文件夹或上传文件" : undefined} />}
        renderItem={({ item }) => {
          const actionable = item.kind === "folder" ? !item.virtual && !item.locked : !item.locked;
          const body = (
            <Card>
              <List.Item
                title={item.name}
                titleStyle={{ color: colors.ink }}
                descriptionStyle={{ color: colors.muted }}
                description={item.kind === "folder" ? "文件夹" : fileSize(item.size)}
                left={(props) =>
                  item.kind === "file" && item.mime.startsWith("image/") && session ? (
                    <View style={[props.style, styles.thumbWrap]}>
                      <FileThumb id={item.id} origin={session.origin} token={session.token} />
                    </View>
                  ) : (
                    <List.Icon {...props} color={colors.accent} icon={item.kind === "folder" ? "folder" : fileIcon(item.mime)} />
                  )
                }
                onPress={() => {
                  if (item.kind === "folder") {
                    router.push({
                      pathname: "/folder/[id]",
                      params: { id: item.id, title: item.name, parentType: item.type },
                    });
                    return;
                  }
                  void openFile(item);
                }}
              />
            </Card>
          );
          if (!actionable) return body;
          return (
            <Swipeable
              renderRightActions={() => (
                <View style={styles.swipe}>
                  <Pressable style={[styles.swipeButton, styles.rename]} onPress={() => openPrompt({ kind: "rename", target: item })}>
                    <Text style={styles.swipeText}>重命名</Text>
                  </Pressable>
                  <Pressable style={[styles.swipeButton, styles.remove]} onPress={() => openPrompt({ kind: "delete", target: item })}>
                    <Text style={[styles.swipeText, { color: "#fff" }]}>删除</Text>
                  </Pressable>
                </View>
              )}
            >
              {body}
            </Swipeable>
          );
        }}
      />
      {writable ? (
        <FAB icon="plus" style={styles.fab} color="#fff" loading={busy} onPress={() => sheet.current?.present()} />
      ) : null}
      <BottomSheetModal ref={sheet} snapPoints={["32%"]} enableDynamicSizing={false} backdropComponent={backdrop}>
        <BottomSheetView style={styles.sheet}>
          <Text variant="titleMedium" style={{ color: colors.ink }}>
            文件夹
          </Text>
          <Button mode="contained" icon="folder-plus" onPress={() => openPrompt({ kind: "create" })}>
            新建文件夹
          </Button>
          <Button mode="contained-tonal" icon="upload" onPress={() => void pickDocument()}>
            上传文件
          </Button>
          <Button mode="contained-tonal" icon="image" onPress={() => void pickImage()}>
            从相册选择
          </Button>
        </BottomSheetView>
      </BottomSheetModal>
      <Portal>
        <Dialog visible={!!prompt} onDismiss={() => setPrompt(null)}>
          <Dialog.Title>
            {prompt?.kind === "delete" ? "移到回收站" : prompt?.kind === "rename" ? "重命名" : "新建文件夹"}
          </Dialog.Title>
          <Dialog.Content>
            {prompt?.kind === "delete" ? (
              <Text>确定把「{prompt.target.name}」移到回收站？</Text>
            ) : (
              <TextInput mode="outlined" label="名称" value={name} onChangeText={setName} autoFocus />
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPrompt(null)}>取消</Button>
            <Button
              loading={busy}
              disabled={busy}
              onPress={() => {
                if (!prompt) return;
                if (prompt.kind === "create") void createFolder();
                else if (prompt.kind === "rename") void rename(prompt.target);
                else void remove(prompt.target);
              }}
            >
              确定
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <Modal visible={!!preview} animationType="slide" onRequestClose={() => setPreview(null)}>
        <View style={[styles.preview, { paddingTop: insets.top }]}>
          <View style={styles.previewBar}>
            <Text style={styles.previewTitle} numberOfLines={1}>
              {preview?.name}
            </Text>
            <Button onPress={() => { setPreview(null); setPreviewFailed(false); }}>关闭</Button>
          </View>
          {preview?.kind === "image" ? <Image source={{ uri: preview.uri }} style={styles.previewImage} contentFit="contain" /> : null}
          {preview?.kind === "web" ? (
            <View style={styles.previewWeb}>
              {previewFailed ? (
                <Text style={styles.previewText}>这个文件没法在应用内打开，可以用其他应用打开。</Text>
              ) : (
                <WebView
                  style={styles.previewWeb}
                  source={{ uri: preview.uri }}
                  originWhitelist={["*"]}
                  allowFileAccess
                  allowFileAccessFromFileURLs
                  allowUniversalAccessFromFileURLs
                  allowingReadAccessToURL={FileSystem.cacheDirectory ?? undefined}
                  allowsInlineMediaPlayback
                  onError={() => setPreviewFailed(true)}
                  onHttpError={() => setPreviewFailed(true)}
                />
              )}
              <Button
                mode="contained"
                buttonColor={colors.accent}
                style={styles.openExternal}
                onPress={() => void Sharing.shareAsync(preview.fileUri, { mimeType: preview.mime, dialogTitle: preview.name })}
              >
                用其他应用打开
              </Button>
            </View>
          ) : null}
          {preview?.kind === "text" ? (
            <ScrollView contentContainerStyle={styles.previewTextWrap}>
              <Text style={styles.previewText}>{preview.text}</Text>
            </ScrollView>
          ) : null}
          {preview?.kind === "external" ? (
            <View style={styles.previewTextWrap}>
              <Text style={styles.previewText}>这个格式在手机里不能直接排版，可以用其他应用打开。</Text>
              <Button
                mode="contained"
                buttonColor={colors.accent}
                onPress={() => void Sharing.shareAsync(preview.fileUri, { mimeType: preview.mime, dialogTitle: preview.name })}
              >
                用其他应用打开
              </Button>
            </View>
          ) : null}
        </View>
      </Modal>
      <Snackbar visible={!!notice} onDismiss={() => setNotice("")} duration={2800}>
        {notice}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  fab: { position: "absolute", right: 16, bottom: 16, backgroundColor: colors.accent },
  sheet: { padding: 20, gap: 12 },
  swipe: { flexDirection: "row", alignItems: "stretch", marginTop: 8, marginRight: 12 },
  swipeButton: { justifyContent: "center", paddingHorizontal: 16 },
  rename: { backgroundColor: colors.selected },
  remove: { backgroundColor: colors.danger, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  swipeText: { color: colors.ink, fontWeight: "600" },
  preview: { flex: 1, backgroundColor: colors.bg },
  previewBar: { flexDirection: "row", alignItems: "center", paddingLeft: 16 },
  previewTitle: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: "600" },
  previewImage: { flex: 1, width: "100%", backgroundColor: "#111" },
  previewWeb: { flex: 1, backgroundColor: "#fff" },
  openExternal: { margin: 12 },
  previewTextWrap: { padding: 16, gap: 12 },
  previewText: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  thumbWrap: { justifyContent: "center" },
  thumb: { width: 40, height: 40, borderRadius: 6, backgroundColor: colors.lineSoft },
});
