import type { DB } from "@db/index.js";

export type AttachmentPolicy = (
  db: DB,
  parentId: string,
  metadata: string | null | undefined,
) => Promise<boolean>;

export type KnowledgeMailPolicy = (scope: unknown, starred: number) => boolean;

const policyKey = Symbol.for("doca.plugin-policies");

function policyState(): {
  attachment?: AttachmentPolicy;
  knowledgeMail?: KnowledgeMailPolicy;
} {
  const host = globalThis as typeof globalThis & {
    [policyKey]?: {
      attachment?: AttachmentPolicy;
      knowledgeMail?: KnowledgeMailPolicy;
    };
  };
  return (host[policyKey] ??= {});
}

export function registerAttachmentPolicy(policy: AttachmentPolicy) {
  const state = policyState();
  const previous = state.attachment;
  state.attachment = policy;
  return () => {
    state.attachment = previous;
  };
}

export function registerKnowledgeMailPolicy(policy: KnowledgeMailPolicy) {
  const state = policyState();
  const previous = state.knowledgeMail;
  state.knowledgeMail = policy;
  return () => {
    state.knowledgeMail = previous;
  };
}

/** Files stay visible until an installed plugin narrows mail attachments. */
export async function mailAttachmentIncluded(
  db: DB,
  parentId: string,
  metadata: string | null | undefined,
) {
  const policy = policyState().attachment;
  return policy ? policy(db, parentId, metadata) : true;
}

/** Mail content stays eligible until the mail plugin installs its scope rule. */
export function mailKnowledgeIncluded(scope: unknown, starred: number) {
  const policy = policyState().knowledgeMail;
  return policy ? policy(scope, starred) : true;
}
