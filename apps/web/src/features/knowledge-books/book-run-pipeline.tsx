import {
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { Alert, Button, Collapse, Tag, Drawer } from "antd";
import {
  CheckCircle2,
  Clock3,
  CircleAlert,
  LoaderCircle,
  PauseCircle,
} from "lucide-react";
import type {
  BookArtifact,
  BookConfiguration,
  BookWorkflow,
} from "@core/modules/knowledge-books/protocol.js";
import type {
  BookRunLog,
  BookRunTrigger,
} from "@core/modules/knowledge-books/run-logs.js";
import { systemErrorMessage, type MessageKey } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";
import { BookGraph } from "./book-graph-view.js";
import MarkdownPreview from "@web/features/documents/markdown-preview.js";

export type BookPipelineRun = {
  id: string;
  status: string;
  error: string;
  startedAt: string | null;
  trigger: BookRunTrigger | null;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string | null;
  configurationRevision: number;
  configuration: BookConfiguration;
  logs: BookRunLog[];
  restricted: boolean;
  artifact: Pick<BookArtifact, "pages" | "checks"> | null;
  nodes: Array<{
    nodeId: string;
    type: string;
    status: string;
    error: string;
    startedAt: string;
    completedAt: string | null;
    reusedFromRunId: string | null;
  }>;
};

/** The run's frozen graph determines the layout, rather than today's editable configuration. */
export function pipelineWorkflow(
  workflow: BookWorkflow,
  columns = 3,
): BookWorkflow {
  const layers = new Map(workflow.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < workflow.nodes.length; pass++) {
    let changed = false;
    for (const edge of workflow.edges) {
      const depth = Math.min(
        workflow.nodes.length,
        (layers.get(edge.source) ?? 0) + 1,
      );
      if (depth > (layers.get(edge.target) ?? 0)) {
        layers.set(edge.target, depth);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const sizes = new Map<number, number>();
  for (const depth of layers.values())
    sizes.set(depth, (sizes.get(depth) ?? 0) + 1);
  const groupHeights = new Map<number, number>();
  for (const [depth, rows] of sizes) {
    const group = Math.floor(depth / columns);
    groupHeights.set(
      group,
      Math.max(groupHeights.get(group) ?? 0, rows * 144 + 24),
    );
  }
  const top = (group: number) => {
    let y = 24;
    for (let i = 0; i < group; i++) y += groupHeights.get(i) ?? 0;
    return y;
  };
  const rows = new Map<number, number>();
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const depth = layers.get(node.id)!,
        row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return {
        ...node,
        position: {
          x: 24 + (depth % columns) * 240,
          y: top(Math.floor(depth / columns)) + row * 144,
        },
      };
    }),
  };
}

function StateIcon({ status }: { status: string }) {
  if (status === "completed" || status === "published")
    return <CheckCircle2 size={16} />;
  if (status === "failed") return <CircleAlert size={16} />;
  if (status === "running")
    return <LoaderCircle className="book-run-spinner" size={16} />;
  if (status.startsWith("awaiting")) return <PauseCircle size={16} />;
  return <Clock3 size={16} />;
}

export function BookRunPipeline({
  run,
  canEdit,
  cancel,
  repair,
  retry,
  busy,
  humanTasks,
}: {
  run: BookPipelineRun;
  canEdit: boolean;
  cancel: () => void;
  repair: () => void;
  retry: () => void;
  busy: boolean;
  humanTasks: (nodeId: string) => ReactNode;
}) {
  const { t } = useI18n(),
    [selected, select] = useState<string>();
  const host = useRef<HTMLElement>(null),
    [width, setWidth] = useState(0);
  useEffect(() => select(undefined), [run.id]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0]!.contentRect.width),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.min(3, Math.floor((width - 40) / 240)));
  const bt = (key: string, values?: Parameters<typeof t>[1]) =>
    t(`books.${key}` as MessageKey, values);
  const label = (status: string) =>
    bt(status === "pending" ? "pipelinePending" : `status.${status}`);
  const workflow = useMemo(
    () => pipelineWorkflow(run.configuration.workflow, columns),
    [run.configuration.workflow, columns],
  );
  const facts = new Map(run.nodes.map((node) => [node.nodeId, node]));
  const node = workflow.nodes.find((node) => node.id === selected),
    fact = selected ? facts.get(selected) : undefined;
  const nodeLabel = (id: string) => {
    const node = workflow.nodes.find((node) => node.id === id);
    return node ? node.label || bt(`node.${node.type}`) : id;
  };
  const logLabel = (entry: BookRunLog) =>
    bt(`log.${entry.code}`, {
      node: entry.nodeId ? nodeLabel(entry.nodeId) : bt("pipeline"),
      value: entry.value ?? "",
      total: entry.total ?? "",
    });
  const execution = {
    viewId: run.id,
    selectedId: selected,
    states: Object.fromEntries(
      workflow.nodes.map((node) => [
        node.id,
        facts.get(node.id)?.status ?? "pending",
      ]),
    ),
    summaries: Object.fromEntries(
      workflow.nodes.map((node) => {
        const last = run.logs.findLast((entry) => entry.nodeId === node.id);
        const fact = facts.get(node.id);
        return [
          node.id,
          !fact
            ? bt("pipelineNotStarted")
            : fact.reusedFromRunId
            ? bt("pipelineReused")
            : fact?.status === "completed" && last?.code.startsWith("waiting")
              ? label("completed")
              : fact.status === "completed" && last?.code === "node_completed"
                ? bt("pipelineOutputCounts", { pages: last.value ?? 0, claims: last.total ?? 0 })
              : last
                ? logLabel(last)
                : fact
                  ? label(fact.status)
                  : bt("pipelineNotStarted"),
        ];
      }),
    ),
  };
  const logs = selected
    ? run.logs.filter((entry) => entry.nodeId === selected)
    : run.logs;
  const elapsed =
    fact?.completedAt && !fact.status.startsWith("awaiting")
      ? Math.max(
          0,
          Math.round(
            (Date.parse(fact.completedAt) - Date.parse(fact.startedAt)) / 1000,
          ),
        )
      : null;
  return (
    <section
      ref={host}
      className="book-run-pipeline"
      aria-label={bt("pipeline")}
    >
      <header className="book-run-heading">
        <div>
          <h2>{bt("pipeline")}</h2>
          <p>
            {new Date(run.createdAt).toLocaleString()} ·{" "}
            {bt("pipelineRevision", { revision: run.configurationRevision })}
          </p>
        </div>
        <div className="book-run-actions">
          <Tag className={`book-run-status state-${run.status}`}>
            <StateIcon status={run.status} />
            {label(run.status)}
          </Tag>
          {canEdit &&
            [
              "queued",
              "running",
              "queued_resume",
              "queued_publish",
              "awaiting_input",
              "awaiting_publication",
            ].includes(run.status) && (
              <Button danger onClick={cancel}>
                {bt("cancelRun")}
              </Button>
            )}
          {canEdit && run.status === "failed" && (
            <>
              <Button type="primary" loading={busy} onClick={retry}>{bt("resumeRun")}</Button>
              <Button onClick={repair}>{bt("assistantRepair")}</Button>
            </>
          )}
        </div>
      </header>
      {run.error && (
        <Alert
          type="error"
          showIcon
          title={systemErrorMessage(run.error, t)}
        />
      )}
      {run.restricted && <Alert type="warning" title={bt("restricted")} />}
      {!!width && (
        <BookGraph
          workflow={workflow}
          execution={execution}
          selected={select}
        />
      )}
      <Drawer
        open={!!node}
        title={node ? nodeLabel(node.id) : bt("executionLogs")}
        onClose={() => select(undefined)}
        size={Math.min(560, Math.max(320, width))}
        mask={false}
        className="book-node-log-drawer"
      >
        <div className="book-run-detail" key={selected ?? "all"}>
          <div className="book-run-detail-heading">
            <div>
              <p>
                {node
                  ? label(fact?.status ?? "pending")
                  : bt("pipelineLogHelp")}
                {fact?.reusedFromRunId && ` · ${bt("pipelineReused")}`}
                {elapsed !== null &&
                  ` · ${bt("pipelineDuration", { seconds: elapsed })}`}
              </p>
            </div>
          </div>
          {node &&
            ((fact &&
              (fact.status.startsWith("awaiting") ||
                fact.status === "failed")) ||
              run.status === "failed") && (
              <div className="book-run-human-tasks">{humanTasks(node.id)}</div>
            )}
          {fact?.error && (
            <Alert
              type="error"
              showIcon
              title={systemErrorMessage(fact.error, t)}
            />
          )}
          <div
            className="book-execution-logs"
            role="log"
            aria-live="polite"
            aria-label={bt("executionLogs")}
          >
            {logs.map((entry) => (
              <div
                key={entry.id}
                className={`book-log-entry log-${entry.code}`}
              >
                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                <span>{logLabel(entry)}</span>
              </div>
            ))}
            {!logs.length && (
              <p>
                {bt(node && !fact ? "pipelineNotStarted" : "noExecutionLogs")}
              </p>
            )}
          </div>
          <footer className="book-run-log-footer">
            <span>
              {bt("updatedAt")} {new Date(run.updatedAt).toLocaleTimeString()}
              {run.heartbeatAt &&
                ` · ${bt("heartbeatAt")} ${new Date(run.heartbeatAt).toLocaleTimeString()}`}
            </span>
            <span>{bt("logsHelp")}</span>
          </footer>
        </div>
      </Drawer>
      {run.artifact && (
        <Collapse
          className="book-run-artifact"
          items={[
            {
              key: "artifact",
              label: bt("pipelineArtifact"),
              children: (
                <>
                  {run.artifact.checks.map((check) => (
                    <Alert
                      key={check.criterionId}
                      type={check.passed ? "success" : "error"}
                      title={check.criterionId}
                      description={check.reason}
                    />
                  ))}
                  {run.artifact.pages.map((page) => (
                    <section key={page.id}>
                      <h3>{[...page.path, page.title].join(" / ")}</h3>
                      <MarkdownPreview
                        value={page.paragraphs
                          .map((p) => p.markdown)
                          .join("\n\n")}
                      />
                    </section>
                  ))}
                </>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
