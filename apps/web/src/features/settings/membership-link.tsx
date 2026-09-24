import { useState } from "react";
import { api, type Me } from "@web/shared/api.js";
import { MembershipIcon } from "@web/features/settings/membership-icon.js";

export function MembershipLink({
  vip,
  onError,
}: {
  vip: NonNullable<Me["entitlements"]>["vip"] | undefined;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!vip?.enabled) return null;
  return (
    <button
      type="button"
      className="membership-center-link"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await api<{ url: string }>(
            "/me/membership-link",
            "POST",
          );
          location.assign(result.url);
        } catch (e) {
          onError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <MembershipIcon icon={vip.icon} />
      <span>{vip.label}</span>
    </button>
  );
}
