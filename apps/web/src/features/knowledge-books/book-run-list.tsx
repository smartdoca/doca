import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
  PauseCircle,
  UserRound,
  CalendarClock,
} from "lucide-react";
import type { BookRunTrigger } from "@core/modules/knowledge-books/run-logs.js";
import type { MessageKey } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";

export type BookRunSummary = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  error: string;
  trigger: BookRunTrigger | null;
};
export function runDuration(
  run: Pick<BookRunSummary, "started_at" | "updated_at" | "status">,
  now: number,
) {
  if (!run.started_at) return null;
  const end = ["published", "failed", "cancelled"].includes(run.status)
    ? Date.parse(run.updated_at)
    : now;
  const seconds = Math.max(
    0,
    Math.floor((end - Date.parse(run.started_at)) / 1000),
  );
  const parts = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ];
  return (parts[0] ? parts : parts.slice(1))
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
function StatusIcon({ status }: { status: string }) {
  if (status === "published") return <CheckCircle2 size={17} />;
  if (status === "failed") return <CircleAlert size={17} />;
  if (status === "running")
    return <LoaderCircle className="book-run-spinner" size={17} />;
  if (status.startsWith("awaiting")) return <PauseCircle size={17} />;
  return <Clock3 size={17} />;
}
export function BookRunList({
  runs,
  selected,
  choose,
}: {
  runs: BookRunSummary[];
  selected?: string;
  choose: (id: string) => void;
}) {
  const { t } = useI18n(),
    [now, setNow] = useState(Date.now());
  const active = runs.some(
    (run) => !["published", "failed", "cancelled"].includes(run.status),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const bt = (key: string) => t(`books.${key}` as MessageKey);
  return (
    <aside className="book-run-list" aria-label={bt("pipelineRunList")}>
      <div className="book-run-list-heading">
        <h2>{bt("pipelineRunList")}</h2>
        <span>{runs.length}</span>
      </div>
      <div className="book-run-list-items">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={`book-run-list-item state-${run.status}`}
            aria-pressed={run.id === selected}
            onClick={() => choose(run.id)}
          >
            <div className="book-run-list-item-title">
              <StatusIcon status={run.status} />
              <strong>#{run.id.slice(0, 8)}</strong>
              <span className="book-run-list-status">
                {bt(
                  run.status === "published"
                    ? "pipelineStatusSuccess"
                    : run.status === "awaiting_input"
                      ? "pipelineStatusReview"
                      : run.status === "awaiting_publication"
                        ? "pipelineStatusPublishReview"
                        : `status.${run.status}`,
                )}
              </span>
            </div>
            <div className="book-run-trigger">
              {run.trigger?.kind === "schedule" ? (
                <CalendarClock size={14} />
              ) : (
                <UserRound size={14} />
              )}
              <span>
                {run.trigger?.kind === "schedule"
                  ? `${bt("pipelineScheduled")} · ${bt(`schedule.${run.trigger.schedule}`)}`
                  : (run.trigger?.actorName ?? bt("pipelineTriggerUnknown"))}
              </span>
            </div>
            <dl>
              <div>
                <dt>{bt("pipelineStartedAt")}</dt>
                <dd>
                  {run.started_at
                    ? new Date(run.started_at).toLocaleString()
                    : bt("pipelinePending")}
                </dd>
              </div>
              <div>
                <dt>{bt("pipelineElapsed")}</dt>
                <dd>{runDuration(run, now) ?? "—"}</dd>
              </div>
            </dl>
          </button>
        ))}
        {!runs.length && <p>{bt("pipelineNoRuns")}</p>}
      </div>
    </aside>
  );
}
