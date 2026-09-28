import { useRef } from "react";
import { ArrowUpToLine, ArrowDownToLine } from "lucide-react";
import { scrollDocumentBoundary, type DocumentScrollEdge } from "@web/features/documents/document-scroll.js";
import "@web/features/documents/document-scroll-buttons.css";

export function DocumentScrollButtons() {
  const host = useRef<HTMLElement>(null);
  const go = (edge: DocumentScrollEdge) => {
    const root = host.current?.closest<HTMLElement>(".ai-document-main");
    if (root) scrollDocumentBoundary(root, edge, matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");
  };
  return <nav ref={host} className="document-scroll-buttons" aria-label="文档快速滚动">
    <button type="button" title="回到顶部" aria-label="回到顶部" onMouseDown={(e) => e.preventDefault()} onClick={() => go("top")}><ArrowUpToLine size={19} /></button>
    <button type="button" title="滚到底部" aria-label="滚到底部" onMouseDown={(e) => e.preventDefault()} onClick={() => go("bottom")}><ArrowDownToLine size={19} /></button>
  </nav>;
}
