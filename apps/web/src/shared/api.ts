export interface User {
  public_id?: string;
  id: string;
  display_name: string;
  admin: boolean;
}
export interface Bootstrap {
  needsProfile?: boolean;
  forcedLoginMethod?: string | null;
  authOptions?: {
    passwordEnabled: boolean;
    smsEnabled: boolean;
    recoveryEnabled: boolean;
  };
  siteName: string;
  registrationEnabled: boolean;
  initialized: boolean;
  user: User | null;
  capabilities: Record<string, boolean>;
}
export interface Resource {
  last_editor_id?: string | null;
  cover_asset_id?: string | null;
  page_width?: string | null;
  id: string;
  kind: "document" | "library";
  format: "rich_text" | "spreadsheet" | "presentation" | "markdown" | "canvas";
  title: string;
  owner_id: string;
  library_id: string | null;
  parent_id: string | null;
  tree_order?: number;
  version: number;
  role: string;
  access_mode: "inherit" | "custom";
  visibility: "invited" | "authenticated" | "public";
  requests_enabled?: number;
  history_readers?: number;
  discoverable?: number;
  entry_state?: "joined" | "hidden" | null;
  updated_at: string;
  created_at: string;
  visited_at?: string | null;
  favorite?: boolean;
  pinned?: boolean;
  ownerName?: string;
  libraryName?: string | null;
  inLibrary?: boolean;
  deleted_at: string | null;
}
export interface Preferences {
  avatar_asset_id?: string | null;
  avatar: string;
  theme: "light" | "soft";
  density: "comfortable" | "compact";
  default_sort: string;
  sort_order: string;
  version: number;
}
export interface Me {
  profileName?: string;
  fields?:import("@core/modules/identity/field-policy.js").UserFields;
  needsProfile?: boolean;
  editable?: { displayName: boolean; avatar: boolean };
  avatarUrl?: string;
  entitlements?: {
    can: Record<string, boolean>;
    level?: { id: string; name: string; color?: string; icon?: string };
    expiresAt?: string | null;
    vip?: { enabled: boolean; label: string; icon: string } | null;
  };
  user: User;
  preferences: Preferences;
}
export interface Comment {
  body_json?: string | null;
  anchor?: string | null;
  id: string;
  body: string;
  parent_id: string | null;
  author_id: string;
  display_name: string;
  resolved: number;
  version: number;
  created_at: string;
  deleted_at: string | null;
}
export interface Detail {
  editorSchemaVersion?: number;
  lastEditorName: string | null;
  lastEditedAt: string | null;
  resource: Resource;
  ownerName: string;
  comments: Comment[];
  commentsNextOffset?: number | null;
  likes: number;
  liked: boolean;
  favorite: boolean;
  pinned: boolean;
  grants: { user_id: string; role: string; state?: string | null }[];
}
export type FileParentType = "system" | "folder" | "document";
export interface FileFolder {
  id: string;
  parent_id: string | null;
  name: string;
  type: FileParentType;
  icon?: "sparkles" | "files" | "share";
  virtual: boolean;
  locked: boolean;
  version: number;
  created_at?: string;
  updated_at?: string;
}
export interface FileItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  locked: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  ai_description?: string | null;
  ai_status?: string;
  extract_status?: string | null;
  preview_url: string;
}
export interface FileInfo extends FileItem {
  owner_id: string;
  parent_type: FileParentType;
  parent_id: string;
  storage_object_id: string;
  metadata: Record<string, unknown>;
  ai_description_override?: string | null;
  storage: {
    profile_id: string;
    object_key: string;
    sha256: string;
    ai_description?: string | null;
    ai_status?: string;
    ai_model?: string | null;
    ai_generated_at?: string | null;
    created_at: string;
  };
}
export interface FilePage {
  parent: { type: FileParentType; id: string };
  folders: FileFolder[];
  files: FileItem[];
}
export interface Page {
  items: Resource[];
  total: number;
  nextOffset: number | null;
}
let lastAccount: string | null | undefined;
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    signal,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.headers.get("X-Doca-Profile-Required") === "1")
      window.dispatchEvent(new Event("profile-required"));
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw Object.assign(new Error(data.message ?? "请求失败"), {
      status: response.status,
      payload: data,
    });
  }
  if (path === "/bootstrap" && lastAccount !== (data.user?.id ?? null)) {
    lastAccount = data.user?.id ?? null;
    window.dispatchEvent(new Event("entitlements-updated"));
  }
  return data;
}
export const roleRank = (role: string) =>
  ({ none: 0, reader: 1, commenter: 2, editor: 3, manager: 4, owner: 5 })[
    role
  ] ?? 0;

export const assetUrl = (id: string) =>
  `/api/v1/assets/${encodeURIComponent(id)}/content`;
export const fileUrl = (id: string, download = false) =>
  `/api/v1/files/items/${encodeURIComponent(id)}/content${download ? "?download=1" : ""}`;
export const MAX_ASSET_UPLOAD_BYTES = 20 * 1024 * 1024;
export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
};
export async function uploadFile(
  file: File,
  purpose: "avatar" | "cover" | "attachment" | "comment_image" | "ai_attachment" | "note_attachment",
  resourceId?: string,
  signal?: AbortSignal,
  onProgress?: (progress: UploadProgress) => void,
) {
  const limit = (["attachment", "ai_attachment", "note_attachment"].includes(purpose)
    ? 20
    : 5) * 1024 * 1024;
  if (!file.size || file.size > limit)
    throw new Error(`请选择非空且不超过 ${limit / 1024 / 1024}MB 的文件`);
  const query = new URLSearchParams({
    purpose,
    filename: file.name,
    ...(resourceId ? { resourceId } : {}),
  });
  const url = "/api/v1/assets?" + query;
  const finish = (data: any, status: number, profileRequired?: string | null) => {
    if (profileRequired === "1")
      window.dispatchEvent(new Event("profile-required"));
    if (status === 401) window.dispatchEvent(new Event("session-expired"));
    if (status < 200 || status >= 300) throw new Error(data?.message || "上传失败");
    return data as {
      id: string;
      url: string;
      filename: string;
      size: number;
      mime: string;
      extractStatus?: "pending" | "ready" | "failed";
    };
  };
  if (!onProgress) {
    const res = await fetch(url, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    return finish(await res.json(), res.status, res.headers.get("X-Doca-Profile-Required"));
  }
  return await new Promise<{
    id: string;
    url: string;
    filename: string;
    size: number;
    mime: string;
    extractStatus?: "pending" | "ready" | "failed";
  }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      if (!settled) xhr.abort();
    };
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      onProgress({
        loaded: Math.min(event.loaded, total),
        total,
        percent: total ? Math.round((event.loaded / total) * 100) : 0,
      });
    };
    xhr.onload = () => {
      settled = true;
      cleanup();
      try {
        const data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        resolve(finish(data, xhr.status, xhr.getResponseHeader("X-Doca-Profile-Required")));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => {
      settled = true;
      cleanup();
      reject(new Error("上传失败，请检查网络连接"));
    };
    xhr.onabort = () => {
      settled = true;
      cleanup();
      reject(new DOMException("上传已取消", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    xhr.send(file);
  });
}
