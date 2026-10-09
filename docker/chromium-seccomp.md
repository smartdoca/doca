# Chromium namespace sandbox policy

`chromium-seccomp.json` is the unmodified policy from the official Playwright **v1.62.1** source:

- Source: https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/seccomp_profile.json
- Raw bytes: https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/utils/docker/seccomp_profile.json
- SHA-256: `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`
- License: Apache-2.0, reproduced in `chromium-seccomp.LICENSE`.

This is the default-policy-based seccomp filter documented by [Playwright](https://playwright.dev/docs/docker), with `clone`, `setns` and `unshare` permitted for user namespaces. Its default action remains `SCMP_ACT_ERRNO`; it is not an unconfined policy. Preserve its exact bytes and provenance together. A browser/Playwright/policy upgrade requires a separately reviewed and tested policy update, not a runtime download or a fallback that disables sandboxing.

The base Compose file explicitly loads this host-side file and supplies dedicated Chromium shared memory. The image runs as `node`, and the application launches Chromium with `chromiumSandbox:true`. The host kernel must permit user namespaces; a restricted host can still reject launch. Do not use privileged mode or disable sandboxing to turn that error into success. A passing application health check does not prove a renderer can launch.

An isolated arm64 Bookworm/Node 22 check with Playwright 1.62.1 and Debian Chromium 154.0.8037.92 successfully produced a PDF at UID 1000 using these exact bytes, with no network, a read-only root and no application data or credentials. The same image failed namespace creation under Docker's default policy. This records that tested environment; final release images and other target hosts/architectures still require their own renderer smoke check. See [Docker document rendering](../docs/docker-rendering.md).
