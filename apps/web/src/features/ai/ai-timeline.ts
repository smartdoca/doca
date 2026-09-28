type Message = { id: string; role: string; createdAt?: string };
type Job = { id: string; status: string; created_at?: string };
type CompletionProgress = {
  questions?: unknown[];
  pendingAccess?: unknown;
  plan?: { mode?: string };
  review?: { verdict?: string };
};

export type CompletionPresentation =
  "done" | "waiting-choice" | "waiting-access" | "waiting-input";

/** Derive presentation from structured state, never from localized phase text. */
export function completionPresentation(
  progress?: CompletionProgress | null,
): CompletionPresentation {
  if (progress?.questions?.length) return "waiting-choice";
  if (progress?.pendingAccess) return "waiting-access";
  if (
    progress?.plan?.mode === "clarify" ||
    progress?.review?.verdict === "needs_user"
  )
    return "waiting-input";
  return "done";
}

// Pair turns by persistent job IDs, never by prompt text or completion order.
export function aiTimeline<M extends Message, J extends Job>(
  messages: M[],
  jobs: J[],
) {
  const ordered = [...new Map(messages.map((m) => [m.id, m])).values()].sort(
    (a, b) =>
      (Date.parse(a.createdAt ?? "") || 0) -
      (Date.parse(b.createdAt ?? "") || 0),
  );
  const byId = new Map(ordered.map((m) => [m.id, m]));
  const byJob = new Map(jobs.map((j) => [j.id, j]));
  const pairedAnswers = new Set(
    ordered.filter((m) => m.role === "user").map((m) => `${m.id}-answer`),
  );
  const items: ({ kind: "message"; message: M } | { kind: "job"; job: J })[] =
    [];
  for (const message of ordered) {
    if (message.role === "assistant" && pairedAnswers.has(message.id)) continue;
    items.push({ kind: "message", message });
    if (message.role !== "user") continue;
    const job = byJob.get(message.id);
    if (job) items.push({ kind: "job", job });
    const answer = byId.get(`${message.id}-answer`);
    if (answer) items.push({ kind: "message", message: answer });
  }
  // A queued job may be visible before the worker has persisted its user message.
  for (const job of [...jobs].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  ))
    if (!byId.has(job.id) && ["queued", "running"].includes(job.status))
      items.push({ kind: "job", job });
  return items;
}

export function taskDuration(start?: string, end?: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(end ?? "") - Date.parse(start ?? "")) / 1000),
  );
  if (!Number.isFinite(seconds)) return null;
  return {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
  };
}
