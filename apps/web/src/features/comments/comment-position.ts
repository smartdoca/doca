/** A sparse rail must still scroll as far as its source document. */
export function commentRailHeight(
  cardsBottom: number,
  sourceMaxScroll: number,
  viewportHeight: number,
  railOffset: number,
) {
  return Math.max(
    cardsBottom,
    sourceMaxScroll + viewportHeight - railOffset,
    0,
  );
}
/** Preserve document order and leave space for each measured thread. */
export function placeCommentCards(
  cards: { id: string; order: number; target: number; height: number }[],
  gap = 16,
) {
  let bottom = 0;
  return [...cards]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((card) => {
      const top = Math.max(
        bottom,
        Number.isFinite(card.target) ? card.target : 0,
        0,
      );
      bottom = top + Math.max(0, card.height) + gap;
      return { id: card.id, top };
    });
}
