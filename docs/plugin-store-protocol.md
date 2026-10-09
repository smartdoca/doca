# Doca plugin store protocol v1

[中文](plugin-store-protocol.zh-CN.md)

Updated 2026-09-30, with current mandatory fields and navigation notes below. **Remote store implementations use this protocol.** It supersedes the earlier full-catalog/store-hosted-ZIP draft; that draft is not an accepted endpoint contract.

ZIP/npm installation, shared archives, multi-instance startup restoration, remote pagination, update checks, details, and Web/App navigation are implemented in source. External stores and independent plugins still require the acceptance checks below; source implementation does not prove every external service is live. Current SDK is `0.1.9`; verify examples against installed host versions and package exports.

## 1. Responsibilities and deployment

- The npm registry distributes complete precompiled packages. The store has no ZIP-download endpoint; review must inspect actual npm package bytes.
- The remote store owns metadata, categories, releases, approval/withdrawal, likes/download statistics, and rich-text details.
- Doca owns administrator authorization, installation transactions, integrity verification, shared archives, running versions, Web/App entries, and layouts.
- Likes and GitHub login occur on the remote website. Doca displays counts and offers a new page on click. It collects no remote login credentials and implements no like API, OAuth callback, or account binding.
- Manual npm and local ZIP/directory installations remain supported. Packages outside the reviewed catalog are labeled unreviewed; npm distribution alone is not official approval.

```dotenv
DOCA_PLUGIN_STORE_URL=https://store.smartdoca.cc
DOCA_PLUGIN_NPM_REGISTRY=https://registry.npmjs.org
DOCA_PLUGINS_DIR=/data/plugins
```

Store/registry addresses are HTTP(S) origins without credentials, path prefixes, query, or fragment. Empty values use defaults. Private registry login is unsupported in v1. The Doca server proxies store requests without browser Cookie, Authorization, user IDs, or business data; the remote service needs no browser CORS.

API prefix is `/api/v1`. JSON is UTF-8 and responses include protocolVersion:1. Times are UTC ISO 8601. Counts are nonnegative safe integers or null when unknown; unknown must not become zero. All endpoints are public read-only and need no store login.

## 2. Public types

### PluginSummary

```json
{
  "id": "example.mail",
  "name": "Mail",
  "summary": "Send and receive mail across multiple accounts.",
  "author": { "name": "Example", "url": "https://github.com/example" },
  "categoryId": "productivity",
  "icon": null,
  "detailPath": "/plugins/example.mail",
  "targets": ["web", "mobile"],
  "review": "approved",
  "official": false,
  "latestVersion": "1.2.0",
  "downloads": { "count": 1234, "period": "last30Days", "source": "npm", "asOf": "2026-09-30T00:00:00Z" },
  "likes": { "count": 42, "asOf": "2026-09-30T00:00:00Z" },
  "updatedAt": "2026-09-29T12:00:00Z"
}
```

Constraints:

- id matches manifest.id and `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, maximum 100 characters.
- name/author.name: 1–160 characters; summary: at most 300; all plain text.
- author.url: HTTP(S) URL or null for user clicks only, without automatic host fetching.
- categoryId: 1–60 characters matching `[a-z0-9-]+`. Fetch categories separately rather than infer them from a page.
- icon: PNG data URL or null, at most 24 KiB encoded; no SVG, scripts, or remote image URLs.
- detailPath: same-origin absolute `/plugins/<id>`, joined with the configured origin. Reject external origins, query/fragment, and traversal. New windows use noopener,noreferrer.
- targets: nonempty deduplicated web/mobile array. mobile means a controlled App WebView rather than dynamic native code.
- review: approved/suspended. Lists default to approved; details may return suspended.
- official: required boolean, separate from release review. Display official identity only for true, without inferring it from installation source. Missing official is a protocol error.
- latestVersion: latest approved stable release or null; it does not establish installability/upgradability on a particular host.
- Last-30-day npm downloads count package downloads, rather than Doca users/installations or version-specific downloads.
- Missing statistics still return objects with null count/asOf. Lists omit rich-text body, historical release arrays, tarballs, and full navigation.

### Release

```json
{
  "pluginId": "example.mail",
  "version": "1.2.0",
  "sdkRange": "^0.1.9",
  "dataVersion": "1",
  "targets": ["web", "mobile"],
  "mobileHostRange": "^1.0.0",
  "dependencies": [],
  "changelog": "Improve mail synchronization.",
  "review": "approved",
  "reviewedAt": "2026-09-29T12:00:00Z",
  "publishedAt": "2026-09-29T10:00:00Z",
  "npm": {
    "registry": "https://registry.npmjs.org",
    "name": "@example/doca-mail",
    "version": "1.2.0",
    "integrity": "sha512-BASE64_OF_SHA512_DIGEST",
    "size": 12345
  }
}
```

The digest above is a placeholder. Actual integrity must be one SRI value containing a standard-base64 SHA-512 digest of 64 bytes. npm.size is the exact tgz length, 1–33,554,432 bytes. npm.version, Release.version, package.json.version, and manifest.version must match.

version uses three-part semver, may include prerelease, excludes build metadata, and is at most 100 characters. sdkRange exactly matches manifest; current SDK is 0.1.9 and supported ranges are `*`, exact, `^`, and `~`. mobileHostRange is required for mobile targets and refers to mobile plugin-host protocol (v1:1.0.0), separate from App store build number and SDK compatibility.

dataVersion matches `[a-zA-Z0-9._-]{1,80}` without ordering; v1 upgrades require exact equality. dependencies contains at most 100 `{id,range,optional?}` Doca plugin dependencies, separate from npm dependencies. Missing dependency plugins are not automatically installed.

Release review is approved/withdrawn. Withdrawal prevents new installation without automatically unloading running versions. Higher npm releases cannot appear in official recommendations without approval. Review binds `(pluginId,npm.registry,npm.name,version,integrity,size)`; the same version cannot replace its package. Authors, statistics, and review state may change; package bytes/capability declarations are immutable.

changelog is a required plain-text string on release-list and exact-release endpoints, maximum 100000 characters. Empty means absent notes; preserve line breaks without executing HTML.

## 3. Categories

`GET /api/v1/categories?locale=zh`

```json
{"protocolVersion":1,"items":[{"id":"productivity","name":"Productivity","count":12}]}
```

At most 100 categories. locale is zh/en, default zh; missing translations use default labels. count is the approved visible catalog total or null, independent of current list filters.

## 4. Paginated search and ordering

`GET /api/v1/plugins?q=mail&category=productivity&target=mobile&sort=downloads&limit=24&locale=zh`

| Parameter | Rule |
| --- | --- |
| q | Optional; trimmed maximum 100 characters; remote matching searches name, summary, author, plugin ID, and npm name |
| category | Optional category ID; omitted means all |
| target | Optional web/mobile; omitted means unrestricted |
| sort | updated (default), downloads, likes, name |
| limit | 1–48, default 24 |
| cursor | Optional opaque cursor, at most 2048 characters |
| locale | zh/en, default zh |

```json
{
  "protocolVersion": 1,
  "items": [],
  "page": { "nextCursor": null, "total": 0, "snapshotAt": "2026-09-30T00:00:00Z" }
}
```

items is PluginSummary[] within limit. total is matching count or null; null nextCursor means the last page. Load More appends results from the same query only. Changing search/filter/order clears the cursor; cancel old requests or ignore late responses instead of mixing queries.

updated sorts descending updatedAt; downloads descending last-30-day count; likes descending; name ascending localized name. All use ascending id as a stable tie breaker. Unknown statistics follow known values.

Cursors bind normalized query, order, and result snapshot; continuation preserves snapshotAt. Snapshots last at least 15 minutes to avoid duplicates/missing entries as statistics change. Expiry returns 410 cursor_expired and restarts; mismatched parameters return 400 cursor_mismatch. Doca must not download the entire catalog to perform local search/sort/pagination.

A page is at most 2 MiB with a 15-second timeout. ETag is optional; Doca sends If-None-Match only with a matching cached response and uses that cache on 304.

## 5. Details and read-only rich text

`GET /api/v1/plugins/<id>?locale=zh`

```json
{
  "protocolVersion": 1,
  "plugin": { "id": "example.mail", "name": "See PluginSummary; return the complete object" },
  "description": {
    "format": "doca-slate",
    "version": 1,
    "nodes": [
      { "type": "heading", "level": 2, "children": [{"text":"Mail plugin"}] },
      { "type": "paragraph", "children": [{"text":"Supports multiple mail accounts.","bold":true}] }
    ]
  }
}
```

The abbreviated plugin object must actually be a full PluginSummary. Releases are paginated separately. The remote service edits/persists with slatetsx and converts into the transport subset below; Doca displays it read-only without saving, editing, or loading remote editor plugins. doca-slate does not accept arbitrary internal slatetsx nodes.

### Rich-text v1 nodes

- Text: `{text:string,bold?:boolean,italic?:boolean,underline?:boolean,strikethrough?:boolean,code?:boolean}`.
- paragraph: `{type:"paragraph",children:Inline[]}`.
- heading: paragraph structure with integer level 1–6.
- link: inline `{type:"link",url:string,children:Text[]}`; https/http/mailto only; reject control characters, javascript/data URLs; external windows use noopener,noreferrer.
- blockquote: `{type:"blockquote",children:Block[]}`.
- bulleted-list/numbered-list: `{type:...,children:ListItem[]}`; list-item: `{type:"list-item",children:Block[]}`.
- code-block: `{type:"code-block",language?:string,children:Text[]}`; render plain text without execution.
- image: `{type:"image",src:string,alt:string,children:[{text:""}]}`; PNG/JPEG/WebP data URLs, at most 1 MiB decoded per image (1,048,576 bytes). Reject SVG/remote URLs to avoid private-address requests and tracking. Doca 0.1.5 and earlier retains its original 256 KiB display limit; larger images need an updated client. This limit change neither migrates nor converts data; client rollback restores its former display limit. Total details remain within 2 MiB.
- divider: `{type:"divider",children:[{text:""}]}`.

Unsupported nodes retain safe text children with partial-display feedback. Unknown format/version shows an explicit message and remote details link, without executing HTML/JSX. Raw HTML, scripts, iframes, executable components, and event-handler fields are rejected. Limits: 5000 nodes, depth 16, 200000 text characters, and 2 MiB total response. The remote service converts unsupported tables/types to paragraphs/images. New types require coordinated protocol/renderer changes.

## 6. Releases and installation checks

`GET /api/v1/plugins/<id>/releases?limit=20&cursor=...`

Returns `{protocolVersion:1,items:Release[],page:{nextCursor,total,snapshotAt}}` with list rules and limit 1–48. Sort descending semver and default to approved stable releases; optional includePrerelease=true. Withdrawn versions are available only through exact lookup:

`GET /api/v1/plugins/<id>/releases/<version>`

Returns `{protocolVersion:1,release:Release}`. Installation refetches exact review state/digest rather than trust stale lists. Unknown versions return 404; withdrawn is explicit in a 200 response and cannot install.

### npm download

1. Check Release.npm.registry equals the configured registry (default npmjs); the store cannot choose arbitrary origins.
2. Fetch exact version metadata at `GET /<encodeURIComponent(packageName)>/<encodeURIComponent(version)>`, without latest/tag/range resolution.
3. Verify name/version and dist.integrity against approved SRI, then download dist.tarball.
4. The tarball is HTTP(S) at the registry origin without credentials/fragment; no redirects. Metadata: 2 MiB/15 seconds. Download: 32 MiB/120 seconds, exact size and SHA-512 validation.
5. Safely extract npm tgz under exactly one package/ wrapper. Accept ordinary files/directories only; reject symbolic/hard links, devices, absolute/traversal/duplicate paths. Skip POSIX pax x/g extension headers (used for mtime/xattr by npm/macOS libarchive), neither extracting them nor adopting their path overrides. Validate the following ustar path. Enforce at most 10000 entries and 128 MiB expanded data with streaming limits.
6. Verify package/manifest/review metadata and publish the complete archive/target state. Never run npm lifecycle scripts, npm install, or downloads for missing runtime dependencies.

Manual npm uses the same checks with configured-registry exact metadata, without official review. Store outages do not prevent manual installation; installed-plugin startup does not require npm/store availability.

## 7. Batch update checks

`POST /api/v1/updates/check`

```json
{
  "protocolVersion": 1,
  "host": { "sdkVersion": "0.1.9", "mobileHostVersion": "1.0.0" },
  "plugins": [
    { "id": "example.mail", "version": "1.0.0", "dataVersion": "1", "npm": {"registry":"https://registry.npmjs.org","name":"@example/doca-mail"} }
  ]
}
```

Send 1–100 distinct plugin IDs per batch, at most 128 KiB. Only installation metadata is submitted, excluding site identifiers, users, configuration, content, and credentials. Doca batches larger sets. Local packages without npm origin can omit npm and check official same-ID releases, without silently switching installation source.

```json
{
  "protocolVersion": 1,
  "checkedAt": "2026-09-30T00:00:00Z",
  "items": [
    {
      "id": "example.mail",
      "installedVersion": "1.0.0",
      "status": "update_available",
      "currentReview": "approved",
      "latestVersion": "1.2.0",
      "release": { "pluginId": "example.mail", "version": "Return the complete Release object" },
      "reason": null
    }
  ]
}
```

Return exactly one item per request, echoing installedVersion so stale responses cannot attach to a newly installed version.

| status | Meaning |
| --- | --- |
| update_available | Higher approved stable release compatible with SDK/dataVersion/mobile host; release is complete |
| up_to_date | No higher approved stable release; release=null |
| incompatible | Higher versions exist without a compatible candidate; release=null; reason=sdk/data_version/mobile_host |
| unknown | Unknown plugin or mismatched npm source; release=null; reason=not_found/source_mismatch |

currentReview is approved/withdrawn/unknown. Notify separately for withdrawn installed versions without automatic deletion/disablement. Doca rechecks local dependency plugins during installation; remote recommendations cannot guarantee the local dependency graph.

Choose the highest compatible release, rather than test only the latest. latestVersion is highest approved stable and may exceed release.version. Doca independently verifies version, SDK, data structure, and dependencies; remote recommendations are not authorization.

Check on Installed/Upgradable view opening, allow manual refresh, and cache at most 15 minutes. Installation invalidates that plugin's result. Failure shows failed/unknown instead of claiming everything is current. Do not suggest upgrades while uninstalling. Compare global target versions; running versions/restart state display separately. Out-of-catalog npm packages can check registry versions but remain unreviewed without automatic installation.

Batch responses: 2 MiB/15 seconds. Partial unknowns use item states; network/rate-limit/format errors use HTTP errors without fabricated normal results.

## 8. Packages and navigation

npm tgz contains package/package.json; local ZIP has package.json directly without a wrapper.

```json
{
  "name": "@example/doca-mail",
  "version": "1.2.0",
  "type": "module",
  "files": ["manifest.json", "dist", "web"],
  "doca": {
    "dataVersion": "1",
    "storage": "host",
    "manifest": "./manifest.json",
    "server": "./dist/server.js",
    "web": {"directory":"./web","entry":"./index.js"},
    "mobileHostRange": "^1.0.0",
    "navigation": [{
      "id": "example.mail.inbox",
      "title": {"zh":"邮箱","en":"Mail"},
      "icon": "mail",
      "webPath": "/plugins/example.mail/inbox",
      "mobile": true,
      "allowedSlots": ["web.left","web.top","web.topRight","web.right","web.user","web.home","web.more","mobile.drawer","mobile.bottom","mobile.topRight","mobile.account","mobile.home","mobile.more"],
      "defaults": ["web.left","mobile.drawer"],
      "order": 60,
      "adminOnly": false
    }]
  }
}
```

Precompile and bundle all runtime dependencies; no host source aliases, global bridges, or pnpm symlink trees. `doca.storage: "host"` is mandatory. Missing/other values are rejected before importing code during ZIP/npm/store installation, directory import, or startup restoration, without defaults/adapters. Server default exports a factory; Web defaults to host=>bundle using injected React. All persistence uses host services; plugins cannot choose local/remote persistence, create databases, or maintain persistent directories. Installed plugins implement business cleanup uninstall without deleting host paths; failure retains installation. See the [storage contract](plugin-horizontal-scaling.md) for managed capabilities and cleanup coordination.

Static package.json navigation IDs use the namespace and webPath stays under `/plugins/<plugin-id>/`; register the corresponding page in the Web bundle too. At most 30 entries. allowedSlots/defaults are deduplicated and defaults is a subset. No mobile slots without mobile declaration; mobile requires a Web page and mobileHostRange.

Current slots also include web.admin and web.leftMore. Left More requires explicit declaration; web.more remains upper-right. See [UI extensions](plugin-extensions.md). web.right is an entry toolbar rather than automatic embedding of arbitrary pages as side panels. Entries open pages; commands/views/panel presentation have a separate public contract.

Administrators configure Web/App visibility, position, order, and grouping in Doca. Layout is not remote-store configuration; plugins declare defaults and support only. Capacity overflow uses More. Disabled plugins disappear from running navigation. Hidden navigation does not revoke route/API access; host/plugins authorize every request.

Review checks targets against actual web/mobile declarations, sdkRange, dataVersion, dependencies, and package identity/version. Doca repeats verification. Release excludes complete navigation; the package is the capability source.

The App must first ship a build containing the mobile plugin host. Subsequent compliant pages load through controlled WebViews without downloading/executing React Native modules. Login uses host one-time tickets, never long-lived App bearer tokens in plugin scripts. Navigation/host-call scope follows the development guide.

## 9. Errors, cache, and withdrawal

```json
{"protocolVersion":1,"error":{"code":"not_found","message":"Plugin not found"}}
```

HTTP errors: 400 invalid_request/cursor_mismatch; 404 not_found; 410 cursor_expired; 429 rate_limited with Retry-After seconds; 503 unavailable. message is plain text, not a logic key. Do not return login HTML, redirects, or stack traces. Failure preserves local management and offers retry; installation cannot proceed without validation.

Details/exact review cache should last at most 60 seconds. Installation must revalidate exact versions without offline cache. Approval is not an absolute safety guarantee: server plugins execute in a trusted process, not a sandbox.

Internal review, author publication, GitHub login, and like writes are store-owned. Publication order: publish npm package → obtain immutable actual bytes → review/scan capabilities → publish approved Release → update summary/search index.

## 10. Multiple instances and activation

Installation stores complete archives and global target state in the shared host database; instances use private writable plugin directories. Startup verifies/restores files and rejects partial packages without accessing npm/store. Missing/corrupt shared archives fail explicitly.

Installation/upgrade/enable/disable/uninstall needs each instance restarted. Management reports the responding instance's running version without claiming cluster-wide activation. Compose uses `docker compose restart doca`; Kubernetes/operators restart instances progressively and drain old traffic for incompatible APIs.

Historical Web assets can be restored from shared archives without implying cross-version business API compatibility. Published navigation layouts take effect after client refresh without restart; package capability changes require upgrade/restart. Current uninstall runs business cleanup, clears data-version markers on success, and retains immutable archives. Managed-database/private-object cleanup and generation fencing are implemented. Cluster-wide business-task draining remains pending; plugins cannot delete directories themselves.

## 11. Integration fixtures

Provide at least:

1. Empty and more-than-two-page lists, search/category/platform filters, four sorts, expired/mismatched cursors.
2. Complete summaries, unknown statistics, suspended details, valid rich text, and unknown-node text degradation.
3. Release pagination; latest incompatible but lower compatible upgrade; all upgrades incompatible; withdrawn installed release; unknown/mismatched package.
4. Reviewed npm bytes and real SRI/size; reject replaced packages, digest/declaration mismatches, redirects, and extraction traversal.
5. 429/503/timeouts; store failure must not break local installed lists or current App business use.
6. Install on one instance; restart another with an empty directory and npm/store offline; restore from shared archive and repair corrupted local cache.
7. Web/App declarations/navigation; no App entry without mobile declaration; reject incompatible data upgrades.
8. Like clicks open the configured same-origin details page without calling a like API or starting Doca OAuth.

Mail integration can start from the original [mail-plugin integration guide v1](plugin-mail-integration-v1.md), retained as research material.

See [plugin development](plugin-development.md) and [SDK boundaries](plugin-sdk-contract.md). For host APIs use actual exported types; for the remote store use this wire protocol. Do not infer proposed host methods.

## Cross-repository acceptance

Run `pnpm exec tsx scripts/verify-plugin-store-contract.ts ../doca-plugin-store`. It exercises the store's actual routes with an in-memory database for categories (including zero counts), search, targets, pagination, details, releases, updates, and cursor expiry, without touching business databases or publishing npm.

/categories is a category list, not arbitrary multi-tagging; each plugin has one categoryId. Category counts cover all published plugins independent of search; page.total covers the query snapshot. Unknown downloads/likes display a dash, zero displays 0.

Review validates the same static navigation as the host: bilingual title (1–80 characters each), icon, order, nonempty allowedSlots, valid defaults, and no unknown fields. server is built JS/mjs/cjs, Web entry is JS, manifest is static JSON. Neither review nor installation executes package install scripts.

### Official identity and release notes

PluginSummary.official and Release.changelog are mandatory, as specified above. Official identity is independent of release review. Release notes display as plain text with line breaks; absent fields are protocol errors rather than implicit defaults.
