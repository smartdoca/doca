import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MessageKey, MessageValues } from "@doca/i18n";
import { openAiHref, openDocument } from "./ai-open";
import {
  aiEventDetail,
  aiEventLabel,
  type MobileAIProgressEvent,
} from "./ai-progress-label";
import { colors } from "./chrome";
import { useI18n } from "./locale";

type Nav = {
  push: (
    path: string | { pathname: string; params?: Record<string, string> },
  ) => void;
};

export type TraceEvent = MobileAIProgressEvent;

export type TraceOperation = {
  id: string;
  job_id: string;
  result?: {
    id?: string;
    resourceId?: string;
    title?: string;
    name?: string;
    format?: string;
    kind?: string;
    href?: string;
    path?: string;
    shared?: boolean;
    mime?: string;
  };
};

export type DeliveryCard = {
  key: string;
  kind: "library" | "document" | "file" | "image" | "folder" | "shared_folder";
  eyebrow: string;
  title: string;
  href?: string;
  documentId?: string;
};

type Translator = (key: MessageKey, values?: MessageValues) => string;

export function deliveryCards(
  events: TraceEvent[],
  operations: TraceOperation[],
  t: Translator,
): DeliveryCard[] {
  const cards: DeliveryCard[] = [];
  const seen = new Set<string>();
  const add = (card: DeliveryCard) => {
    if (seen.has(card.key)) return;
    seen.add(card.key);
    cards.push(card);
  };
  for (const event of events) {
    if (event.folder) {
      add({
        key: `folder:${event.folder.id}`,
        kind: event.folder.shared ? "shared_folder" : "folder",
        eyebrow: event.folder.shared
          ? t("mobile.ai.delivery.sharedFolder")
          : t("mobile.ai.delivery.folder"),
        title: event.folder.name,
        href: event.folder.href,
      });
    }
    if (event.file) {
      add({
        key: `file:${event.file.id}`,
        kind: event.file.mime?.startsWith("image/") ? "image" : "file",
        eyebrow: event.file.mime?.startsWith("image/")
          ? t("mobile.ai.delivery.image")
          : t("mobile.ai.delivery.file"),
        title: event.file.name,
        href: event.file.href,
      });
    }
    if (event.resourceId) {
      add({
        key: `doc:${event.resourceId}`,
        kind: "document",
        eyebrow: t("mobile.ai.delivery.document"),
        title:
          (event.kind === "text" || event.kind === "reasoning"
            ? event.text
            : String(event.data?.name ?? "")) ||
          t("mobile.ai.delivery.viewDocument"),
        documentId: event.resourceId,
      });
    }
  }
  for (const operation of operations) {
    const result = operation.result;
    if (!result) continue;
    if (
      result.kind === "file_folder" &&
      result.href &&
      (result.name || result.title)
    ) {
      add({
        key: `op-folder:${operation.id}`,
        kind: result.shared ? "shared_folder" : "folder",
        eyebrow: result.shared
          ? t("mobile.ai.delivery.sharedFolder")
          : t("mobile.ai.delivery.folder"),
        title: result.name || result.title || t("mobile.ai.delivery.folder"),
        href: result.href,
      });
      continue;
    }
    if (result.kind === "file_item" && (result.name || result.title)) {
      add({
        key: `op-file:${operation.id}`,
        kind: result.mime?.startsWith("image/") ? "image" : "file",
        eyebrow: result.mime?.startsWith("image/")
          ? t("mobile.ai.delivery.image")
          : t("mobile.ai.delivery.file"),
        title: result.name || result.title || t("mobile.ai.delivery.file"),
        href: result.href,
      });
      continue;
    }
    const id = result.id || result.resourceId;
    if (!id || !result.title) continue;
    add({
      key: `op:${operation.id}`,
      kind: result.kind === "library" ? "library" : "document",
      eyebrow:
        result.kind === "library"
          ? t("shell.kind.library")
          : result.format || t("mobile.ai.delivery.document"),
      title: result.title,
      documentId: id,
    });
  }
  return cards;
}

export function AiTrace({
  router,
  events,
  reasoning,
  answer,
}: {
  router: Nav;
  events: TraceEvent[];
  reasoning?: string;
  answer?: string;
}) {
  const { t } = useI18n();
  const steps = events.filter(
    (event) => event.kind === "tool" || event.kind === "status",
  );
  const thought =
    reasoning?.trim() ||
    events
      .flatMap((event) =>
        event.kind === "reasoning" && event.text.trim()
          ? [event.text.trim()]
          : [],
      )
      .join("\n");
  const running = steps.some((step) => step.status === "loading");
  const hasAnswer = !!answer?.trim();
  const [stepsOpen, setStepsOpen] = useState(!hasAnswer);
  const [thoughtOpen, setThoughtOpen] = useState(!hasAnswer);
  const previous = useRef(hasAnswer);
  useEffect(() => {
    if (hasAnswer && !previous.current) {
      setStepsOpen(false);
      setThoughtOpen(false);
    }
    previous.current = hasAnswer;
  }, [hasAnswer]);
  const open = stepsOpen;
  const thoughtVisible = thoughtOpen;
  if (!steps.length && !thought) return null;
  return (
    <View style={styles.wrap}>
      {thought ? (
        <Pressable
          onPress={() => setThoughtOpen((value) => !value)}
          style={styles.chain}
        >
          <Text style={styles.chainTitle}>
            {running && !steps.length
              ? t("chat.thinking")
              : t("mobile.ai.thinkingProcess")}
          </Text>
          <Text style={styles.chainToggle}>
            {thoughtVisible ? t("mobile.ai.collapse") : t("mobile.ai.expand")}
          </Text>
        </Pressable>
      ) : null}
      {thought && thoughtVisible ? (
        <Text style={styles.thought}>{thought}</Text>
      ) : null}
      {steps.length ? (
        <Pressable
          onPress={() => setStepsOpen((value) => !value)}
          style={styles.chain}
        >
          <Text style={styles.chainTitle}>
            {running
              ? t("mobile.ai.executing")
              : t("mobile.ai.executedSteps", { count: steps.length })}
          </Text>
          <Text style={styles.chainToggle}>
            {open ? t("mobile.ai.collapse") : t("mobile.ai.expand")}
          </Text>
        </Pressable>
      ) : null}
      {open
        ? steps.map((step) => (
            <Pressable
              key={step.id}
              style={styles.step}
              disabled={!step.resourceId}
              onPress={() => openDocument(router, step.resourceId)}
            >
              <Text
                style={[
                  styles.mark,
                  step.status === "error" && styles.markError,
                ]}
              >
                {step.status === "loading"
                  ? "…"
                  : step.status === "error"
                    ? "!"
                    : "✓"}
              </Text>
              <View style={styles.stepCopy}>
                <Text style={styles.stepText}>{aiEventLabel(step, t)}</Text>
                {aiEventDetail(step, t) ? (
                  <Text style={styles.stepDetail}>
                    {aiEventDetail(step, t)}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))
        : null}
    </View>
  );
}

export function openDeliveryCard(router: Nav, card: DeliveryCard) {
  if (card.href && openAiHref(router, card.href)) return;
  if (card.kind === "library" && card.documentId) {
    router.push({
      pathname: "/library/[id]",
      params: { id: card.documentId, title: card.title },
    });
    return;
  }
  openDocument(router, card.documentId);
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 8, gap: 6 },
  chain: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chainTitle: { color: colors.secondary, fontSize: 13 },
  chainToggle: { color: colors.accent, fontSize: 13 },
  thought: { color: colors.secondary, fontSize: 13, lineHeight: 20, paddingHorizontal: 4 },
  step: { flexDirection: "row", gap: 8, paddingHorizontal: 4, paddingVertical: 3 },
  mark: { width: 16, color: colors.accent, fontSize: 13 },
  markError: { color: colors.danger },
  stepCopy: { flex: 1 },
  stepText: { color: colors.ink, fontSize: 13, lineHeight: 18 },
  stepDetail: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
