# Doca 0.2.26 publication verification

Published on 2026-10-30 (Asia/Shanghai). [PR116](https://github.com/workhold/doca/pull/116) integrates the official Sheet 0.2.15 package and the search/directory fixes. The immutable `v0.2.26` tag points to `37e197e4027d9c760c2c04b8dee690c830a25da5`; this verification update does not move it.

All 82 installed Sheet files match the official npm archive. Its SHA256 is `9e3b3a0a528b82d19f6f6468694562163d2d2c77b04338d3734f52cda4fa0b99`. Exports and dependencies are unchanged; declaration differences are generated import hashes and unordered union members. Model/Yjs/preferences/XLSX's eight JS runtimes and CSS match 0.2.14. No host scroll patch, new props, schema adapter or persisted-data conversion is introduced. Existing historical readers and approved defaults retain their established paths.

Local acceptance passed 232 tests across 30 files; the existing Redis cross-instance case was skipped because `DOCA_TEST_REDIS_URL` was not configured. Typecheck, production build, six documentation tests, 105 bilingual documentation pages, official editor source checks and deployment packaging passed. The frozen-lockfile install passed all 2,046 supply-chain entries. [PostgreSQL 17/18 PR checks](https://github.com/workhold/doca/actions/runs/40912672967), [main checks](https://github.com/workhold/doca/actions/runs/40914323221) and [documentation publication](https://github.com/workhold/doca/actions/runs/40914323132) succeeded.

Production Web acceptance uses isolated accounts/documents. Five frozen-edit scenarios cover second-row editing, 180/15 px frozen heights and 50%/150% zoom; toolbar text clicks work, and entering/cancelling drafts plus 60 seconds idle preserve seq/checkpoint. Released 0.2.25 Web reproduces the 150 px obstruction as a negative control; the new Web keeps the target visible. Four clients verify native filter confirmation/append, durable ACK, one transaction, peer projection without echo, undo/redo, reload and 61.071 seconds idle without content writes or page errors. Search empty-state and directory drag/error feedback checks also passed. Early production probes read a React ref before grid readiness; their failures are retained separately, and the QA helper now waits for the native grid and uses wheel input. This was not an SDK regression. See [issue verification](issue-record-host-2026-10-29.md).

The [native image workflow](https://github.com/workhold/doca/actions/runs/40914525256) succeeded on amd64 and arm64, including original images, sign-in/logout/revocation, Logo behavior, rendering and runtime audits. Each architecture's 578 runtime files, 483 Web files and nine editor files match its comparison build. Independent anonymous Registry reads verified raw index/manifest/config SHA256 bytes, architectures and source/version labels.

[Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) serves `0.2.26` and, at publication, `latest` at:

`sha256:524435ef135d31c911e90e18873aabc509a9a1e794fc89d3ec774a5eb75c9df5`

| Architecture | Manifest SHA256 |
| --- | --- |
| amd64 | `1882f98d012302c85dd6d0913040d2824813f122445ed96f7d5d2338148a7105` |
| arm64 | `a6da23d4c532db883c8b453db94fed414c08a3bb1a4956c935875689b475367e` |

The [GitHub Release](https://github.com/workhold/doca/releases/tag/v0.2.26) and [workflow](https://github.com/workhold/doca/actions/runs/40918312375) succeeded. All three attachments were downloaded and matched their published sizes and SHA256 metadata. The 478 Web assets match the final local build; all ten deployment files match the local bundle, excluding local macOS AppleDouble metadata. The deployment checksum is correct.

| Attachment | Bytes | SHA256 |
| --- | ---: | --- |
| doca-deploy-v0.2.26.tar.gz | 18,567 | `732e4ca92b0728124056daacc08e7f1ef58107cac456fab03cfae0e9e2381743` |
| doca-deploy-v0.2.26.tar.gz.sha256 | 93 | `7c14d9c95fa91c7f82ed516d43eaac334959b4ff6f88ecfaf94bda822fb96c20` |
| doca-web-assets-v0.2.26.tar.gz | 17,189,094 | `dea317e0df9fc1ee4ecf74e36f329cd287f9a8a446bac209c787735237d78ecc` |

Temporary release secrets were deleted and verified absent; their values were never saved. Raw logs, downloads, JSON and screenshots remain in ignored `artifacts/verification/release-0.2.26/`. Browser acceptance is Chromium-scoped, and a cell/filter test does not establish every spreadsheet operation. No user documents or production database were used, and no running Doca site was deployed.
