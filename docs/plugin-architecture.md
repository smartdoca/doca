# Plugin architecture

[中文](plugin-architecture.zh-CN.md)

The [SDK contract](plugin-sdk-contract.md) defines the boundary between the core and business plugins. The [development guide](plugin-development.md) lists the interfaces that exist now.

`plugin-contracts` defines the manifest and lifecycle. `plugin-sdk` provides injection, events, contributions, and effects. `plugin-host` checks dependencies and starts plugins, then disposes them in reverse order. Composition assembles core files, documents, search, and AI, then loads business plugins from the separate installation directory.

A business plugin talks to the host through the public files, users, permissions, http, policies, events, and ai services. Registration belongs to the plugin instance. A plugin does not reach into the host's private database types or a process-wide bridge. A web plugin ships its own build, and the active manifest loads it.

The host keeps authentication, authorization, files, document collaboration, security audit, original AI usage, and token usage rated by the model. Membership, points, prices, content moderation, and mail are not core tables, tools, or pages. A future mail plugin owns its backend, data, and acceptance tests.

A generic tree slot, more business services, and a fund reservation protocol are still listed by implementation status in the contract. A proposed API is not an export you can call.

All durable plugin state is host-managed. Packages must declare `doca.storage: "host"`; plugins own models/authorization, not drivers, storage paths or local/remote configuration. Managed SQL and private objects are exported in SDK 0.1.7; server-only encrypted credentials are exported in SDK 0.1.9. See the [storage contract](plugin-horizontal-scaling.md).
