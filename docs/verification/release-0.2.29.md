# Doca 0.2.29 publication verification

Published on 2026-10-31 (Asia/Shanghai). [PR122](https://github.com/workhold/doca/pull/122) fixes new AI turn history after setup failure, welcome-screen state during active tasks and conversation deletion feedback. The immutable `v0.2.29` tag points to `a3a60eac6a33af8a3a6459e7fbdca8b90f26ceb0`. The merged release tree matches the locally tested candidate; this verification update does not move the tag.

The user explicitly selected fixes for future tasks only. No historical missing message is reconstructed, and no database schema, persisted format or historical reader is changed. Existing message readers, retry defaults and session-file cleanup rules remain unchanged. Deployment retains existing data, volumes and keys and updates server and Web together. See the [feature verification](ai-session-history-2026-10-31.md) and [release notes](../releases/0.2.29.md).

Local acceptance passed 3,505 tests with 11 existing conditional skips across 340 test files (337 passed and three skipped). Typecheck, production build, editor package source verification, deployment packaging, standalone Compose parsing, six documentation tests and 109 bilingual documentation pages passed. Three browser runs against the production Web build passed with no page errors. They covered original questions and attachments after setup failure, selection and refresh, unchanged historical missing records, loading/queued/running welcome-screen suppression, deletion errors and retry, a real 409 race with data preservation, explicit task cancellation followed by separate confirmed deletion, and preservation of unrelated conversations.

[PR database checks](https://github.com/workhold/doca/actions/runs/41203821607) passed 393 tests across 32 files on each PostgreSQL 17/18 runner, with three existing conditional skips each. [Documentation publication](https://github.com/workhold/doca/actions/runs/41204325321) succeeded. This release has no database structure change; it does not add a historical-data recovery or migration path.

The [native image workflow](https://github.com/workhold/doca/actions/runs/41204361975) passed on real Linux amd64 and arm64 runners. Both images passed original-image bytes, login/logout/revocation, Logo behavior, browser-free PDF/Canvas and Office rendering, and runtime/Web file comparison (591 source files and 484 Web files) against their source build. Independent anonymous registry requests verified raw index/manifest/config SHA256 values and both architectures' source/version labels. [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) serves `0.2.29` and, at publication, `latest` at:

`sha256:ced4158fbac1c4f0b19ad92a528cfd940359a6c22919c461b392ce82b9e7430d`

| Architecture | Manifest SHA256 | Compressed layer bytes |
| --- | --- | ---: |
| amd64 | `sha256:3a43778a70ac80b6612b6ea1e232de3a16975a5a88ee7ba5ced00cafd830c615` | 519,896,521 |
| arm64 | `sha256:04838508a2cd460defceff83a1447ba8b91b6789106ea11f7c293e2852b6e014` | 511,797,428 |

The [GitHub Release](https://github.com/workhold/doca/releases/tag/v0.2.29) and [Release workflow](https://github.com/workhold/doca/actions/runs/41205056612) succeeded. The five attachments below were downloaded and matched their byte sizes and published SHA256 metadata; both checksum files verify. The 7 deployment files and 479 Web assets match the local release build, excluding macOS metadata. Standalone YAML matches the packer's output and passes Compose parsing.

| Attachment | Bytes | SHA256 |
| --- | ---: | --- |
| doca-compose-v0.2.29.yaml | 807 | `400aabdfaca82258b7499c3e7002a5ce2f9ab2cb86355b11a8cbe981585b5fea` |
| doca-compose-v0.2.29.yaml.sha256 | 92 | `f77fe6742f7f6b04d18e9fa7403d812a33cf45143217d1c4686c40897d9b4d10` |
| doca-deploy-v0.2.29.tar.gz | 11,140 | `bc07be9f24c93342e11386f27bc14439e030389ad85e0467a7cb3094af694f6d` |
| doca-deploy-v0.2.29.tar.gz.sha256 | 93 | `501469022fd00d867f0687a969adf10d5c43c7dec063e766673404b9873fd169` |
| doca-web-assets-v0.2.29.tar.gz | 19,226,211 | `0816eb75a4696b924600855f690f5146df805487aba3796288b9b8fee82af424` |

Temporary release secrets were deleted and verified absent. Values were not saved in files or logs. Raw acceptance reports, downloads and logs stay under ignored `artifacts/verification/release-0.2.29/`; reviewed feature evidence is in the [AI conversation verification](ai-session-history-2026-10-31.md). Tests use isolated synthetic data. This publishes GitHub/Docker Hub artifacts and does not deploy a running site or user database.
