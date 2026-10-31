import { Users } from "lucide-react";
export function GroupAvatar({
  name,
  avatar,
}: {
  name: string;
  avatar: string | null;
}) {
  return (
    <span className="group-avatar">
      {avatar ? (
        <img src={avatar} alt="" />
      ) : (
        <Users size={25} aria-label={name} />
      )}
    </span>
  );
}
