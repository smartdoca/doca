import { api, type Bootstrap } from "./api.js";
import { startupIdentityRevision } from "./document-startup-cache.js";

// Live branding stays outside the existing persisted document-startup record.
type LiveBootstrap = Bootstrap & { siteLogoUrl: string | null };
let pending: Promise<LiveBootstrap> | undefined;
let loaded: LiveBootstrap | undefined;
let loadedIdentityRevision: number | undefined;
/** Share the live startup request between plugin discovery and the application. */
export function loadBootstrap(refresh = false): Promise<LiveBootstrap> {
  if (
    !refresh &&
    loaded &&
    loadedIdentityRevision === startupIdentityRevision()
  )
    return Promise.resolve(loaded);
  if (!pending) {
    pending = api<LiveBootstrap>(
      "/bootstrap",
      "GET",
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((value) => {
        loaded = value;
        loadedIdentityRevision = startupIdentityRevision();
        return value;
      })
      .finally(() => {
        pending = undefined;
      });
  }
  return pending;
}
