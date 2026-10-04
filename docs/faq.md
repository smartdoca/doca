# FAQ and troubleshooting

[中文](faq.zh-CN.md)

## Is there a default administrator password?

No. Run `bash scripts/bootstrap-admin.sh` after the container is healthy. Passwords must contain at least 12 characters. For an existing account, use `bash scripts/reset-admin-password.sh`; initialization is not a password reset.

## Why does the browser not connect to port 39120?

Compose binds the port to server loopback. Production expects the HTTPS origin configured in `DOCA_ORIGIN`, reached through a reverse proxy. Do not open a production deployment using `http://server-ip:39120`. Check DNS, TLS, proxy headers, and WebSocket forwarding. See [deployment](deployment.md).

## Which environment example should I use?

For the published Docker image, copy `docker.env.example`. For source development, copy `.env.example`. Configure `DOCA_ORIGIN`, `DOCA_FILE_STORE_ID`, and `DOCA_FILE_STORES_JSON` before starting Compose. See [configuration](configuration.md).

## Why do I get 421, 403, or a disconnected editor?

421 usually means the request Host does not match the configured origin. Mutation requests require the same Origin; a mismatch returns 403. Editing also requires authorization and a working WebSocket upgrade on `/api/v1/ws`. Check the browser address, proxy configuration, account state, and current resource permission.

## What should I do if startup rejects the database baseline?

Stop and read the matching [release requirements](releases/0.1.10.md). Doca 0.1.10 does not automatically migrate older databases. Preserve the old deployment, database, files, and secrets for rollback. Do not delete tables, reset the volume, or change the baseline marker to force startup.

## How do I inspect startup problems?

```sh
docker compose config --quiet
docker compose ps
docker compose logs --tail=100 doca
curl -fsS -H 'Host: doca.example.com' http://127.0.0.1:39120/health
```

Run these on the server in the checkout containing `compose.yaml`. Do not publish logs containing secrets. For source development use `http://127.0.0.1:39130` and the development configuration.

## Are GitHub Pages and the Doca application the same deployment?

GitHub Pages hosts this static documentation website. Doca's application requires its container/server, databases, persistent files, and HTTPS proxy. A documentation-site update does not start or upgrade a Doca application.

## Can I update or restart without deleting my files?

An ordinary `docker compose restart` preserves the persistent volume. Configuration changes use `docker compose up -d`. Before changing image versions, read the release notes and back up every database, referenced file store, and protected configuration. Avoid `docker compose down -v`, which deletes the volume.

## Why is a plugin or an external service unavailable?

Plugin packages must satisfy the current SDK and storage contract. Restart every instance manually after installation changes. Plugins using encrypted credentials need the same persistent master key on every replica. AI, SSO, search, and cloud-storage availability also depends on real credentials and network connectivity; source tests do not establish live-service acceptance. See [plugin deployment](plugin-deployment.md).

Use the actual configured host in the health command above. A 421 indicates a Host mismatch, including when probing loopback. No proxy is trusted by default; shared proxy IP limits require a narrowly configured `DOCA_TRUST_PROXY`.
