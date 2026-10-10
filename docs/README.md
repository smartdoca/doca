# Doca documentation

[简体中文](README.zh-CN.md)

Doca is a document and knowledge workspace for individuals and small teams. This documentation covers the 0.1.17 release and clearly identified package contracts and implementation limits.

[Live demo](https://d.smartdoca.cc) · [Plugin marketplace](https://store.smartdoca.cc)

**Demo data is cleared from time to time. Please do not store important data in the demo.**

## Get started

- [Quick start](quickstart.md): clone → configure `.env` → pull the image → start → initialize the administrator password.
- [Capabilities and limits](features.md): core features, independent plugins, and unavailable capabilities.
- [Configuration](configuration.md): required settings and optional services.
- [User guide](user-guide.md): documents, libraries, files, search, and AI.
- [FAQ and troubleshooting](faq.md).

## User guides

[Documents and sharing](document-experience.md) · [Permissions](permission-inheritance.md) · [Discovery and collections](public-resource-discovery.md) · [Comments and notifications](comments-and-community.md) · [Knowledge books](knowledge-books.md)

## Deployment and operations

[Deployment](deployment.md) · [File storage](storage.md) · [Horizontal scaling](horizontal-scaling.md) · [Authentication](authentication.md) · [Service credentials](service-credentials.md) · [Webhooks](webhooks.md)

## Development and extensions

[Development setup](development.md) · [Architecture](architecture.md) · [Editor integration](editor-integration.md) · [Collaboration](collaboration.md) · [Internationalization](i18n.md) · [Plugin development](plugin-development.md) · [Plugin deployment](plugin-deployment.md)

## Reference and project records

[HTTP API](api.md) · [Database](database.md) · [Plugin SDK contract](plugin-sdk-contract.md) · [Plugin storage contract](plugin-horizontal-scaling.md) · [Collaboration contract](collaboration-sdk-contract.md) · [File exchange](editor-file-exchange-contract.md) · [Release 0.1.17](releases/0.1.17.md) · [Documentation maintenance](documentation.md) · [Research and acceptance records](research.md)

The running application provides `/api/openapi.json`. Proposed capabilities are labeled in the relevant contract; a design record does not establish that an API is exported. Research records retain their original language and date.
