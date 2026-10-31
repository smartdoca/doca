# Doca 0.2.28 publication verification

Published on 2026-10-31 (Asia/Shanghai). [PR120](https://github.com/workhold/doca/pull/120) adds user groups, unified permission management and document-tree loading status. The immutable `v0.2.28` tag points to `59a659265bcee3d6fb8f5d551abae2a7ae3e5591`. The merged release tree matches the locally tested candidate; this verification update does not move the tag.

The explicitly approved upgrade adds eight tables within the existing compatibility generation. Historical content, permissions, invitations and configuration are preserved; seven group/ACL tables start empty, and the independent group directory policy initializes to joined groups only. No historical grants are converted or copied to individual members. Update every server and Web together; downgrade requires separate data preservation and recovery review. See [group behavior](../user-groups.md) and the [schema upgrade contract](../database-schema-evolution.md).

Local acceptance passed 3,504 tests with 11 existing conditional skips. Typecheck, production build, deployment packaging, standalone Compose parsing, six documentation tests and 108 bilingual documentation pages passed. Three browser runs against the built Web each passed 18 interaction checks, including source edits, independent group access, confirmation/cancel/failure paths, member avatars, directory scope and websocket revocation. Built-Web document-tree checks covered loading through saving and refresh, blocked dragging and success/failure recovery.

Released `v0.2.27` source created isolated SQLite/PostgreSQL 17/18 databases. The candidate preserved all 131 original table-row hashes apart from the expected schema footprint metadata; new tables/default policy, repeated startup and two-process concurrent startup passed on all three engines. Four related test files passed 52 tests on each PostgreSQL version. [PR database checks](https://github.com/workhold/doca/actions/runs/41198453222) passed 393 tests across 32 files on each PostgreSQL 17/18 runner, with three existing conditional skips each. [Documentation publication](https://github.com/workhold/doca/actions/runs/41198844730) succeeded.

The [native image workflow](https://github.com/workhold/doca/actions/runs/41198857568) passed on real Linux amd64 and arm64 runners. Both images passed original-image bytes, login/logout/revocation, Logo behavior, browser-free PDF/Canvas and Office rendering, and runtime/Web file comparison against their source build. Independent anonymous registry requests verified raw index/manifest/config SHA256 values and both architectures' source/version labels. [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) serves `0.2.28` and, at publication, `latest` at:

`sha256:a0541b55434944c022d1d3ba750fe24cfb1fdeac29141360cd1b47f7433fbe43`

| Architecture | Manifest SHA256 | Compressed layer bytes |
| --- | --- | ---: |
| amd64 | `sha256:1adb9070b80bf5fff66724a1105dd691626d49e7df56565b67fb6e93fcfe5e08` | 519,894,410 |
| arm64 | `sha256:dbb1eac9fe7d03e1ac6a0a1ca4f93e492288c146ebdf443fcea69f7d74dc208c` | 511,795,275 |

The [GitHub Release](https://github.com/workhold/doca/releases/tag/v0.2.28) and [Release workflow](https://github.com/workhold/doca/actions/runs/41199566271) succeeded. The five attachments below were downloaded and matched their byte sizes and published SHA256 metadata; both checksum files verify. The 7 deployment files and 479 Web assets match the local release build, excluding macOS metadata. Standalone YAML matches the packer's output and passes Compose parsing.

| Attachment | Bytes | SHA256 |
| --- | ---: | --- |
| doca-compose-v0.2.28.yaml | 807 | `f4f3151f58cd096bc0b35c3c3bba4a705aba7b6d0cc626e7339d1fe05d64a983` |
| doca-compose-v0.2.28.yaml.sha256 | 92 | `fdfb18d18509a0a5617ad7b73d35f3ec7f655781f09187458a431853b2771829` |
| doca-deploy-v0.2.28.tar.gz | 11,146 | `34ba1a848daab8ea184832e3cbf09415dc838f6d642e420d36b49cbccfa4a7a8` |
| doca-deploy-v0.2.28.tar.gz.sha256 | 93 | `bb0a5a6802370e4aa12c980c6b09637a1976bcb7fcbb760ef91334823ff21c49` |
| doca-web-assets-v0.2.28.tar.gz | 19,229,265 | `34d6752a332e4141db2c6f7a57cabab852a030afd2861df1bdd6605a0f1b9142` |

Temporary release secrets were deleted and verified absent. Values were not saved in files or logs. Raw acceptance reports, downloads and logs stay under ignored `artifacts/verification/release-0.2.28/`; reviewed feature evidence is in the [user-group verification](user-groups-2026-10-30.md). Tests use isolated synthetic data. This publishes GitHub/Docker Hub artifacts and does not deploy a running site or user database.
