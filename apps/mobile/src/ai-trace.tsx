import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { openAiHref, openDocument } from "./ai-open";
import { colors } from "./chrome";

type Nav = {
  push: (path: string | { pathname: string; params?: Record<string, string> }) => void;
};

export type TraceEvent = {
  id: string;
  kind: "reasoning" | "text" | "tool" | "status";
  text: string;
  detail?: string;
  resourceId?: string;
  status: "loading" | "success" | "error";
  folder?: { id: string; name: string; href: string; shared?: boolean; path?: string };
  file?: { id: string; name: string; href?: string; mime?: string };
  mail?: { id: string; mailboxId: string; subject: string; from: string; href: string };
};

export type TraceOperation = {
  id: string;
  job_id: string;
  result?: {
    id?: string;
    resourceId?: string;
    title?: string;
    format?: string;
    kind?: string;
  };
};

type Card = { key: string; eyebrow: string; title: string; href?: string; documentId?: string };

function cardsFor(events: TraceEvent[], operations: TraceOperation[]): Card[] {
  const cards: Card[] = [];
  const seen = new Set<string>();
  const add = (card: Card) => {
    if (seen.has(card.key)) return;
    seen.add(card.key);
    cards.push(card);
  };
  for (const event of events) {
    if (event.folder) {
      add({
        key: `folder:${event.folder.id}`,
        eyebrow: event.folder.shared ? "共享文件夹" : "文件夹",
        title: event.folder.name,
        href: event.folder.href,
      });
    }
    if (event.file) {
      add({
        key: `file:${event.file.id}`,
        eyebrow: event.file.mime?.startsWith("image/") ? "图片" : "文件",
        title: event.file.name,
        href: event.file.href,
      });
    }
    if (event.mail) {
      add({
        key: `mail:${event.mail.mailboxId}:${event.mail.id}`,
        eyebrow: event.mail.from || "邮件",
        title: event.mail.subject || "（无主题）",
        href: event.mail.href,
      });
    }
    if (event.resourceId) {
      add({
        key: `doc:${event.resourceId}`,
        eyebrow: "文档",
        title: event.text || "查看文档",
        documentId: event.resourceId,
      });
    }
  }
  for (const operation of operations) {
    const result = operation.result;
    const id = result?.id || result?.resourceId;
    if (!id || !result?.title) continue;
    add({
      key: `op:${operation.id}`,
      eyebrow: result.kind === "library" ? "知识库" : result.format || "文档",
      title: result.title,
      documentId: id,
    });
  }
  return cards;
}

export function AiTrace({
  router,
  events,
  operations,
  reasoning,
  answer,
}: {
  router: Nav;
  events: TraceEvent[];
  operations: TraceOperation[];
  reasoning?: string;
  answer?: string;
}) {
  const steps = events.filter((event) => event.kind === "tool" || event.kind === "status");
  const cards = cardsFor(events, operations);
  const thought =
    reasoning?.trim() ||
    events
      .filter((event) => event.kind === "reasoning" && event.text.trim())
      .map((event) => event.text.trim())
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
  if (!steps.length && !cards.length && !thought) return null;
  return (
    <View style={styles.wrap}>
      {thought ? (
        <Pressable onPress={() => setThoughtOpen((value) => !value)} style={styles.chain}>
          <Text style={styles.chainTitle}>{running && !steps.length ? "正在思考" : "思考过程"}</Text>
          <Text style={styles.chainToggle}>{thoughtVisible ? "收起" : "展开"}</Text>
        </Pressable>
      ) : null}
      {thought && thoughtVisible ? <Text style={styles.thought}>{thought}</Text> : null}
      {steps.length ? (
        <Pressable onPress={() => setStepsOpen((value) => !value)} style={styles.chain}>
          <Text style={styles.chainTitle}>{running ? "正在执行" : `已执行 ${steps.length} 步`}</Text>
          <Text style={styles.chainToggle}>{open ? "收起" : "展开"}</Text>
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
              <Text style={[styles.mark, step.status === "error" && styles.markError]}>
                {step.status === "loading" ? "…" : step.status === "error" ? "!" : "✓"}
              </Text>
              <View style={styles.stepCopy}>
                <Text style={styles.stepText}>{step.text}</Text>
                {step.detail ? <Text style={styles.stepDetail}>{step.detail}</Text> : null}
              </View>
            </Pressable>
          ))
        : null}
      {cards.map((card) => (
        <Pressable
          key={card.key}
          style={styles.card}
          onPress={() => {
            if (card.href && openAiHref(router, card.href)) return;
            if (card.eyebrow === "知识库" && card.documentId) {
              router.push({ pathname: "/library/[id]", params: { id: card.documentId, title: card.title } });
              return;
            }
            openDocument(router, card.documentId);
          }}
        >
          <View style={styles.cardCopy}>
            <Text style={styles.eyebrow}>{card.eyebrow}</Text>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {card.title}
            </Text>
          </View>
          <Text style={styles.arrow}>↗</Text>
        </Pressable>
      ))}
    </View>
  );
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
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  cardCopy: { flex: 1, gap: 2 },
  eyebrow: { color: colors.muted, fontSize: 12 },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  arrow: { color: colors.accent, fontSize: 16 },
});
