# File storage and uploads

[中文](storage.zh-CN.md)

This module stores avatars, library covers, document images, and attachments. The editor and the admin pages share the upload API. Document bodies store a stable asset id. A resource adapter resolves an authorized URL. Short-lived CDN signatures are not stored in the document.

## Local deployment

The default is local storage under `data/v1/uploads`, or `DOCA_UPLOAD_DIR`. The directory should be dedicated to the service, writable only by the service user, and outside the public static tree. A container needs a persistent volume. Do not point the setting at a new directory that already has files without moving those files. Backups cover the database, the upload directory, and server credential configuration.

Paths are generated as `objects/{uuid}`. User filenames are not joined into the disk path. Files are created with restricted permissions and never overwrite an existing object. `GET /api/v1/assets/:id/content` checks access. The static file tree cannot bypass that check.

## Cloud storage

S3-compatible storage is supported. Under Platform settings, Service credentials, Object storage, add a credential name, access key id, secret access key, and optional session token. Then under File storage choose cloud storage, the bucket, region, endpoint, and credential name. Allowed endpoint hosts are also set on the credentials page.

Secrets are stored in the database and take effect when saved. Reading the configuration does not echo them. Leave the endpoint empty for the default AWS S3 endpoint. Other services need an HTTPS root endpoint that is on the allowlist. An administrator may enable path-style when the vendor requires it. The allowlist is managed by the trusted operator. Do not allow an untrusted proxy, and restrict storage egress on the network.

The bucket must be private. Grant the credential `GetObject`, `PutObject`, and `DeleteObject` only under the `objects/` prefix. Do not use a public ACL. Connectivity of the region, bucket, and endpoint is checked on the first upload. Saving settings checks the shape and the server configuration. It does not claim the connection succeeded.

Changing storage creates a new configuration record and affects only later uploads. Old assets keep their old profile. Do not remove a bucket or credential alias that is still in use. Switching configuration is not a migration tool. Rotating a key may update the same alias. Do not point that alias at a different account.

## CDN and private files

The CDN path is the CloudFront signed-URL protocol, not a public hostname swap for an arbitrary CDN.

1. Create a CloudFront distribution with a private S3 origin and origin access control. The origin path matches the `objects/` key. Preserve `Content-Type` and `Content-Disposition`.
2. Require a trusted key group and signed URLs for every object. Neither the origin nor the distribution may offer an unsigned public bypass.
3. Under Service credentials, CDN signing, set the key id and PEM private key. The admin page stores a host such as `https://files.example.com`. The operator configures the certificate and DNS.
4. The app checks the latest ACL, then redirects to a signed URL that lasts 60 seconds. After access is revoked, no new link is issued. An already issued link can work for at most 60 seconds. Bytes already downloaded cannot be recalled.

Without a CDN, the app proxies private cloud files. The browser never sees the storage secret. Another vendor's signing scheme needs a new adapter. Doca does not fall back to a permanent public URL. Key groups for historical CDN settings must stay trusted, and every historical domain must keep working after a key rotation.

## Checks and permissions

- Avatars and covers are at most 5 MB. PNG, JPEG, WebP, and GIF are recognized from the file header and decoded. The limit is 25 million pixels. Metadata is removed and the image is stored as WebP. Avatars are cropped square, at most 512 px. Covers are at most 1600 px wide. A GIF keeps the first frame.
- Attachments are at most 20 MB. Recognized images are compressed to WebP, at most 2400 px. Other files are stored as the original bytes. SVG and HTML are not inlined as executable images. Ordinary files are served as attachments with `nosniff` and a sandbox. There is no virus scan.
- At most 4 concurrent uploads, and 60 attempts per user per 10 minutes. The API also checks recent upload records. A reverse proxy should add its own body size, connection, and storage limits. There is no per-user disk quota yet.
- An avatar draft is readable only by the uploader. After it is bound, signed-in users of the site can see it. Anonymous users cannot. A cover follows the library ACL. An unbound cover draft is readable only by the uploader. An attachment follows the document ACL. A system administrator has no extra read right. A cover requires manager. An attachment requires editor.
- The object is written first. A transaction then rechecks the user and the resource permission and records the asset. If recording fails, the uncommitted object is deleted when possible. Cover edits use the resource version. Avatar edits use the profile version.
- Finished but unbound avatar and cover drafts are kept for now. Scheduled orphan cleanup, quotas, virus scanning, and multipart upload are not done. A crash can leave an unregistered object. Cleanup must check every asset reference. Do not delete a shared object because one document was removed.

## Verification

Automated tests cover local upload, private permissions, image checks, avatar and cover binding, conflicts, and reading a historical configuration. S3 SDK calls and CDN signatures are simulated. They do not use live cloud credentials. Before production, verify a real bucket upload and download, a locked private origin, an expired signature, revocation, a network failure, and backup restore. PostgreSQL still needs a test against a real server.
