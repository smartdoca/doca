# Docker document renderers

[中文](docker-rendering.zh-CN.md)

This checkout's Dockerfile installs Debian Bookworm Chromium, its sandbox package, CJK/Liberation fonts, and the LibreOffice Writer, Calc, Impress and Math components. These changes become available in a published image only after that image is rebuilt and released; they are not a claim about the existing `0.1.11` image.

The image sets `DOCA_PDF_CHROMIUM=/usr/bin/chromium` and `DOCA_OFFICE_RENDERER=/usr/bin/soffice`, and runs as the nonroot `node` user. Writer, Calc and Impress cover the supported `.docx`, `.xlsx` and `.pptx` visual conversion paths; Math supplies embedded equation rendering. Installing the components with `--no-install-recommends` avoids the full LibreOffice metapackage and unrelated recommended applications; necessary transitive components such as Draw still install. Chromium, fonts and Office increase image size and renderer memory use. Fonts absent from the image may change line breaks and formulas. A successful process/health check does not prove visual fidelity; verify representative documents on the deployed image.

Office conversion starts a separate headless process with a private `/tmp/doca-office-render-*` directory and a fresh LibreOffice user profile per conversion. The `node` user must be able to write `/tmp`; conversion is limited to 120 seconds and the temporary directory is removed after success or failure. Do not mount a desktop LibreOffice profile or run the application as root to make conversion work. Older binary Office formats, active content and unsupported external resources remain rejected; a conversion failure does not become a text-only success. See [AI attachments](ai-attachments.md).

## Chromium sandbox on Linux

The application explicitly enables the Chromium sandbox. Docker's runtime security policy and the host must permit user namespaces. Installing `chromium-sandbox` and using a nonroot UID does not by itself supply that permission. Playwright's [official Docker instructions](https://playwright.dev/docs/docker) use the default seccomp policy with the additional `clone`, `setns` and `unshare` allowances needed for user namespaces.

The base Compose file already loads the pinned, unmodified official Playwright v1.62.1 policy at `docker/chromium-seccomp.json`, SHA-256 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`, and allocates dedicated shared memory. Keep the host-side policy file from the same approved checkout/release as Compose. It is not downloaded or changed when the application starts. [Policy source and license](../docker/chromium-seccomp.md) are retained with it. Custom deployment files must preserve these settings:

```yaml
services:
  doca:
    security_opt:
      - seccomp=./docker/chromium-seccomp.json
    shm_size: "1gb"
```

Validate and apply the base deployment:

```sh
docker compose config --quiet
docker compose up -d
```

The base Compose file already enables `init: true`. A dedicated shared-memory allocation avoids sharing the host IPC namespace. Neither `--privileged`, `seccomp=unconfined`, nor `--no-sandbox` is required by this configuration. Hosts that forbid user namespaces still need an administrator-approved host policy or a supported execution host; the application does not disable the sandbox when launch fails. Verify an actual PDF export, not only `chromium --version`. Playwright [does not guarantee arbitrary external Chromium versions](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path), so repeat this smoke test when the browser or Playwright changes.

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
