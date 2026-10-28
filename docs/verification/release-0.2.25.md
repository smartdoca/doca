# Doca 0.2.25 publication verification

Published on 2026-10-29. [PR113](https://github.com/smartdoca/doca/pull/113) ships Doca 0.2.25 and browser extension 0.2.11. The immutable `v0.2.25` tag points to `e8493c62d47f96b92e9091a2c77a157f3bf2f207`; this receipt does not move it.

The toolbar's new Open Doca website action passed real MV3 worker / closed-shadow tests for clicks, keyboard activation, Chinese/English, changed origin, signed-out use, setup routing and short viewports. All 171 extension/download tests, typecheck, production build, 104 bilingual documentation pages, six documentation tests, official editor npm source checks and deployment packaging passed. The older comprehensive dock fixture's unsuccessful run is retained separately and is not counted as passing; see [feature acceptance](browser-extension-open-site-2026-10-29.md).

Main-branch [PostgreSQL 17/18 regression](https://github.com/smartdoca/doca/actions/runs/40725015150) and [documentation checks](https://github.com/smartdoca/doca/actions/runs/40725015154) succeeded. This patch changes no database structures, server APIs, permissions or persisted formats. The existing Logo database requirements remain in the [0.2.24 release notes](../releases/0.2.24.md).

The [native image workflow](https://github.com/smartdoca/doca/actions/runs/40725179665) succeeded on both architectures, including original images, sign-in/logout/revocation, public/admin Logo behavior, rendering and runtime audits. Each architecture's 578 runtime files, 483 Web files and nine editor files match the final local build. Independent anonymous Registry reads verified raw SHA256 bytes, architecture, version and source labels for the index, manifests and configs.

[Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) serves `0.2.25` and, at publication, `latest` at:

`sha256:2f493f803a2ca9297396bb4b7a0d75a8653c2f162a31161de7ff22acd2ac49ea`

| Architecture | Manifest SHA256 |
| --- | --- |
| amd64 | `686f26c44204f555e055e26c3bcd27267e0d61bfea46eb7af9f73c1f3f862166` |
| arm64 | `e571a63a128065c3c63608b73e520492504068d8b4703f4af2d489097640ffd6` |

The [GitHub Release](https://github.com/smartdoca/doca/releases/tag/v0.2.25) and its [workflow](https://github.com/smartdoca/doca/actions/runs/40725895166) succeeded. All three public attachments were downloaded and matched their published sizes and SHA256 metadata. The 478 Web assets match both local and native builds; all ten deployment files match the local bundle, excluding local macOS AppleDouble metadata. The deployment checksum file is correct.

| Attachment | Bytes | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.25.tar.gz | 18,556 | `c35f2db0c3a61c51b821023064d6a493e25d136822d6cdcb1fb003a409a86994` |
| doca-deploy-v0.2.25.tar.gz.sha256 | 93 | `227f2bc736b9c001e36e1730b73e1cc0947693caeb7691509af077c7bdb144b2` |
| doca-web-assets-v0.2.25.tar.gz | 17,179,560 | `483b539938e8fa8bff0dcb85ddef59fe2e7f6aff059d87b9d03495c40a8126bb` |

Temporary release secrets were deleted and verified absent; their values were never saved. Logs, reports, downloads and screenshots remain in ignored `artifacts/verification/release-0.2.25/` and `artifacts/verification/browser-extension-open-site/`. No running Doca site was deployed. After updating the server, download/reload the extension and refresh webpages.
