# Public resources, discovery, and collections

[中文](public-resource-discovery.zh-CN.md)

## Administrator policy

Under permissions and visibility, content permissions, public discovery, the administrator sets documents, libraries, Q&A assistants, and folders separately:

| Mode | Discovery catalog | Full-text search before collection | Personal search after collection |
| --- | --- | --- | --- |
| Link only | Hidden | Excluded | Included |
| Discoverable, searchable after collection | Shown, title query | Excluded | Included |
| Discoverable and searchable site-wide | Shown, title query | Included | Included |

The policy only changes how resources that are already public are distributed. It does not publish a private resource. If all four types are link-only, the public entry and the Visited and Collected tabs remain, and the Discover tab is hidden. The API does not return a resource that cannot be discovered.

Until a new policy is saved, older distribution settings keep their previous meaning. Saving writes four independent `publicModes`. Visit history is kept.

## Personal scope

A visit writes a visit record and does not collect the resource. Old automatic `source=opened` rows do not qualify for collection search and do not appear in the collection list. Direct grants, accepted invitations, and ownership still follow their own rules.

All four resource types use `resource_collections`, unique per user, resource type, and resource id. The public catalog does not hide a public resource you own or can already access. Collecting adds it to the list. It is not filtered by the previous grant.

Search candidates are the union of the previous scope, favorites, and the collection list. Results are checked against current access again. Removing a collection deletes only that list row. It does not change membership, invitations, or Q&A attachment preferences. A resource that was already searchable stays searchable. Collecting a Q&A assistant also includes it in retrieval. Removing it restores the previous attachment rule. Browsing a Q&A assistant does not collect it.

The first time the collection table is created, older manual document, library, and folder collections are copied in. Automatic joins, invitations, visit records, and Q&A attachment preferences are not treated as collections.

Search can switch among everything searchable, my scope, and site-wide public text. Site-wide text includes only resources the administrator allowed to be searched site-wide. Title queries in the discovery catalog do not call body search or vector search. File search and AI file retrieval also check container collection and the public search policy.

## Containers

Collecting a library or folder includes content that exists now and content added later. The query decides this dynamically. It does not copy a membership row onto every child.

A public library sets the reading scope of its pages. A page that turns off collaborator inheritance still cannot turn off public reading. The page can still configure edit, comment, and manage rights. Point lookups and list SQL use the same public-reading inheritance. A page inside a library uses the library discovery and search policy. A standalone document uses the document policy.

Folder publication is stored in `folder_publications`. Signed-in users may read current and future contents. They do not receive management. File management and download currently require sign-in. There is no anonymous file access. After publication is turned off, access follows current membership. A collection itself does not grant access.

The page permission panel shows the public library as a source. The folder share panel says the public scope includes current and future contents. Moving into a public container publishes with the container. Moving out uses the new location.

## Discovery UI

The public resources page has Visited, Discover, and Collected, filtered by document, library, Q&A, and folder. Visited includes link-only public resources the user opened and can still access. Visit history does not create search eligibility. Business lists no longer have a public-resources shortcut.

Home at `/home` summarizes recent visits across documents, libraries, Q&A, folders, and files, plus pending tickets and library decisions. Documents moved to `/documents` and keep recent visits, owned by me, collaborating, favorites, and my collections. The default All view for libraries and Q&A combines ownership, collaboration, favorites, and collections. It does not automatically show the site-wide public catalog. Shared folders have no favorites. They offer all, shared by me, shared with me, and collected.

Public lists offer collect and uncollect. A document's more menu includes collect, uncollect, and delete when the user may delete. Favorite and pin stay as shortcuts. The resource detail page does not add another collect entry.

Home statistics use data the current user can access. Tickets reuse the only-mine approval and accept steps. Library decisions reuse maintenance permission and the pending calibration. After they are handled they leave home. A source failure is shown on its own and is not presented as zero pending items. The first version uses built-in sources. There is no external plugin home SDK yet.

Documents and libraries use `resource_visits`. Q&A uses `knowledge_assistant_users.visited_at`. Files and folders, and Q&A favorites, use `workspace_activity`. Recent visits are authorized again, then merged and paged by time. Opening a file preview counts as a visit. A list thumbnail does not.

The first phase provides title query, updated-time order, stable paging, collecting, and batch uncollect. A library is shown as a container. Its pages are not flattened into the list. Queries use the database catalog. There is no new Meilisearch dependency and no recommendation feed.

## Verification

`tests/public-discovery.test.ts` uses an isolated database for per-type distribution, visits that do not collect, new container contents, revocation, catalog versus full text, Q&A attachment, folder management, paging, and HTTP configuration checks. Permission-inheritance tests follow the public-container reading rule.
