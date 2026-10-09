# Platform service credentials

[中文](service-credentials.zh-CN.md)

Open Admin → Platform settings → Service credentials. The current host-managed platform record covers:

- Identity: named SSO client secrets and permitted HTTP(S) origins. Identity providers refer to the credential name.
- Verification gateway: HTTP(S) endpoint, bearer secret, and phone/email channels.
- Document search: Meilisearch API key and permitted origins.

File backend credentials and CloudFront signing keys are configured only in `DOCA_FILE_STORES_JSON`; the storage administration page is read-only. They are not editable in this platform record. [Plugin credentials](plugin-credentials.md) use the separate server-only encrypted service and its deployment master key.

## Persistence and configuration precedence

Platform settings are persisted under `account_settings`, ID `service-credentials`. Existing code seeds identity/messaging configuration from the runtime environment only when this record is absent; a saved record takes precedence thereafter. Changing environment variables does not overwrite the saved settings. This is an existing initialization path, retained and documented here without a new adapter or migration. A saved record containing the retired storage shape is explicitly rejected by the current host.

Database connections, site origin, listening ports, and file storage remain startup configuration. The database must be connected before persisted settings can be read. The first administrator still uses the explicit bootstrap command.

## API and secret handling

`GET` / `PUT /api/v1/admin/service-credentials` require a system administrator; mutations validate Origin. GET replaces configured secrets with null. On PUT, null retains the existing secret and an empty string clears it. Do not send a fake masking string. Revision checks prevent concurrent overwrites. Audit stores the action rather than secret values; endpoint protocol, origin, and redirect restrictions remain.

The server retains usable third-party credentials. Treat the database and backups as sensitive configuration. Saved secrets are not returned to ordinary users, public bootstrap, error logs, or administrator GET responses. Plugin credential encryption does not automatically re-encrypt these platform settings.

Every service process checks the settings revision before API requests and refreshes adapters after a change without restarting. Rotating the verification secret invalidates pending verification challenges. Storage credential changes follow the deployment-owned [storage rules](storage.md), including preservation of stable store IDs and referenced bytes.
