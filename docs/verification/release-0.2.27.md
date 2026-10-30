# Doca 0.2.27 publication verification

Published on 2026-10-30 (Asia/Shanghai). [PR118](https://github.com/workhold/doca/pull/118) replaces Chromium rendering and adds single-YAML installation. The immutable `v0.2.27` tag points to `6d00b1e830fb8d7f33c5097047d40cc10ff785d8`; this verification update does not move it.

The agreed upgrade rule explicitly rejects `DOCA_PDF_CHROMIUM`, including empty values, and removes the runtime Chromium/seccomp dependency without fallback. Existing PDF endpoints, public editor APIs, document formats and historical SDK readers retain their established paths. Databases, attachments, permissions, master keys and persistent volumes are preserved. There is no database structure or persisted-data conversion. Restore the previous code, lockfile, image and matching deployment configuration for rollback while retaining subsequent data.

The [renderer acceptance](browser-free-renderers-2026-10-30.md) records 3,477 passing local tests, 11 environment-dependent skips, focused resource/process/config checks, real browser PDF export/reimport, 17 Canvas fixtures and isolated single-YAML installation. Typecheck, production build, six documentation tests, 106 bilingual documentation pages and deployment packaging passed after the version bump. [PR checks](https://github.com/workhold/doca/actions/runs/41053073510) passed 341 tests across 28 files on each PostgreSQL 17/18 runner, with three existing conditional skips per runner. [Main database checks](https://github.com/workhold/doca/actions/runs/41053710976) and [documentation publication](https://github.com/workhold/doca/actions/runs/41053710974) also succeeded.

The [native image workflow](https://github.com/workhold/doca/actions/runs/41053768568) succeeded on real Linux amd64 and arm64 runners. Both images run as UID 1000 without Chromium/Playwright, under default Docker security with no network and a read-only root filesystem for rendering. Tests cover selectable Chinese PDF export with an embedded image, text/scanned/JBIG2 PDF page reading, Canvas red/blue pixels with unchanged source, and DOCX/XLSX/PPTX conversion followed by PDF readback. Original-image bytes, sign-in/logout/revocation and Logo behavior passed. Each architecture's 583 runtime files, 483 Web files and editor package files match its comparison build.

Independent anonymous Docker Registry requests verified raw index, manifest and config SHA256 bytes, both architectures and source/version labels. [Docker Hub](https://hub.docker.com/r/smartdoca/doca/tags) serves `0.2.27` and, at publication, `latest` at:

`sha256:44af6af3f36e12ed42714096fc8ef50b246b7a7899a59c2a1213154bcbd8c8c8`

| Architecture | Manifest SHA256 | Compressed layer bytes |
| --- | --- | ---: |
| amd64 | `11089fa1f7fc9e2a15d19777d70df0faa0dc7784feab0159bea41948f4cc2f13` | 519,855,908 |
| arm64 | `36df7d8f48074acd099389f25f98f963ae53c275a33d8d8875dc1c16970b2a32` | 511,756,829 |

Compared with published 0.2.26, compressed layer totals decrease by 189,042,928 bytes (26.67%) on amd64 and 193,949,814 bytes (27.48%) on arm64. These are complete-image totals, not an attribution to one binary or an unpacked disk-size measurement.

The [GitHub Release](https://github.com/workhold/doca/releases/tag/v0.2.27) and [Release workflow](https://github.com/workhold/doca/actions/runs/41054927500) succeeded. Published attachment metadata is:

| Attachment | Bytes | SHA256 |
| --- | ---: | --- |
| doca-compose-v0.2.27.yaml | 807 | `c4a97c82321fa06e2c2c4f5a7f1c199c6a3e304127eb562c86748c7a0ea97571` |
| doca-compose-v0.2.27.yaml.sha256 | 92 | `9663b72f46304260efae9d4a48779b9f17b96c5a45e94ad3589c4808cdc71a06` |
| doca-deploy-v0.2.27.tar.gz | 11,149 | `bc167a0ea972779fd9603c2ae43ae43fb67b12a1ed0da2e678ec7144a5850cda` |
| doca-deploy-v0.2.27.tar.gz.sha256 | 93 | `bfb1e76b3c84bfdf52e69af2b4aadca858165a6c01c20d01589a49916c267ab2` |
| doca-web-assets-v0.2.27.tar.gz | 19,217,171 | `e54c36955c94f3b700f172b712881753f14fb0bdc8b8e298a61fc93111bd0cdc` |

All five attachments were downloaded and matched their published byte sizes and SHA256 metadata; both attached checksum files also verify. The seven deployment files and 478 Web assets match the local build, excluding local macOS AppleDouble metadata. The standalone YAML matches the local packer's output and passes Compose parsing without a source checkout or host seccomp file. Slow direct CDN downloads were completed using parallel HTTP range requests with the full archive SHA256 checked before extraction. The fresh-install configuration requires a site origin and a newly generated master key; existing installations must retain their project, volumes and key.

Temporary release secrets were deleted and verified absent; their values were never saved in files or logs. Raw logs, downloads and JSON remain under ignored `artifacts/verification/release-0.2.27/`. Tests used isolated synthetic data and no paid model calls. No running Doca site or user database was deployed. The renderer acceptance record describes the visual scope and remaining complex-layout limits.
