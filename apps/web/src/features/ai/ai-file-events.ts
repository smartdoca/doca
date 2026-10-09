export const aiSessionFilesChanged = "doca-ai-session-files-changed";
export type AISessionFilesChange = {
  sessionId: string;
  title?: string;
  deleted?: boolean;
};

export function notifyAISessionFilesChanged(change: AISessionFilesChange) {
  window.dispatchEvent(
    new CustomEvent(aiSessionFilesChanged, { detail: change }),
  );
}
