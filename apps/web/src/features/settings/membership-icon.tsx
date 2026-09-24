import { Crown, Gem, Medal, Star, UserRound } from "lucide-react";
import { membershipIcons } from "@core/modules/entitlements/icons.js";
export { membershipIcons };
export function MembershipIcon({
  icon,
  className = "",
}: {
  icon?: string;
  className?: string;
}) {
  const item = membershipIcons.find((i) => i.id === icon);
  if (!item) return null;
  const Icon = {
    crown: Crown,
    diamond: Gem,
    medal: Medal,
    star: Star,
    user: UserRound,
  }[item.symbol];
  return (
    <span
      className={`membership-icon membership-icon--${item.set} ${className}`}
      style={{
        color: item.set === "crystal" ? "#fff" : item.color,
        background:
          item.set === "crystal"
            ? `linear-gradient(145deg, ${item.color}, ${item.color}b3)`
            : item.background,
      }}
      aria-hidden="true"
    >
      <Icon size={16} strokeWidth={2.4} />
    </span>
  );
}
