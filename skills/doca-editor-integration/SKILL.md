---
name: doca-editor-integration
description: Integrate or standardize any document-type editor subpackage (rich text, spreadsheet, Markdown, canvas, slides, and future formats) in Doca and online-office modules, including resource callbacks, readonly behavior, custom inline elements, toolbar commands, find/replace and host-owned permissions. Use when developing a subpackage, adapting editor packages, or defining their host API, not for unrelated application UI.
---

# Doca editor integration

Read [the integration contract](references/integration.md) before changing a package boundary. It separates verified slatetsx APIs from target capabilities for other editors. Inspect the installed artifact's README and exported types before using any method; do not assume a proposed API exists.

This boundary contract applies to every document-type subpackage, current and future — the per-format sections are instances of one shared host/package boundary. Subpackage developers and Doca host developers maintain it together: boundary changes require agreement on both sides, and the project docs and every packaged skill copy (project `skills/` and user skills directories) are updated in the same change.

Keep the package responsible for its document model, editing commands, selection, undo, atomic nodes and format-specific rendering. Keep identity, user lookup/cards, assets/ACL, discovery policy, notifications, business references and networking in the host. Do not import Doca routes, cookies, user directory or deployment domains into a reusable editor package.

For collaboration work also follow the project's collaboration contract. A unified component surface is not permission to change a codec, rebuild existing documents or add another autosave channel.

Implement the document scenario first and prove its behavior. Other modules reuse lifecycle and capability semantics, not Slate types or DOM implementation details. Explicitly mark unsupported capabilities; a spreadsheet should not pretend to have text ranges or permanent anchors based on transient A1 coordinates.

Before handoff verify actual package roundtrips, readonly guards, media permission checks, stable props, atomic clipboard behavior, model-based replacement/undo, and two-client convergence for affected operations. Tests use isolated data. Record what is shipped, host-adapted, proposed upstream, and unverified. A build is not evidence of collaboration correctness.

For file import/export or conversion-package upgrades, also read [file exchange](references/file-exchange.md). Accept documented lossy conversion when it meets the requested basic-content fidelity; preserve host-owned assets/ACL and distinguish real file formats from internal JSON/recovery models.
