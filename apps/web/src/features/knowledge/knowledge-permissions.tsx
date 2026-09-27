import { PermissionDialog } from "@web/features/documents/permissions-panel.js";
import type { BotInfo } from "./knowledge-assistants.js";

export function KnowledgePermissionPanel({
  bot,
  close,
  saved,
}: {
  bot: BotInfo;
  close: () => void;
  saved: () => Promise<void>;
}) {
  return (
    <PermissionDialog
      detail={{ resource: { id: bot.id, kind: "assistant" } }}
      close={close}
      saved={saved}
      adapter={{
        basePath: `/knowledge/assistants/${bot.id}`,
        roles: ["reader", "manager"],
        publicRoles: ["reader"],
        requests: false,
        invitationNote: false,
      }}
    />
  );
}
