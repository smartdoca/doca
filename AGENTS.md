# Doca development conventions

For Doca plugin loading, SDK exports, business-module extraction, AI usage policies,
or permission-directory contribution work, read `docs/plugin-sdk-contract.md`
and `docs/plugin-development.md` first. The implementation-status table distinguishes
existing exports from proposed APIs. Business plugins are discovered only through
the installation directory and consume public services, not host source paths or
global runtime bridges. Membership and content moderation belong outside the core;
authentication, authorization, security audit and original AI usage facts remain
host-owned. Do not delete persisted user data or silently release resource
restrictions during extraction.

For collaboration, editor SDK integration/upgrades, Yjs persistence, realtime selections or comment anchors, read and apply `skills/doca-collaboration/SKILL.md` and its linked contract before changing code. The same skill may be installed globally as `$doca-collaboration`.

The skill describes target invariants, not proof that a proposed API is implemented. Check the current package README/exports and compatibility before adapting. Keep `docs/collaboration-sdk-contract.md` as the source document and refresh the skill's packaged `references/contract.md` when it changes.

Do not run collaboration editing tests against user documents. Use isolated test databases/documents. Unrelated layout, calendar and visual styling tasks do not need the collaboration skill.

For editor package integration and cross-editor API work, also read `skills/doca-editor-integration/SKILL.md` and its integration reference. It distinguishes verified APIs from proposed capabilities; do not treat the target capability interface as already exported by a package.

For interface languages, locale props, or message catalogs in the host or an editor subpackage, read `skills/doca-i18n/SKILL.md`. `docs/i18n.md` is the source. The same skill may be installed globally as `$doca-i18n`. Dictionary keys are stable English identifiers.
