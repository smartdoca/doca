# File storage and uploads

[中文](storage.zh-CN.md)

This module stores avatars, library covers, document images, and attachments. The editor and the admin pages share the upload API. Document bodies store a stable asset id. A resource adapter resolves an authorized URL. Short-lived CDN signatures are not stored in the document.

## Environment configuration

File storage is selected with required `DOCA_FILE_STORE_ID` and `DOCA_FILE_STORES_JSON`. Both environment examples use `/data/storage`, matching the published container's persistent volume. For source development, copy `.env.example` and set the local root to an absolute writable directory on your machine. Compose uses `docker.env.example`. The database records stable storage IDs and object references, not backend credentials. The administration page is read-only.

```dotenv
DOCA_FILE_STORE_ID=local
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"local":{"provider":"local","root":"/data/storage"}}}'
```

Use a dedicated persistent directory, writable only by the service user and outside the static web tree. Multiple instances must share the same physical backend. Backups cover the database, every referenced file store and protected deployment configuration. A referenced storage ID must remain configured; changing its physical path or bucket does not move its bytes.

Version 0.1.10 rejects the old database baseline, database-managed storage configuration and old plugin installation list. Old data is preserved without migration or conversion. Deploy to a new empty database and separate storage; see [release requirements](releases/0.1.10.md).

## Docker uploads fail with EACCES

If `/api/v1/assets` returns HTTP 500 and the container logs report `EACCES: permission denied, mkdir '/app/data'`, check the active local store's `root` in `DOCA_FILE_STORES_JSON`. The image runs as `node` with `/app` as its working directory; Compose mounts its persistent volume at `/data`. A development root such as `./data/v1/storage` resolves to `/app/data/v1/storage`, outside that writable volume.

For a store that has never contained successfully uploaded files, set its root to `/data/storage`, keeping the same store ID and all other store entries. Apply the environment change by recreating only the application container:

```sh
docker compose up -d --no-deps --force-recreate --pull never --no-build doca
```

If the store already contains files, inspect and back up its actual directory and database before changing its root. Agree on a plan that preserves the object bytes and their existing keys at the configured location, then verify an existing download and a new upload. Changing configuration does not move files. Do not remove the data volume or reset the database to repair a path or permission error.

## Namespaces and access

The host generates object paths under `host/`; plugin-created ordinary files use `plugins/<pluginId>/`. Private plugin objects and immutable installation ZIPs use separate generation/object paths and `host/plugin-releases/<sha256>.zip`. User filenames do not determine physical paths. Stable file/folder IDs and host authorization remain in use. `GET /api/v1/assets/:id/content` checks access; static serving cannot bypass it. See [the exact storage implementation](unified-storage-implementation.md).

## S3 and CDN

A store with `provider:"s3"` requires `bucket`, `region`, `forcePathStyle` and `credentials:{accessKeyId,secretAccessKey,sessionToken?}` in the environment JSON. An optional `endpoint` is an HTTP(S) root origin without credentials, a subpath, query, or fragment. HTTP is intended for an explicitly configured endpoint on a trusted internal network; the application does not resolve DNS to classify a destination as private. The operator controls these destinations and network egress; no credential or endpoint is configured through the administration UI. The bucket stays private; grant only the necessary read/write/delete operations for the host and plugin prefixes. Configuration validation does not prove real connectivity.

For RustFS on a shared container network, create a private bucket and configure its S3 API listener (default port `9000`, console port `9001`) with path-style addressing. Match `region` to `RUSTFS_REGION`, which defaults to `us-east-1`:

```dotenv
DOCA_FILE_STORE_ID=cloud
DOCA_FILE_STORES_JSON='{"version":1,"stores":{"cloud":{"provider":"s3","bucket":"doca-files","region":"us-east-1","endpoint":"http://rustfs:9000","forcePathStyle":true,"credentials":{"accessKeyId":"replace-me","secretAccessKey":"replace-me"}}}}'
```

Use a hostname or internal address reachable from the Doca container. Site, asset and CDN origins also accept HTTP(S). See the [RustFS S3 documentation](https://docs.rustfs.com/zh/administration/protocols/s3). This example is for a new installation; changing an existing store's endpoint does not move its objects.

Optional `cdn:{domain,keyPairId,privateKey}` uses the CloudFront signed-URL protocol. Configure a private S3 origin with OAC and a trusted key group requiring signed URLs; the CDN must preserve complete object keys, content type and disposition. The environment contains the HTTP(S) distribution origin and PEM signing key. After checking the latest ACL, the host issues a URL valid for 60 seconds. Revocation prevents new links; an existing link can remain usable until it expires. Downloaded bytes cannot be recalled.

Without a CDN, the host proxies private cloud files. Storage secrets are never returned to the browser. A different CDN signing protocol requires an adapter; no permanent public-URL fallback is provided. Keep every referenced store ID configured and preserve access to its bytes during credential rotations. Rotation is not a data migration.

## Browser image caching and the file CDN

Ordinary document/comment images and host-proxied avatars/covers use the stable `/api/v1/assets/:id/content` URL. Successful inline image responses, including thumbnails, send:

```http
Cache-Control: private, max-age=3600, must-revalidate
Vary: Cookie, Authorization
ETag: W/"object-and-variant-identity-digest"
```

The browser can reuse its local copy for an hour. Once stale, `If-None-Match` revalidates it: the host checks current access before returning `304` without image bytes. Originals and thumbnails have distinct ETags. Object keys are immutable; replacing an image requires a new asset. Cookie/Authorization changes select a separate cached response when switching accounts. Revocation is not rechecked during freshness; downloaded bytes cannot be recalled. Browsers can evict entries, and force reload/DevTools **Disable cache** can bypass them. This uses HTTP caching without an additional IndexedDB or Service Worker copy. See [MDN HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching) for revalidation versus `no-store`.

AI attachments, `download=1`, trash previews and errors remain `no-store`. An unauthorized request cannot obtain `304` with a known ETag. Document images have a resourceId and currently stay behind the host proxy even when an S3 file CDN is configured.

Signed file-CDN redirects stay `no-store` so the browser does not reuse an expired 60-second signature. Final file-response headers belong on the CDN or S3 origin; redirect headers do not carry over. New S3 objects currently use `Cache-Control: private, max-age=60`; this change does not rewrite existing objects.

For a CloudFront private-file behavior, preserve the private S3 origin/OAC, trusted key group and 60-second signing window. Set **Response headers policy → Custom headers** to `Cache-Control: private, max-age=60, must-revalidate` with **Override** to standardize browser responses for existing and new objects. Use **CachingDisabled** unless edge caching has been separately planned; a custom policy must have Minimum TTL 0. A positive minimum can override origin `private/no-store`. Response headers policies affect browser-facing responses, independently of edge TTL. See AWS documentation for [response headers policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html), [cache-policy TTLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html) and [signed URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html). Never apply public long-lived caching to the site or `/api/*`.

Changing signature query parameters creates a different browser URL; adding headers alone does not ensure reuse across signatures. Stable document image URLs avoid this limitation. Edge-cache hits and browser-cache hits are separate measurements.

For acceptance, turn off DevTools **Disable cache**, revisit a document and inspect memory/disk cache hits. Verify conditional reads return bodyless `304`, then check logout, permission denial, thumbnails, download and trash preview. Inspect the final CDN response as well as the redirect. Keep cookies and signed URLs out of public logs:

```sh
curl -I -H 'Cookie: doca_session=<session>' https://doca.example.com/api/v1/assets/<asset-id>/content
curl -I -H 'Cookie: doca_session=<session>' -H 'If-None-Match: W/"<first-response-digest>"' https://doca.example.com/api/v1/assets/<asset-id>/content
curl -I 'https://files.example.com/<object-key>?<valid-signature-parameters>'
```

Hashed public JS/CSS need the separate one-year policy in [deployment: static assets](deployment.md#static-assets).

## History storage and offline upgrade

The database keeps the latest 20 full business snapshots. Each complete group of ten older snapshots retains its newest point in the configured file store (cloud storage when S3 is configured). A point is one gzip JSON file preserving its checkpoint and independent recovery metadata, with one small database index. Only immutable upload and SHA-256 readback success permit an atomic index commit and removal of the ten database rows; the other nine points are deliberately sampled away and cannot be restored. Incomplete groups and storage failures retain database originals. One ordinary paginated list merges both sources without exposing storage types, object keys or signed URLs.

Live checkpoints, uncovered collaboration increments and attachments are not sampled. Trash preserves history; explicit permanent resource deletion queues archive reclamation after an hour and a reference recheck. No old recovery_json is decoded into a new schema or filled from the current baseline. Missing recovery metadata and unknown recovery versions still reject previews. Files require envelope v1, a matching hash, bounded decompression and index agreement. Background durable jobs retry failures without blocking content commits.

The new database baseline is `doca-2026-10-09-history-storage-v1`; normal startup does not read old baselines. Upgrade accepts only `doca-2026-10-08-knowledge-books-v2`. Stop every host, back up the database, file store and configuration, then run:

```sh
pnpm history:upgrade                 # Show requirements; no mutation
pnpm history:upgrade --apply         # Add structure, update baseline and queue work; no immediate sampling
```

Do not rebuild the database instead of upgrading. A failed upgrade transaction preserves the original database. Before returning to the previous host, stop every instance and import retained file-backed points:

```sh
pnpm history:rollback --apply --manifest /backup/history-cloud-references.json
```

The manifest must be a new file and is written with mode 0600. Rollback saves cloud references, validates and imports retained points, then returns to the previous baseline; cloud files remain preserved. An interrupted rollback uses a dedicated marker that rejects host startup, preventing imported points from being sampled again. Fix the storage issue and rerun rollback with a new manifest path. Sampled-away points require a complete pre-sampling database backup. User-facing restore still applies the current epoch, permissions and expectedSeq checks; rich text and Markdown restore, while other formats remain preview-only.

## Checks and permissions

- Avatars and covers are at most 5 MB. PNG, JPEG, WebP, and GIF are recognized from the file header and decoded. The limit is 25 million pixels. Metadata is removed and the image is stored as WebP. Avatars are cropped square, at most 512 px. Covers are at most 1600 px wide. A GIF keeps the first frame.
- Document/AI attachment uploads are at most 20 MiB and preserve original bytes; recognized raster images are validated with a 25-million-pixel limit. Avatar/cover/comment image paths normalize images to WebP with purpose-specific limits. Ordinary user files use a separate streaming upload API with a 2 GiB limit. SVG and HTML are not inlined as executable images. Ordinary files are served as attachments with `nosniff` and a sandbox. There is no virus scan.
- At most 4 concurrent uploads, and 60 attempts per user per 10 minutes. The API also checks recent upload records. A reverse proxy should add its own body size, connection, and storage limits. There is no per-user disk quota yet.
- An avatar draft is readable only by the uploader. After it is bound, signed-in users of the site can see it. Anonymous users cannot. A cover follows the library ACL. An unbound cover draft is readable only by the uploader. An attachment follows the document ACL. A system administrator has no extra read right. A cover requires manager. An attachment requires editor.
- The object is written first. A transaction then rechecks the user and the resource permission and records the asset. If recording fails, the uncommitted object is deleted when possible. Cover edits use the resource version. Avatar edits use the profile version.
- Finished but unbound avatar and cover drafts are kept for now. Scheduled asset-draft cleanup, per-user quotas, and virus scanning are not done. Ordinary user-file uploads have S3 multipart support from 32 MiB with 8 MiB parts; this is separate from the bounded asset endpoint. A crash can leave an unregistered object. Cleanup must check every asset reference. Do not delete a shared object because one document was removed.

## Verification

Automated tests cover local uploads, private permissions, image checks, binding, conflicts, stable storage IDs, plugin namespaces and immutable archive integrity. Isolated PostgreSQL integration and two-instance local browser checks passed. S3 SDK calls and CDN signatures are simulated; real cloud credentials were not used. Real bucket upload/download, private origin enforcement, signature expiry, revocation, network failure and backup restore still need service-specific acceptance. See [the browser acceptance report](storage-browser-acceptance.md).
