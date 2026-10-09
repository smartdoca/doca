import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { Prompts, Welcome } from "@ant-design/x";
import "./assistant-profile.css";

export type AssistantProfileId =
  "personal";

export type AssistantCapabilities = {
  attachments: boolean;
  references: boolean;
  webSearch: boolean;
  modelPicker: boolean;
  approvals: boolean;
  feedback: boolean;
  humanTasks: boolean;
  sourceManagement: boolean;
  personalMemory: boolean;
};

export const ASSISTANT_PROFILES: Record<
  AssistantProfileId,
  { accent: string; capabilities: AssistantCapabilities }
> = {
  personal: {
    accent: "#7859b8",
    capabilities: {
      attachments: true,
      references: true,
      webSearch: true,
      modelPicker: true,
      approvals: true,
      feedback: false,
      humanTasks: false,
      sourceManagement: false,
      personalMemory: true,
    },
  },


};

const PROFILE_ICONS = {
  personal: Sparkles,

} satisfies Record<AssistantProfileId, typeof Sparkles>;

export function assistantProfileClass(profile: AssistantProfileId) {
  return `assistant-profile-${profile}`;
}

export function AssistantIdentity({
  profile,
  title,
  description,
  memoryLabel,
  compact = false,
}: {
  profile: AssistantProfileId;
  title: ReactNode;
  description?: ReactNode;
  memoryLabel?: ReactNode;
  compact?: boolean;
}) {
  const Icon = PROFILE_ICONS[profile];
  return (
    <div className={`assistant-identity ${compact ? "is-compact" : ""}`}>
      <span className="assistant-identity-mark" aria-hidden="true">
        <Icon size={compact ? 18 : 22} />
      </span>
      <div className="assistant-identity-copy">
        <strong>{title}</strong>
        {!compact && description && <small>{description}</small>}
      </div>
      {memoryLabel && (
        <span className="assistant-memory-badge">{memoryLabel}</span>
      )}
    </div>
  );
}

export type AssistantPrompt = {
  key: string;
  icon?: ReactNode;
  label: ReactNode;
  description: ReactNode;
};

export function AssistantWelcome({
  profile,
  title,
  description,
  items,
  vertical = false,
  large = false,
  onSelect,
}: {
  profile: AssistantProfileId;
  title: ReactNode;
  description: ReactNode;
  items: AssistantPrompt[];
  vertical?: boolean;
  large?: boolean;
  onSelect: (item: AssistantPrompt) => void;
}) {
  const Icon = PROFILE_ICONS[profile];
  return (
    <div className="ai-welcome assistant-welcome">
      <Welcome
        variant="borderless"
        icon={<Icon size={32} />}
        title={title}
        description={description}
        styles={{
          root: {
            flexDirection: "column",
            textAlign: "center",
            alignItems: "center",
            padding: 0,
          },
          title: { fontSize: large ? 28 : 21 },
          icon: { color: "var(--assistant-accent)" },
        }}
      />
      <Prompts
        className="ai-official-prompts assistant-official-prompts"
        items={items}
        vertical={vertical}
        wrap={!vertical}
        styles={{ item: { flex: vertical ? undefined : "1 1 40%" } }}
        onItemClick={({ data }) => onSelect(data as AssistantPrompt)}
      />
    </div>
  );
}
