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

A store with `provider:"s3"` requires `bucket`, `region`, `forcePathStyle` and `credentials:{accessKeyId,secretAccessKey,sessionToken?}` in the environment JSON. An optional `endpoint` is an HTTPS root origin. The operator controls these destinations and network egress; no credential or endpoint is configured through the administration UI. The bucket stays private; grant only the necessary read/write/delete operations for the host and plugin prefixes. Configuration validation does not prove real connectivity.

Optional `cdn:{domain,keyPairId,privateKey}` uses the CloudFront signed-URL protocol. Configure a private S3 origin with OAC and a trusted key group requiring signed URLs; the CDN must preserve complete object keys, content type and disposition. The environment contains the HTTPS distribution origin and PEM signing key. After checking the latest ACL, the host issues a URL valid for 60 seconds. Revocation prevents new links; an existing link can remain usable until it expires. Downloaded bytes cannot be recalled.

Without a CDN, the host proxies private cloud files. Storage secrets are never returned to the browser. A different CDN signing protocol requires an adapter; no permanent public-URL fallback is provided. Keep every referenced store ID configured and preserve access to its bytes during credential rotations. Rotation is not a data migration.

## Checks and permissions

- Avatars and covers are at most 5 MB. PNG, JPEG, WebP, and GIF are recognized from the file header and decoded. The limit is 25 million pixels. Metadata is removed and the image is stored as WebP. Avatars are cropped square, at most 512 px. Covers are at most 1600 px wide. A GIF keeps the first frame.
- Document/AI attachment uploads are at most 20 MiB and preserve original bytes; recognized raster images are validated with a 25-million-pixel limit. Avatar/cover/comment image paths normalize images to WebP with purpose-specific limits. Ordinary user files use a separate streaming upload API with a 2 GiB limit. SVG and HTML are not inlined as executable images. Ordinary files are served as attachments with `nosniff` and a sandbox. There is no virus scan.
- At most 4 concurrent uploads, and 60 attempts per user per 10 minutes. The API also checks recent upload records. A reverse proxy should add its own body size, connection, and storage limits. There is no per-user disk quota yet.
- An avatar draft is readable only by the uploader. After it is bound, signed-in users of the site can see it. Anonymous users cannot. A cover follows the library ACL. An unbound cover draft is readable only by the uploader. An attachment follows the document ACL. A system administrator has no extra read right. A cover requires manager. An attachment requires editor.
- The object is written first. A transaction then rechecks the user and the resource permission and records the asset. If recording fails, the uncommitted object is deleted when possible. Cover edits use the resource version. Avatar edits use the profile version.
- Finished but unbound avatar and cover drafts are kept for now. Scheduled asset-draft cleanup, per-user quotas, and virus scanning are not done. Ordinary user-file uploads have S3 multipart support from 32 MiB with 8 MiB parts; this is separate from the bounded asset endpoint. A crash can leave an unregistered object. Cleanup must check every asset reference. Do not delete a shared object because one document was removed.

## Verification

Automated tests cover local uploads, private permissions, image checks, binding, conflicts, stable storage IDs, plugin namespaces and immutable archive integrity. Isolated PostgreSQL integration and two-instance local browser checks passed. S3 SDK calls and CDN signatures are simulated; real cloud credentials were not used. Real bucket upload/download, private origin enforcement, signature expiry, revocation, network failure and backup restore still need service-specific acceptance. See [the browser acceptance report](storage-browser-acceptance.md).
