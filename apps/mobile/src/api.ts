import { loadSession, removeAccount, type Session } from "./session";
import { apiErrorMessage } from "./system-errors";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Options = {
  method?: string;
  body?: unknown;
  session?: Session | null;
  raw?: BodyInit;
  contentType?: string;
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const session = options.session === undefined ? await loadSession() : options.session;
  if (!session) throw new ApiError(401, "请先登录");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${session.token}`,
  };
  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    if (options.contentType) headers["content-type"] = options.contentType;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(session.origin + "/api/v1" + path, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (response.status === 401) {
    await removeAccount(session.origin);
    onUnauthorized?.();
  }
  if (!response.ok) throw new ApiError(response.status, apiErrorMessage(data.message ?? "请求失败"));
  return data as T;
}

export async function login(origin: string, loginName: string, password: string) {
  const response = await fetch(origin + "/api/v1/auth/login", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-doca-client": "mobile",
    },
    body: JSON.stringify({ login: loginName, password }),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, apiErrorMessage(data.message ?? "登录失败"));
  if (data.status === "pending") throw new ApiError(403, "注册申请等待管理员审核");
  if (!data.sessionToken) throw new ApiError(500, "服务端没有返回移动会话");
  return {
    token: String(data.sessionToken),
    name: String(data.user?.display_name ?? loginName),
  };
}

export async function confirmQrLogin(account: Session, code: string) {
  const response = await fetch(`${account.origin}/api/v1/auth/qr/${code}/confirm`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${account.token}`,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(response.status, apiErrorMessage(data.message ?? "确认登录失败"));
}

export function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0;
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

export type Resource = {
  id: string;
  kind: "document" | "library";
  format: "rich_text" | "spreadsheet" | "presentation" | "markdown" | "canvas";
  title: string;
  version: number;
  role: string;
  updated_at: string;
  visited_at?: string | null;
  library_id: string | null;
  parent_id: string | null;
};

export const formatLabel: Record<Resource["format"], string> = {
  rich_text: "富文本",
  markdown: "Markdown",
  spreadsheet: "表格",
  presentation: "演示",
  canvas: "画布",
};
