import * as FS from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { validateNativeRequest } from "@smartdoca/plugin-sdk/native";
import { loadSession, type Session } from "../session";

import { root, component, exclusive } from "./native-storage";
export async function handlePluginNativeRequest(
  value: unknown,
  session: Session,
  principalId: string,
  pluginId: string,
  signal: AbortSignal,
) {
  const request = validateNativeRequest(value, pluginId);
  async function authorized() {
    signal.throwIfAborted();
    const current = await loadSession();
    if (current?.origin !== session.origin || current.token !== session.token)
      throw new Error("Native session changed");
  }
  await authorized();
  const directory = `${root(session.origin)}users/${component(principalId)}/plugins/${component(pluginId)}/`;
  if (request.operation.startsWith("storage."))
    return exclusive(session.origin, async () => {
      await authorized();
      const exists = await FS.getInfoAsync(directory);
      const snapshots = exists.exists
        ? (await FS.readDirectoryAsync(directory))
            .filter((name) => /^cache-\d{16}\.json$/.test(name))
            .sort()
        : [];
      const latest = snapshots.at(-1);
      const entries: Record<string, string> = latest
        ? JSON.parse(await FS.readAsStringAsync(directory + latest))
        : {};
      const key = request.input.key!;
      if (request.operation === "storage.get")
        return Object.hasOwn(entries, key) ? entries[key] : null;
      if (request.operation === "storage.clear")
        for (const stored of Object.keys(entries)) delete entries[stored];
      if (request.operation === "storage.remove") delete entries[key];
      if (request.operation === "storage.set")
        Object.defineProperty(entries, key, {
          value: request.input.value!,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      const serialized = JSON.stringify(entries);
      if (serialized.length > 20_000_000)
        throw new Error("Plugin cache quota exceeded");
      await FS.makeDirectoryAsync(directory, { intermediates: true });
      const temporary = directory + "cache.pending";
      await FS.writeAsStringAsync(temporary, serialized);
      await authorized();
      const revision = latest ? Number(latest.slice(6, -5)) + 1 : 1;
      if (!Number.isSafeInteger(revision))
        throw new Error("Cache revision limit reached");
      const file =
        directory + `cache-${String(revision).padStart(16, "0")}.json`;
      // Publish to a new filename: iOS moveAsync deletes an existing destination before renaming.
      await FS.moveAsync({ from: temporary, to: file });
      await Promise.all(
        snapshots.map((name) =>
          FS.deleteAsync(directory + name, { idempotent: true }).catch(
            () => {},
          ),
        ),
      );
      return null;
    });
  if (!FS.cacheDirectory) throw new Error("Attachment storage unavailable");
  const { name, path, mime } = request.input;
  const response = await fetch(
    `${session.origin}/api/v1/plugins-mobile/attachment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pluginId, path, name, mime }),
      signal,
    },
  );
  if (!response.ok)
    throw new Error(`Attachment download failed (${response.status})`);
  const { base64 } = await response.json();
  if (
    typeof base64 !== "string" ||
    base64.length > 45_000_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error("Invalid attachment response");
  await authorized();
  const temporary = `${FS.cacheDirectory}plugin-attachment-${request.id}/`;
  const file = temporary + encodeURIComponent(name!);
  try {
    await FS.makeDirectoryAsync(temporary, { intermediates: true });
    await FS.writeAsStringAsync(file, base64, {
      encoding: FS.EncodingType.Base64,
    });
    await authorized();
    if (request.operation === "attachment.save" && Platform.OS === "android") {
      const permission =
        await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permission.granted) return { status: "canceled" };
      await authorized();
      const destination = await FS.StorageAccessFramework.createFileAsync(
        permission.directoryUri,
        name!,
        mime!,
      );
      try {
        await FS.writeAsStringAsync(destination, base64, {
          encoding: FS.EncodingType.Base64,
        });
      } catch (error) {
        await FS.deleteAsync(destination, { idempotent: true }).catch(() => {});
        throw error;
      }
      return { status: "completed" };
    }
    if (!(await Sharing.isAvailableAsync()))
      throw new Error("System sharing unavailable");
    await Sharing.shareAsync(file, { mimeType: mime, dialogTitle: name });
    // The OS share sheet does not report whether the user saved, shared or canceled.
    return { status: "presented" };
  } finally {
    await FS.deleteAsync(temporary, { idempotent: true });
  }
}
