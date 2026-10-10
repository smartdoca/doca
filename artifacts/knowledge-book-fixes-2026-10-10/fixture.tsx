import React from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { LocaleProvider } from "../../apps/web/src/shared/i18n.js";
import { KnowledgeBooksPage } from "../../apps/web/src/features/knowledge-books/knowledge-books.js";
import { defaultBookConfiguration } from "../../packages/core/src/modules/knowledge-books/protocol.js";
import "./fixture.css";
const bookId = "11111111-1111-4111-8111-111111111111";
const configuration = defaultBookConfiguration();
configuration.goal = "理解 TCP/IP 的架构、传输机制与端到端通信过程";
configuration.modelId = "model";
const paragraphs = [
  { id: "layers", markdown: "## 分层架构与职责\n\nTCP/IP 将通信职责分配到链路层、网络层、传输层与应用层。网络层负责跨网络寻址和转发，传输层在端系统之间提供通信抽象。理解各层边界，可以把一条请求的失败定位到具体机制。\n\n```mermaid\nflowchart TB\n A[应用层：业务数据] --> B[传输层：端到端通信]\n B --> C[网络层：寻址与转发]\n C --> D[链路层：相邻节点传输]\n```", claimIds: ["c0"], reason: "来自分层模型的原始依据" },
  { id: "encapsulation", markdown: "## 数据封装与解封装\n\n发送端逐层为数据增加控制信息；接收端按相反顺序解释这些信息，并把有效载荷交给上层。同一份应用数据在不同层具有不同的协议数据单元。\n\n### 发送端的封装步骤\n\n1. 应用层产生待发送的数据。\n2. 传输层加入端点识别和传输控制信息。\n3. 网络层加入跨网络转发所需的地址。\n4. 链路层把分组封装为相邻节点可传输的帧。", claimIds: ["c1"], reason: "保留原始机制的阶段与顺序" },
  { id: "flow", markdown: "## 一次端到端通信\n\n两台主机通过中间网络交换数据。路由器处理网络层转发，应用和传输端点仍位于两端主机。下面的图说明数据的路径和响应方向。\n\n```mermaid\nsequenceDiagram\n participant A as 发送主机\n participant R as 路由器\n participant B as 接收主机\n A->>R: 目标地址与有效载荷\n R->>B: 转发分组\n B-->>R: 响应分组\n R-->>A: 返回响应\n```", claimIds: ["c2"], reason: "原始依据支持端点与中间转发节点的职责" },
];
const pages = [
  { id: "overview", title: "分层架构与端到端通信", path: ["协议基础"], paragraphs },
  { id: "tcp", title: "TCP：可靠字节流、确认与重传机制", path: ["传输层"], paragraphs: [{ ...paragraphs[0], id: "tcp-detail", markdown: "## 可靠传输的基本机制\n\nTCP 使用序列号识别字节流中的位置，接收端通过确认告知已经收到的数据。发送端结合确认与重传，处理传输过程中的丢失。" }] },
  { id: "limits", title: "网络层：跨网络寻址、分组转发及其适用边界", path: ["网络层"], paragraphs: [{ ...paragraphs[1], id: "network-detail" }] },
];
const nodes: any[] = pages.map(page => ({ id: `page:${page.id}`, kind: "page", label: page.title, detail: {} }));
const edges: any[] = [];
for (const paragraph of paragraphs) {
 nodes.push({ id: `paragraph:${paragraph.id}`, kind: "paragraph", label: paragraph.markdown, detail: { markdown: paragraph.markdown } });
 edges.push({ source: `paragraph:${paragraph.id}`, target: "page:overview", relation: "adopted" });
}
for (let s = 0; s < 4; s++) nodes.push({ id: `source${s}`, kind: "source", label: ["协议分层原始资料", "网络架构原始资料", "数据封装机制", "端到端通信模型"][s], detail: {} });
for (let index = 0; index < 600; index++) {
 const sourceId = `source${index % 4}`;
 nodes.push({ id: `e${index}`, kind: "evidence", label: `分层职责的原始证据 ${index}`, detail: { sourceId } }, { id: `claim:${index}`, kind: "claim", label: `受依据支持的知识点 ${index}`, detail: {} });
 edges.push({ source: sourceId, target: `e${index}`, relation: "used" }, { source: `e${index}`, target: `claim:${index}`, relation: "supported" }, { source: `claim:${index}`, target: `paragraph:${paragraphs[index % 3].id}`, relation: "adopted" });
}
const artifact = { version: 1, pages, evidence: [], claims: [], checks: [], provenance: { nodes, edges } };
const summaries = Array.from({ length: 6 }, (_, index) => ({ id: `a${index}fe${index}0de-0000-4000-8000-00000000000${index}`, status: "failed", error: "", created_at: "2026-10-10T03:00:00.000Z", updated_at: "2026-10-10T03:25:00.000Z", started_at: "2026-10-10T03:00:00.000Z", trigger: { kind: "user", actorId: "owner", actorName: "管理员", schedule: null } }));
const book = { detail: { resource: { id: bookId, title: "TCP/IP 知识详解", kind: "document", format: "markdown", role: "owner" } }, revision: 3, configuration, publishedOnly: false, canEdit: true, canManage: false, canComment: true, sources: [], feedback: [], runs: summaries, releases: [{ id: "release", revision: 2 }], publishedRelease: { id: "release", revision: 2, artifact, restricted: false } };
window.fetch = async (url, options) => {
 const path = String(url);
 if (options?.method === "POST") return Response.json({ message: "验收页面不写入数据" }, { status: 403 });
 if (path.includes("human-tasks")) return Response.json({ items: [], nextOffset: null });
 if (path.includes("/runs/")) {
  const id = path.split("/runs/")[1].split("/")[0];
  const index = summaries.findIndex(run => run.id === id);
  if (new URLSearchParams(location.search).has("latency")) await new Promise(resolve => setTimeout(resolve, index === 1 ? 800 : 70));
  return Response.json({ id, status: "failed", error: "输入或成果未满足当前验收条件，请查看节点结果并调整。", createdAt: summaries[0].created_at, updatedAt: summaries[0].updated_at, startedAt: summaries[0].started_at, heartbeatAt: null, trigger: summaries[0].trigger, configurationRevision: 3 + index, configuration, restricted: false, artifact: null,
  logs: configuration.workflow.nodes.filter(node => node.type !== "publish").map((node, index) => ({ id: `log${index}`, at: summaries[0].updated_at, code: node.type === "acceptance" ? "node_failed" : "node_completed", nodeId: node.id, nodeType: node.type, value: 24, total: 600 })),
  nodes: configuration.workflow.nodes.filter(node => node.type !== "publish").map(node => ({ nodeId: node.id, type: node.type, status: node.type === "acceptance" ? "failed" : "completed", error: node.type === "acceptance" ? "需要补充机制详解" : "", startedAt: summaries[0].started_at, completedAt: summaries[0].updated_at, reusedFromRunId: null })) });
 }
 if (path.includes("/ai/")) return Response.json({ models: [{ id: "model", name: "知识整理模型" }] });
 return Response.json(book);
};
if (new URLSearchParams(location.search).get("state") === "runs") location.hash = `/knowledge-books/${bookId}?run=${summaries[0].id}`;
else location.hash = `/knowledge-books/${bookId}`;
createRoot(document.getElementById("root")!).render(<LocaleProvider><ConfigProvider><main className="fixture-shell"><header><div id="knowledge-books-header-title"/><div id="knowledge-books-header-actions"/></header><div className="fixture-body"><KnowledgeBooksPage id={bookId}/></div></main></ConfigProvider></LocaleProvider>);
