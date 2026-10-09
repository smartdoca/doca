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

Node types are source loading, human feedback loading, factual extraction, synthesis, document-tree organization, acceptance, human review and publication. Nodes run on a frozen configuration and input revision. Configuration or source changes invalidate the run. Source content is revalidated before publication. Unsupported formats, excessive input, incomplete extraction, invalid citations and model truncation fail visibly; there is no silent partial publication.

Daily and weekly schedules use UTC periods. Automatic publication is an explicit configuration option; otherwise successful acceptance creates a publication task. A failed run leaves the last published release unchanged and creates a repair task.

## Source groups and web discovery

One source card can bind multiple documents, libraries, files, folders, web pages or provider configurations, including mixed types. Only `{version: 1, items: [...]}` is accepted; every binding has a stable `id`. A group has at most 50 bindings, with no duplicates or nesting. Old single-input configurations are rejected without converting historical data. The contributor needs original access to every binding.

The web picker accepts bulk URLs and searches through the configured service, including SearXNG, with optional website constraints. Search cards help discover sources; snippets are not evidence. Adding a URL verifies the actual body, selected fragment and size. Saving an active group fetches again on the server; a failed URL does not cause a partial save. Pausing retains configuration without a network check, while reactivation verifies again. Private addresses, embedded credentials, missing fragments and unreadable pages are rejected.

The same public `content.v1` provider serves native library subscriptions and knowledge books. There is no separate book-specific plugin registry. A group can select different configurations of one provider. Revoked binding or contributor access prevents new ingestion, and result reads still authorize concrete evidence references.

The workflow palette groups current node types into sources and feedback, AI knowledge processing, and review and publication. Click to add a node, configure its rules and connect its inputs. Cards show type, rule summaries and source/criterion scope. The dotted canvas supports curved links, panning, zoom, fit and expansion; moving or editing preserves the viewport. Escape collapses an expanded canvas. Canvas tools are left aligned; hide the node palette separately or hide the full toolbar and restore it with the compact canvas button. Publication remains unique and saving validates the complete workflow.

## Human intervention

All review nodes, publication approvals and failed nodes appear in **Human tasks**, both across books and within a book. Query by task type and status, view the actual candidate content and checks, and approve, reject or retry. Revision checks prevent duplicate resolutions. A stale task cannot approve changed inputs. Retry creates a new run from current configuration. Resolved decisions retain the actor, note and timestamp.

Define shared acceptance criteria once and reference them from multiple acceptance nodes through `criterionIds`. Keep domain-specific scope in node rules. Each node reviews a mandatory criterion independently; any failure blocks publication. Human review groups the common criterion while preserving the individual node conclusions.

**AI examples** prepare source, criterion and correction requests in the personal assistant for the user to review before sending. **My operation history** lists only the current user’s conversations associated with the book; other contributors’ chats and memory remain private.

Comments, corrections, supplements and questions are versioned workflow inputs. Add them directly or ask the personal AI assistant to register them. Feedback can refer to an immutable release, page and paragraph. Readers need original evidence access to anchor feedback to restricted content. Editing feedback creates an input revision; it never changes the published paragraph directly. Weighting and adoption belong to node rules; a high weight does not make an unsupported assertion true.

## Results and provenance

The default reading view shows the rendered document without feedback actions, evidence counters or decisions. Switch to **Review** to inspect paragraph evidence and submit anchored feedback. The published Markdown and provenance are unchanged by this view setting.

Tree titles use one-line ellipsis with expansion arrows on the right. Selecting a directory opens its first descendant document and expands its path; the arrow only changes expansion. The tree, document and management lists scroll independently.

The reader includes path breadcrumbs, heading styles, an active page outline and previous/next links in directory order. The outline appears on the right when space permits, and collapses above the text in narrow readers. Navigation uses actual Markdown headings, excludes fenced code comments and supports keyboard focus. Valid articles without headings expose paragraph excerpts for navigation. New synthesis and organization runs request meaningful second- and third-level headings without rewriting historical releases. The host uses the shipped exmd `MarkdownPreviewInteraction` hook for rendered navigation and preserves original image authorization.

Results render through the existing read-only exmd preview. The interface shows a document tree, release selector, paragraph feedback controls, adoption reasons and validated source excerpts. It does not expose a Markdown source editor.

The provenance graph is created from actual node outputs. It connects source versions, cited excerpts, factual claims, adoption decisions, paragraphs, pages, execution nodes and the release. Human review decisions are also recorded. It is not a separately editable graph. View the whole graph or the ancestors of a selected page, and click nodes to inspect their evidence.

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
| `GET /:id/releases/:releaseId`      | Immutable generated release                                          |
| `GET /human-tasks`                  | Query by book, run, node, query, kind, status and offset             |
| `POST /human-tasks/:taskId/resolve` | Approve / reject / retry with expected revision                      |

Commands are `configuration.save`, `configuration.patch`, `workflow.node.patch`, `workflow.node.add`, `source.remove`, `source.save`, `feedback.save`, `feedback.withdraw`, `run.start`, `run.cancel`, `run.retry` and `run.publish`. Configuration, source and feedback saves require `expectedRevision`. The version 1 schemas in `packages/core/src/modules/knowledge-books/protocol.ts` are authoritative. The AI `knowledge_book` tool delegates to these same functions; personal assistant conversation and memory remain owned by the real user.

## Removal and database boundary

Old library curation and Q&A robots are removed: no curation conversations, workers, settings, instructions, entries or publication projection. Native documents, source subscriptions, indexing and search remain.

Fresh databases use `doca-2026-10-08-knowledge-books-v2` and create knowledge-book tables without old curation tables or resource curation columns. Existing baselines are rejected before schema changes. There is no old-format adapter, migration, conversion or data reset. Existing databases and retired file bindings are retained; retired bindings remain inaccessible. To roll back, stop this version and reopen the untouched old database with its matching old application. An existing database must not be deleted to start this version; use a separate empty database for an isolated trial.

A failed or cancelled run can be retried. A retry preserves the prior run and only reuses complete node outputs after checking the exact frozen configuration, source registrations, feedback, and complete current source inventories. Source failures and added/removed/changed blocks prevent reuse. Human gates and their descendants are evaluated again. Each reused node records its original run in the security audit and provenance. Every vendor call revalidates contributor grants, including extraction batches and format repairs.

The public view contains rendered results and provenance; it exposes no editable configuration or dummy workflow. Historical releases use the normal document history permission. Provenance can focus on a page or paragraph; execution/context edges can be included separately.
