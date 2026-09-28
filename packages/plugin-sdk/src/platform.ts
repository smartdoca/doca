import { defineService } from "./index.js";
import type { JsonObject, MaybePromise } from "@smartdoca/plugin-contracts";

export interface PluginPrincipal {
  readonly id: string;
  readonly displayName: string;
  readonly publicId: string;
  readonly admin: boolean;
}
export interface PluginRequestContext {
  readonly requestId: string;
  readonly principal: PluginPrincipal;
  readonly signal: AbortSignal;
}
export interface PluginUser extends PluginPrincipal {
  readonly login: string;
  readonly status: string;
  readonly createdAt: string;
  readonly profile: JsonObject;
  readonly profileRevision: number;
  readonly contacts: readonly { kind: string; value: string; verified: boolean }[];
}
export interface DirectoryUser {
  readonly id: string;
  readonly display_name: string;
  readonly public_id: string | null;
  readonly avatar: string | null;
  readonly avatar_asset_id: string | null;
}
export interface UsersServiceV1 {
  /** Trusted server task revalidation; does not grant access to business resources. */
  status(id: string): Promise<{ readonly id: string; readonly status: string } | null>;
  get(context: PluginRequestContext, id: string): Promise<PluginUser | null>;
  /** Trusted server-only inventory for initial reconciliation; never expose directly to browsers. */
  list(input?: { after?: string; limit?: number }): Promise<{ items: readonly PluginUser[]; cursor: string | null }>;
  search(context: PluginRequestContext, query: string): Promise<readonly DirectoryUser[]>;
}
export interface PluginResource {
  readonly pluginId: string;
  readonly type: string;
  readonly id: string;
}
export interface PermissionSource {
  readonly pluginId: string;
  readonly resourceType: string;
  authorize(principalId: string, resourceId: string, action: string): Promise<boolean>;
}
export interface DirectoryRelation {
  readonly userId: string;
  readonly relationId: string;
  readonly revision: string;
}
export interface DirectorySource {
  readonly id: string;
  readonly schemaVersion: 1;
  /** Indexed current relations from the plugin's own database. */
  related(principalId: string, input: { cursor: string | null; limit: number; signal: AbortSignal }): Promise<{ items: readonly DirectoryRelation[]; cursor: string | null }>;
  /** Recheck candidates against current sharing, returning only still-visible user IDs. */
  verify(principalId: string, candidates: readonly DirectoryRelation[], signal: AbortSignal): Promise<readonly string[]>;
}
export interface PermissionsServiceV1 {
  register(source: PermissionSource): () => void;
  registerDirectory(source: DirectorySource): () => void;
  authorize(context: PluginRequestContext, resource: PluginResource, action: string): Promise<boolean>;
}
export interface PluginHttpRequest extends PluginRequestContext {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
}
export interface PluginHttpResponse {
  status(code: number): PluginHttpResponse;
  header(name: string, value: string | readonly string[]): PluginHttpResponse;
  redirect(location: string, code?: 302 | 303 | 307 | 308): void;
}
export type PluginExternalRequest = Omit<PluginHttpRequest, "principal"> & { readonly principal: null };
interface PluginRouteBase {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /** Defaults to 1 MiB. Trusted plugins may explicitly request up to 32 MiB. */
  readonly bodyLimit?: number;
  readonly schema?: { readonly body?: JsonObject; readonly querystring?: JsonObject; readonly params?: JsonObject };
}
export type PluginRoute = PluginRouteBase & ({
  readonly auth?: "session";
  readonly admin?: boolean;
  handle(request: PluginHttpRequest, response: PluginHttpResponse): MaybePromise<unknown>;
} | {
  readonly auth: "external";
  /** Verify OAuth state or webhook signature. No host session is implied. */
  verify(request: PluginExternalRequest): MaybePromise<boolean>;
  handle(request: PluginExternalRequest, response: PluginHttpResponse): MaybePromise<unknown>;
});
export interface HttpServiceV1 {
  /** Trusted deployment origin, never constructed from request headers. */
  callbackUrl(pluginId: string, path: string): string;
  /** External routes must explicitly verify their external identity. */
  register(pluginId: string, routes: readonly PluginRoute[]): Promise<() => Promise<void>>;
}
export interface OperationPolicy {
  readonly id: string;
  check(input: { readonly principalId: string; readonly action: string; readonly facts: JsonObject }): Promise<void>;
}
export interface PoliciesServiceV1 {
  register(policy: OperationPolicy): () => void;
  check(principalId: string, action: string, facts?: JsonObject): Promise<void>;
}
export const usersServiceToken = defineService<UsersServiceV1>("users.v1");
export const permissionsServiceToken = defineService<PermissionsServiceV1>("permissions.v1");
export const httpServiceToken = defineService<HttpServiceV1>("http.v1");
export const policiesServiceToken = defineService<PoliciesServiceV1>("policies.v1");

export interface PluginIntegrationEvent {
  readonly sequence: number;
  readonly id: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly createdAt: string;
}
export interface EventsServiceV1 {
  /** Durable ordered stream. Persist the last processed sequence in the plugin data store. */
  read(after: number, limit?: number): Promise<readonly PluginIntegrationEvent[]>;
}
export const eventsServiceToken = defineService<EventsServiceV1>("events.v1");

export interface PluginNotificationInput {
  readonly recipientId: string;
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** Local application route, e.g. /mail/inbox?message=123. No origin or hash. */
  readonly path: string;
  readonly resource: { readonly type: string; readonly id: string };
}
export interface NotificationsServiceV1 {
  publish(pluginId: string, input: PluginNotificationInput): Promise<{ id: string }>;
  withdraw(pluginId: string, input: { recipientId: string; key: string }): Promise<void>;
}
export const notificationsServiceToken = defineService<NotificationsServiceV1>("notifications.v1");
