# Document and library permission inheritance

[中文](permission-inheritance.zh-CN.md)

This page describes the current permission model. Grants live in `grants`. Public link definitions live in `share_links`. Link revocation events live in `share_link_revocations`. There is no other membership compatibility table.

## Public reading

A public library (`public` or `authenticated`) sets the reading scope for every page in it. A page cannot cancel that baseline with its own visibility or by turning off collaborator inheritance. Edit, comment, and manage rights are still calculated from the page and inheritance. After the library is no longer public, pages use their own settings and their ancestors again. List queries and single-resource lookups use the same rule.

Discovery, search, and collection rules that differ by resource type are in [public resources, discovery, and collections](public-resource-discovery.md).

## One grant table

`grants` stores a row per resource, user, and grant source:

- `direct`: an invitation or a grant from the management page. At most one per user on a resource.
- `link`: a grant received from a share link, distinguished by the share id.
- `parent_override`: this node overrides or blocks the inherited parent result.

Each row stores the role, whether it includes descendants, the source id, and `active` or `disabled`. The management page aggregates sources per user and shows the final permission. Source details operate on a specific row. Deleting a direct grant can write a disabled `parent_override` so the permission does not fall back. Deleting that override restores parent inheritance. Revoking a link deletes only that share source.

Role and "include descendants" are separate. A descendant's permission is walked down the tree. Do not take the maximum of each field and invent a grant that does not exist.

## Collaborators and inheritance

The library is the root of the document permission tree. A library document inherits its parent document, or the library when it has no parent. A personal document has neither, and uses its own permissions.

For a named user, walk upward to the nearest explicit decision. A grant on the current node overrides a grant above it. A disabled `parent_override` blocks the parent grant. Inheritance continues only when this node has no decision. `include_descendants` decides whether a grant reaches descendants. A "this node only" decision cuts off the same user's grant from further above. A descendant can still receive its own grant.

Public permission and named-user permission are calculated separately, then the higher one is used. Removing a collaborator does not put that user on a public-resource block list. Anonymous public access is at most reader.

## Permission settings

`permission_overrides` is a bit set of fields this node explicitly overrides: public scope, public role, access requests, public discovery, reader history, and the master switch for link sharing. Fields that are not overridden resolve from ancestors. Restoring inheritance clears those bits.

Turning inheritance off does not copy the parent's settings. Existing overrides stay. Other fields use this node's defaults. Turning it on again resolves fields that are not overridden. Concrete share links, invitations, and tickets are not copied or inherited. Only the master link switch can be inherited.

Redeeming a link writes a `link` grant with the share id. Changing, disabling, or expiring a link controls later redemptions. Grants already written are adjusted or revoked through the member source.

Document and library links can grant reader, commenter, editor, or manager access. Only owners can create, change, or revoke manager links.

## Approval, notifications, and immediate effect

The requested role on an access ticket cannot change. Approval can choose the role and scope that are actually granted. Only the resource owner approves a management request, and only the owner can grant management.

The ticket runs a restricted `resource.grant` in one transaction. It rechecks the resource, the handler, and the requester, then writes the role, scope, result, and event. The database transaction and status conditions give a ticket one final result.

Lookups and lists use the same nearest decision, grant scope, and field overrides. Inheritance does not copy grants in bulk. After a permission change, affected online rooms refresh. Losing read access closes the connection immediately. Writes are checked on every operation.

## Verification

Isolated tests cover multi-level inheritance, downgrade, blocking, future children, grant scope, turning inheritance off and on, field overrides, the public baseline, revoking a link source, accepting an invitation, approval results, and WebSocket revocation.
