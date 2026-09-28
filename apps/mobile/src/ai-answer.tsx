import { Dimensions, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { openAiHref } from "./ai-open";
import {
  deliveryCards,
  openDeliveryCard,
  type DeliveryCard,
  type TraceEvent,
  type TraceOperation,
} from "./ai-trace";
import {
  aiApprovalDetail,
  aiApprovalTitle,
  type MobileAIApproval,
} from "./ai-progress-label";
import { colors } from "./chrome";
import { useI18n } from "./locale";

type Nav = {
  push: (path: string | { pathname: string; params?: Record<string, string> }) => void;
};

export type ApprovalItem = MobileAIApproval;

type Piece =
  | { type: "text"; text: string }
  | { type: "card"; card: DeliveryCard };

const width = Dimensions.get("window").width;
const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const markdown = StyleSheet.create({
  body: { color: colors.ink, fontSize: 16, lineHeight: 26 },
  text: { color: colors.ink, fontSize: 16, lineHeight: 26 },
  paragraph: { marginTop: 0, marginBottom: 10 },
  heading1: { color: colors.ink, fontSize: 22, lineHeight: 30, fontWeight: "700", marginTop: 8, marginBottom: 8 },
  heading2: { color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: "700", marginTop: 8, marginBottom: 6 },
  heading3: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "700", marginTop: 6, marginBottom: 4 },
  heading4: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "600", marginTop: 4, marginBottom: 4 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  link: { color: colors.accent, textDecorationLine: "none" },
  blocklink: { borderBottomWidth: 0 },
  blockquote: {
    backgroundColor: "#f5f6f7",
    borderLeftColor: colors.accent,
    borderLeftWidth: 3,
    borderColor: "#f5f6f7",
    marginLeft: 0,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
  },
  hr: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth, marginVertical: 12 },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { flexDirection: "row", alignItems: "flex-start", marginBottom: 4 },
  bullet_list_icon: { width: 18, marginLeft: 2, marginRight: 6, lineHeight: 26, color: colors.secondary },
  bullet_list_content: { flex: 1 },
  ordered_list_icon: { minWidth: 22, marginLeft: 0, marginRight: 6, lineHeight: 26, color: colors.secondary },
  ordered_list_content: { flex: 1 },
  code_inline: {
    fontFamily: mono,
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: "#f2f3f5",
    color: colors.ink,
    borderWidth: 0,
    padding: 0,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  code_block: {
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 20,
    backgroundColor: "#f5f6f7",
    color: colors.ink,
    borderWidth: 0,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  fence: {
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 20,
    backgroundColor: "#f5f6f7",
    color: colors.ink,
    borderWidth: 0,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 8, marginBottom: 10 },
  th: { flex: 1, padding: 8, backgroundColor: "#f7f8fa", fontWeight: "600" },
  tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line, flexDirection: "row" },
  td: { flex: 1, padding: 8 },
  image: { width: width - 64, height: 180, borderRadius: 8, marginBottom: 8 },
});

export function AnswerBody({
  text,
  events,
  operations,
  router,
}: {
  text: string;
  events: TraceEvent[];
  operations: TraceOperation[];
  router: Nav;
}) {
  const { t } = useI18n();
  const pieces = splitAnswer(
    text,
    deliveryCards(events, operations, t),
    t("mobile.ai.delivery.document"),
    t("mobile.ai.delivery.viewDocument"),
  );
  if (!pieces.length) return null;
  return (
    <View>
      {pieces.map((piece, index) =>
        piece.type === "text" ? (
          piece.text.trim() ? (
            <Markdown
              key={`text-${index}`}
              style={markdown}
              onLinkPress={(url) => {
                if (openAiHref(router, url)) return false;
                return true;
              }}
            >
              {piece.text}
            </Markdown>
          ) : null
        ) : (
          <DeliveryCardView key={piece.card.key} card={piece.card} onPress={() => openDeliveryCard(router, piece.card)} />
        ),
      )}

    </View>
  );
}

export function ApprovalCards({
  items,
  busy,
  onDecide,
}: {
  items: { jobId: string; approval: ApprovalItem }[];
  busy: boolean;
  onDecide: (jobId: string, approvalId: string, approved: boolean) => void;
}) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <View style={styles.approvals}>
      {items.map(({ jobId, approval }) => (
        <View key={approval.id} style={styles.approval}>
          <Text style={styles.approvalTitle}>
            {aiApprovalTitle(approval, t)}
          </Text>
          <Text style={styles.approvalDetail}>
            {aiApprovalDetail(approval, t)}
          </Text>
          {approval.preview ? (
            <Text style={styles.approvalPreview} numberOfLines={8}>
              {approval.preview}
            </Text>
          ) : null}
          <View style={styles.approvalActions}>
            <Pressable disabled={busy} style={styles.reject} onPress={() => onDecide(jobId, approval.id, false)}>
              <Text style={styles.rejectText}>{t("ticket.reject")}</Text>
            </Pressable>
            <Pressable disabled={busy} style={styles.approve} onPress={() => onDecide(jobId, approval.id, true)}>
              <Text style={styles.approveText}>{t("chat.approveContinue")}</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

function DeliveryCardView({ card, onPress }: { card: Pick<DeliveryCard, "eyebrow" | "title">; onPress: () => void }) {
  const { t } = useI18n();
  return (
    <Pressable collapsable={false} style={styles.card} onPress={onPress}>
      <View style={styles.cardCopy}>
        <Text style={styles.eyebrow}>{card.eyebrow}</Text>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
      </View>
      <Text style={styles.arrow}>{t("common.open")}</Text>
    </Pressable>
  );
}

function splitAnswer(
  text: string,
  cards: DeliveryCard[],
  documentLabel: string,
  viewDocumentLabel: string,
): Piece[] {
  if (!text && !cards.length) return [];
  const used = new Set<string>();
  const pieces: Piece[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const title = match[1] ?? "";
    const href = match[2] ?? "";
    const card = cardForLink(title, href, cards, documentLabel, viewDocumentLabel);
    if (!card) continue;
    const start = match.index ?? 0;
    if (start > cursor) pieces.push({ type: "text", text: text.slice(cursor, start) });
    if (!used.has(card.key)) {
      pieces.push({ type: "card", card });
      used.add(card.key);
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) pieces.push({ type: "text", text: text.slice(cursor) });
  if (!pieces.length && text) pieces.push({ type: "text", text });
  for (const card of cards) {
    if (!used.has(card.key)) pieces.push({ type: "card", card });
  }
  return pieces;
}

function cardForLink(
  title: string,
  href: string,
  cards: DeliveryCard[],
  documentLabel: string,
  viewDocumentLabel: string,
): DeliveryCard | null {
  const found = cards.find((card) => card.href && sameHref(card.href, href));
  if (found) return { ...found, title: found.title || title };
  const document = /^(?:#|\/m)?\/r\/([a-f0-9-]{36})$/i.exec(href.trim()) ?? /\/r\/([a-f0-9-]{36})/i.exec(href);
  if (!document?.[1]) return null;
  return {
    key: `link:${document[1]}`,
    kind: "document",
    eyebrow: documentLabel,
    title: title || viewDocumentLabel,
    documentId: document[1],
    href,
  };
}

function sameHref(left: string, right: string) {
  return left.replace(/^#/, "") === right.replace(/^#/, "");
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    gap: 8,
  },
  cardCopy: { flex: 1, gap: 2 },
  eyebrow: { color: colors.muted, fontSize: 12 },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  arrow: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  approvals: { gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  approval: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 12,
    gap: 8,
  },
  approvalTitle: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  approvalDetail: { color: colors.secondary, fontSize: 14, lineHeight: 20 },
  approvalPreview: { color: colors.ink, fontSize: 13, lineHeight: 20, backgroundColor: colors.bg, borderRadius: 8, padding: 8 },
  approvalActions: { flexDirection: "row", gap: 8 },
  reject: { flex: 1, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#f2f3f5" },
  rejectText: { color: colors.ink, fontWeight: "600" },
  approve: { flex: 1, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  approveText: { color: "#fff", fontWeight: "600" },
});
