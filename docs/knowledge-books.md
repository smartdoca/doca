# Knowledge books

[中文](knowledge-books.zh-CN.md)

A knowledge book is a generated, read-only Markdown document tree. Editable documents, libraries, files, folders, web pages and authorized `content.v1` providers are its sources. People maintain its sources, workflow and acceptance rules together. The personal AI assistant uses the same commands and authorization as the interface; there is no separate shared assistant identity or personal memory.

## Work together

Open **Knowledge books**, create a book, and use **Permissions** to invite collaborators. This is the existing document permission panel and role model: readers view, commenters submit feedback, editors maintain configuration and their own source authorizations, managers also manage access and remove other contributors' sources. A contributor alone can change their source scope. Concurrent changes use explicit revisions and return a conflict instead of overwriting another person's work.

A book uses a library resource for authorization. Ordinary document creation, move and copy cannot write into it. The title, permissions and deletion lifecycle remain host-owned. Generated pages are immutable release artifacts, not editable resource documents.

## Configure and run

1. Set the goal, model, first-level classification and maximum document depth.
2. Register sources. Short source lists use cards. Original resource access is checked for every source and descendant; an administrator's authority over the book does not grant authority over a source.
3. Adjust the X6 workflow graph. Drag nodes to arrange it, connect ports or choose inputs in the node panel, and edit rules, source selection, weights and acceptance selection. Saving validates input types, cycles, identifiers, reachability and a single publication node.
4. Define acceptance criteria. Required criteria must pass; every configured criterion must be evaluated before publication.
5. Start the persisted run, inspect node outcomes, and process any human tasks. A queued run is not a completed release.

Node types are source loading, human feedback loading, factual extraction, synthesis, document-tree organization, acceptance, human review and publication. Nodes run on a frozen configuration and input revision. Ordinary runs reject configuration or source changes. Explicitly continuing a failed pipeline uses its frozen configuration even if future runs have different settings; sources and feedback must still match. Source content is revalidated before publication. Unsupported formats, excessive input, incomplete extraction, invalid citations and model truncation fail visibly; there is no silent partial publication.

Daily and weekly schedules use UTC periods. Automatic publication is an explicit configuration option; otherwise successful acceptance creates a publication task. A failed run leaves the last published release unchanged and creates a repair task.

## Source groups and web discovery

**Run pipeline** fills the subpage with an independently scrolling execution list on the left and a canvas on the right. The list shows status, triggering person or schedule, start time and duration. Selection changes immediately, cached canvases appear while fresh authorized data loads, and late responses cannot replace a newer selection. The canvas requests a smaller authorized projection without full node bodies or dense provenance. Polling updates changed cells while preserving the viewport; it pauses outside this tab or when the browser is hidden. On narrow screens a failed pipeline initially locates its failed node. Select a run to see its frozen workflow; click a node to open its logs, error and human tasks in the right drawer. Logs contain actual source, batch, model-request/output-count and retry facts. Older unrecorded logs are not reconstructed. Status refreshes while running, and waiting time is included in total duration.

When an assistant starts or retries a run, it retains the original task while the worker executes. Background completion or a human decision wakes the same task, after current permission checks. It can explain an outstanding approval and wait for the decision; it does not approve for the user merely because a worker notification arrived. Installed plugins can use the same [public continuation service](plugin-ai-continuations.md).

One source card can bind multiple documents, libraries, files, folders, web pages or provider configurations, including mixed types. Only `{version: 1, items: [...]}` is accepted; every binding has a stable `id`. A group has at most 50 bindings, with no duplicates or nesting. Old single-input configurations are rejected without converting historical data. The contributor needs original access to every binding.

The web picker accepts bulk URLs and searches through the configured service, including SearXNG, with optional website constraints. Body validation, active-group saves and workflow source reads use the web reader configured in AI settings (built-in, Firecrawl, Jina or Tavily). Fragment URLs use HTML from the selected reader to verify and extract the exact section; Firecrawl and Jina support this, while Tavily requires a whole-page URL or a reader supporting HTML. Reader failures are reported without switching to another service. Search cards help discover sources; snippets are not evidence. Adding a URL verifies the actual body, selected fragment and size. Saving an active group fetches again on the server; a failed URL does not cause a partial save. Pausing retains configuration without a network check, while reactivation verifies again. Private source addresses, embedded credentials, missing fragments and unreadable pages are rejected; external readers receive only source URLs that pass the host's public-address check.

The same public `content.v1` provider serves native library subscriptions and knowledge books. There is no separate book-specific plugin registry. A group can select different configurations of one provider. Revoked binding or contributor access prevents new ingestion, and result reads still authorize concrete evidence references.

The workflow palette groups current node types into sources and feedback, AI knowledge processing, and review and publication. Click to add a node, configure its rules and connect its inputs. Cards show type, rule summaries and source/criterion scope. The dotted canvas supports curved links, panning, zoom, fit and expansion; moving or editing preserves the viewport. Escape collapses an expanded canvas. Canvas tools are left aligned; hide the node palette separately or hide the full toolbar and restore it with the compact canvas button. Publication remains unique and saving validates the complete workflow.

## Human intervention

All review nodes, publication approvals and failed nodes appear in **Human tasks**, both across books and within a book. Query by task type and status, view the actual candidate content and checks, and approve, reject or continue. Revision checks prevent duplicate resolutions. A stale task cannot approve changed inputs. Repair tasks continue the same frozen pipeline through `resume`; the separate `retry` API creates a new run from current configuration. Changed content reopens downstream human gates with a new task revision. Earlier resolutions, including the actor, note and timestamp, are retained in the host security audit when the same task is resolved again.

Define shared acceptance criteria once and reference them from multiple acceptance nodes through `criterionIds`. Keep domain-specific scope in node rules. Each node reviews a mandatory criterion independently; any failure blocks publication. Human review groups the common criterion while preserving the individual node conclusions.

**AI examples** prepare source, criterion and correction requests in the personal assistant for the user to review before sending. **My operation history** lists only the current user’s conversations associated with the book; other contributors’ chats and memory remain private.

Comments, corrections, supplements and questions are versioned workflow inputs. Add them directly or ask the personal AI assistant to register them. Feedback can refer to an immutable release, page and paragraph. Readers need original evidence access to anchor feedback to restricted content. Editing feedback creates an input revision; it never changes the published paragraph directly. Weighting and adoption belong to node rules; a high weight does not make an unsupported assertion true.

## Results and provenance

The default reading view shows the rendered document without feedback actions, evidence counters or decisions. Switch to **Review** to inspect paragraph evidence and submit anchored feedback. The published Markdown and provenance are unchanged by this view setting.

Tree titles wrap to show full chapter and page names, with expansion arrows before the directory title. Selecting a directory opens its first descendant document and expands its path; the arrow only changes expansion. The tree, document and management lists scroll independently.

The reader includes path breadcrumbs, heading styles, an active page outline and previous/next links in directory order. The outline appears on the right when space permits, and collapses above the text in narrow readers. Navigation uses actual Markdown headings, excludes fenced code comments and supports keyboard focus. Articles without headings have no invented paragraph outline; their stored content stays unchanged. New synthesis and organization runs request meaningful second- and third-level headings without rewriting historical releases. The host uses the shipped exmd `MarkdownPreviewInteraction` hook for rendered navigation and preserves original image authorization.

New content generation teaches the supported subject: definitions, components, mechanisms, conditions, exceptions, tradeoffs and examples, with real fenced Mermaid architecture/process diagrams where evidence supports them. Learning guidance is a short introduction rather than the whole result. Synthesis processes at most 40 claims per model request; organization groups bounded page inputs and preserves detail. Coverage checks reject omitted distinct supplied claims, long chapters without headings and organization that removes every supplied Mermaid diagram. Format repairs receive these diagnostics. Large generated chapters split at the current 200-paragraph page limit without discarding content. These checks apply to newly generated output; existing releases are not rewritten.

Results render through the existing read-only exmd preview. The interface shows a document tree, release selector, paragraph feedback controls, adoption reasons and validated source excerpts. It does not expose a Markdown source editor.

The provenance graph is created from actual node outputs. It connects source versions, cited excerpts, factual claims, adoption decisions, paragraphs, pages, execution nodes and the release. Human review decisions are also recorded. It is not a separately editable graph. View the whole graph or the ancestors of a selected page, and click nodes to inspect their evidence. The default display groups excerpts by source and groups claims in the current scope; identical relationships between displayed nodes become one counted edge. Click a group to inspect original members, or disable grouping for individual relationships. This changes the display only, retaining the original artifact and evidence.

Raw source bodies stay in the source system and transient execution memory. Releases and node logs retain only exact cited excerpts, hashes, source references and generated content; they do not maintain another full source-body archive. Native source updates do not rewrite a historical release. Original source permissions are checked when results or node logs are read. External deletion, unbinding or provider unavailability withholds affected results without deleting retained artifacts.

A contributor losing book edit access stops future ingestion. Already generated data is retained; retention does not grant display rights. If any model-context source is inaccessible, the combined result is withheld conservatively, including inputs omitted from model citations.

## Shared API

All routes use `/api/v1/knowledge-books`:

| Route                               | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `GET /`, `POST /`                   | List / create books                                                  |
| `GET /:id`                          | Current configuration, sources, feedback, runs and published release |
| `POST /:id/commands`                | Shared human / AI command dispatcher                                 |
| `POST /:id/source-search`           | Search configured web providers after book edit authorization        |
| `POST /:id/source-web-check`        | Verify actual URL bodies and selected fragments                      |
| `GET /:id/runs/:runId`              | Execution and candidate outcomes                                     |
| `GET /:id/runs/:runId/pipeline`     | Authorized canvas projection without full node bodies or provenance  |
| `GET /:id/releases/:releaseId`      | Immutable generated release                                          |
| `GET /human-tasks`                  | Query by book, run, node, query, kind, status and offset             |
| `POST /human-tasks/:taskId/resolve` | Approve / reject / resume / retry with expected revision             |

Commands are `configuration.save`, `configuration.patch`, `workflow.node.patch`, `workflow.node.add`, `source.remove`, `source.save`, `feedback.save`, `feedback.withdraw`, `run.start`, `run.cancel`, `run.resume`, `run.retry` and `run.publish`. Configuration, source and feedback saves require `expectedRevision`. The version 1 schemas in `packages/core/src/modules/knowledge-books/protocol.ts` are authoritative. The AI `knowledge_book` tool delegates to these same functions; personal assistant conversation and memory remain owned by the real user.

## Removal and database boundary

Old library curation and Q&A robots are removed: no curation conversations, workers, settings, instructions, entries or publication projection. Native documents, source subscriptions, indexing and search remain. The library navigation no longer shows the Sources and subscriptions entry; existing subscription records are retained.

The current database baseline is `doca-2026-10-09-history-storage-v1`. Knowledge-book tables remain; retired curation tables and fields stay disabled. Normal startup rejects earlier baselines and performs no automatic conversion. Only the exact preceding baseline supports the explicit offline history-storage upgrade in the [deployment guide](deployment.md#upgrade-from-0113). Retired file bindings remain stored and inaccessible; the retired curation protocol is not restored. Never delete an existing database to start the new host.

A failed or cancelled run can be continued through `run.resume`. It retains the same run ID and frozen workflow, completed nodes and failure logs. Source registrations, feedback, current original permissions and complete live source inventories are revalidated before continuation, including evidence identifiers, versions and content hashes. Added, removed or changed source content refuses continuation rather than silently mixing inputs. A rejected acceptance check restarts the closest upstream content-writing stage and its descendants, retaining extraction and unrelated branches; earlier checks are passed as repair diagnostics. Repeated failures and worker interruptions reuse the same node/task rows while retaining recorded failure facts and task decisions. Only current version 1 configuration is accepted; this performs no historical-format conversion, database migration or deletion.

The existing `run.retry` remains a separate new-run operation. A retry preserves the prior run and only reuses complete node outputs after checking the exact frozen configuration, source registrations, feedback, and complete current source inventories. Source failures and added/removed/changed blocks prevent reuse. Human gates and their descendants are evaluated again. Each reused node records its original run in the security audit and provenance. Every vendor call revalidates contributor grants, including extraction batches and format repairs.

The public view contains rendered results and provenance; it exposes no editable configuration or dummy workflow. Historical releases use the normal document history permission. Provenance can focus on a page or paragraph; execution/context edges can be included separately.
