import { z } from "zod";
import type { AIReference } from "@core/workflows/ai-documents.js";

const reference = z
  .object({
    resourceId: z.string(),
    label: z.string().optional(),
    format: z.string().optional(),
    description: z.string().optional(),
    anchor: z.unknown().optional(),
    epochId: z.string().optional(),
    seq: z.number().optional(),
  })
  .strict();
const attachment = z
  .object({
    id: z.string(),
    filename: z.string(),
    mime: z.string(),
    size: z.number().nonnegative(),
    sourceFileId: z.string().optional(),
    sourceName: z.string().optional(),
    extractStatus: z.enum(["pending", "ready", "failed"]).optional(),
    preview: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
const draftSchema = z
  .object({
    version: z.literal(1),
    segments: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), value: z.string() }).strict(),
        z.object({ type: z.literal("reference"), reference }).strict(),
      ]),
    ),
    attachments: z.array(attachment),
    folders: z.array(
      z
        .object({
          kind: z.literal("folder"),
          id: z.string(),
          name: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ComposerDraft = Omit<z.infer<typeof draftSchema>, "segments"> & {
  segments: (
    | { type: "text"; value: string }
    | { type: "reference"; reference: AIReference }
  )[];
};
export function composerDraftKey(userId: string, scope: string) {
  return `doca.ai.composer.v1:${encodeURIComponent(userId)}:${encodeURIComponent(scope)}`;
}
export function readComposerDraft(key: string): ComposerDraft | null {
  const value = localStorage.getItem(key);
  return value === null
    ? null
    : (draftSchema.parse(JSON.parse(value)) as ComposerDraft);
}
export function writeComposerDraft(key: string, draft: ComposerDraft) {
  draftSchema.parse(draft);
  if (
    !draft.attachments.length &&
    !draft.folders.length &&
    !draft.segments.some(
      (segment) => segment.type === "reference" || segment.value.length,
    )
  )
    localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(draft));
}
