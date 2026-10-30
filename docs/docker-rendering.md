# Docker document renderers

[简体中文](docker-rendering.zh-CN.md)

The rebuilt image exports rich-text/Markdown PDFs with WeasyPrint 70.0 and creates AI canvas PNGs with Node, native Canvas and resvg. It ships no Chromium or Playwright runtime and needs no host seccomp JSON, extra browser shared memory, or browser user-namespace configuration. Build the new image before using the changed Compose file; previously published images do not gain this renderer automatically.

PDF reading, per-page text/images and editable import still use PDF.js. LibreOffice Writer, Calc, Impress and Math retain visual conversion of `.docx`, `.xlsx` and `.pptx`; CJK and Liberation fonts remain. Verify formulas, diagrams, embedded images, long tables and CJK pagination through real exports; a health check cannot establish visual fidelity.

PDF jobs use the pinned Python environment at `DOCA_PDF_PYTHON=/opt/doca-pdf/bin/python`. Only embedded data resources are allowed; network and host-file reads are refused. Unreadable/corrupt images or fonts fail instead of returning an incomplete PDF. The 32 MiB input limit, two-job concurrency, 60-second deadline and post-render permission recheck remain. Canvas jobs retain the SDK exporter, authorized assets, selection/crop, warnings, queue and cancellation. Both renderers run in disposable processes killed on cancellation/deadline.

`DOCA_PDF_CHROMIUM` is explicitly rejected, with no browser fallback. Existing documents, databases, attachments, keys and volumes remain intact. SDK historical readers keep their existing paths with no stored-data conversion. Rollback restores the previous code, dependency locks, image and deployment configuration while preserving subsequent writes. The old `docker/chromium-seccomp.*` files remain for provenance and old-renderer comparison only; new deployment bundles omit them.

## Image size and update downloads

Removing the browser saves space, while Python/Pango/resvg add dependencies. LibreOffice, fonts, application dependencies and Web assets remain. Compare compressed layers from equivalent versions/architectures; Docker Desktop's multi-architecture local usage is not a download estimate.

Web assets, common dependencies and editors retain separate layers, paths and permissions. See [layer verification](verification/image-web-layers-2026-10-23.md).

## Container verification

```sh
DOCA_RELEASE_QA_IMAGE=your-rebuilt-image node scripts/qa-release-render-image.mjs arm64
```

Use `amd64` for x86-64. This exercises real PDF output, canvas pixels and Office conversion in a non-root disposable container with no network and a read-only root, without user documents. Docker's default security policy is sufficient. Verify the actual production host separately; one architecture does not establish another's result.

## Optional SAM runtime

Default Doca images do not include a usable SAM2/PyTorch runtime, the segmentation worker, or model weights. Core PDF/Office reading does not require SAM. Enabling segmentation is a separate administrator-controlled installation, not a download performed by an AI task.

Use a trusted custom image based on the exact approved Doca release to add the interpreter/system libraries needed by your prebuilt runtime. For a Bookworm Python 3.11 CPU runtime, the deployment-owned Dockerfile can contain:

```dockerfile
ARG DOCA_IMAGE
FROM ${DOCA_IMAGE}
USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-venv libgomp1 \
    && rm -rf /var/lib/apt/lists/*
USER node
```

Build with an approved image digest, for example `docker build --build-arg DOCA_IMAGE=docker.io/smartdoca/doca@sha256:YOUR_APPROVED_DIGEST -t doca-sam-runtime:local .`. The digest is an administrator-selected release fact; the example does not supply one. Prepare the Python environment **inside this Linux image and for its architecture**, at the same `/opt/doca-segment` path used at runtime. Never copy a macOS virtual environment into it. On Linux/amd64, the [official CPU wheel instructions](https://pytorch.org/get-started/previous-versions/#v251) provide PyTorch 2.5.1 and torchvision 0.20.1; other architectures need separately verified available wheels and matching profile facts.

The trusted bundle must contain the exact release worker, installed pinned dependencies, a symlink-free runtime copy of the pinned official SAM2 package, a pre-provisioned checkpoint, and a strict profile with **actual Linux paths, versions and byte/tree hashes**. See the [Linux profile preparation recipe](ai-image-segmentation.md#linux-docker-profile) and the existing strict installation/worker contract. Keep the bundle administrator-owned and readable by container UID 1000; files/directories must not be writable by group or others. Model inputs cannot choose or change those paths.

Create `compose.segmentation.yaml` with Docker Compose 2.24.4 or newer. `!reset` prevents the base file's application build from overwriting your separately built trusted runtime image:

```yaml
services:
  doca:
    build: !reset null
    image: doca-sam-runtime:local
    pull_policy: never
    environment:
      DOCA_AI_IMAGE_SEGMENT_PROFILE: /opt/doca-segment/profile.json
    volumes:
      - type: bind
        source: /srv/doca-segment-linux
        target: /opt/doca-segment
        read_only: true
        bind:
          create_host_path: false
```

This mount is independent of `/data`, uploaded documents and credentials. Do not put model keys, QA authentication state or family photographs in the runtime bundle. Setting the variable in `.env` alone neither forwards it through the base Compose file nor supplies this mount. Validate the installed profile in a one-off container with no application database before enabling it; malformed configuration fails startup, and unavailable/mismatched runtime files leave the tool unavailable. Use all intended overrides when recreating the application:

```sh
docker compose -f compose.yaml -f compose.segmentation.yaml config --quiet
docker compose -f compose.yaml -f compose.segmentation.yaml up -d
```

A runtime/hash check proves installation identity, not mask or final-image quality. Each actual candidate, mask and delivery still requires the current visual checks and permission/source bindings. Weight upgrades require a new verified runtime/profile and coordinated restart; no old profile or persisted mask is converted automatically.

## Build privacy

`.dockerignore` excludes `.cache`, `.local`, databases, environment files, tests and scripts from the application build context. Keep deployment runtime bundles, checkpoints, private acceptance artifacts and credentials outside that context. Exclusion does not delete local files. A SAM custom-image build should use a separate minimal context containing only its approved deployment files.


The Web output also has independent CAD, font and entry layers, plus eight large-file groups (at least 512 KiB) and 16 smaller-code groups assigned from stable file names. A chunk's Vite content-hash rename stays in its existing group; all deployed paths, bytes and permissions remain unchanged. An actual compiled-Web OCI experiment reuses 25 of 27 layers after one entry-chunk update/rename, adding 334,554 compressed bytes. A real Vite CSS rebuild reuses 13 of 27 layers and adds 4,489,097 compressed bytes (about 77.2% less than the preceding whole-Web layer). These are measured cases, not a fixed size for every update; the full Web layers have a small additional header cost. See the [reviewed layer evidence](verification/image-web-layers-2026-10-23.md).
