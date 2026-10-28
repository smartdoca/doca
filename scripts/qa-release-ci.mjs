// Accept native images before assembling the public multi-platform index.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
assert(/^\d+\.\d+\.\d+$/.test(version));
const revision = process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(revision));
const output = resolve(`artifacts/verification/release-${version}`);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 10_000_000 });
const raw = (image) => JSON.parse(docker("buildx", "imagetools", "inspect", "--raw", image));
const digest = (image) => {
  const value = docker("buildx", "imagetools", "inspect", image).match(/^Digest:\s+(sha256:[a-f0-9]{64})/m)?.[1];
  assert(value, image);
  return value;
};
mkdirSync(output, { recursive: true });

if (process.argv[2] === "native") {
  const arch = process.argv[3];
  assert(["amd64", "arm64"].includes(arch));
  const image = process.env.DOCA_RELEASE_PUBLISHED_NATIVE_IMAGE;
  assert(image?.startsWith(`smartdoca/doca:${version}-build-`));
  const metadata = read("artifacts/verification/release-image/build/image-build-metadata.json");
  const local = JSON.parse(docker("image", "inspect", "--platform", `linux/${arch}`, `smartdoca/doca:${version}-candidate`))[0];
  assert.equal(local.Architecture, arch);
  assert.equal(local.Config.Labels["org.opencontainers.image.revision"], revision);
  assert.equal(local.Config.Labels["org.opencontainers.image.version"], version);
  const imageDigest = digest(image);
  assert.equal(imageDigest, metadata["containerimage.digest"]);
  const manifest = raw(image);
  assert.equal(manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert(Array.isArray(manifest.layers) && manifest.config?.digest);
  assert(manifest.layers.every(layer => Number.isSafeInteger(layer.size) && layer.size >= 0));
  const compressedLayerBytes = manifest.layers.reduce((sum, layer) => sum + layer.size, 0);
  const smoke = read(resolve(output, "docker-smoke.json"));
  assert(smoke.passed && smoke.results.length === 1 && smoke.results[0].passed);
  assert.equal(smoke.results[0].arch, arch === "amd64" ? "x64" : "arm64");
  assert(smoke.results[0].systemLogoConfigured && smoke.results[0].systemLogoPublicPng && smoke.results[0].systemLogoReset && smoke.results[0].systemLogoPermissionAndRevision);
  const runtime = read(resolve(output, `runtime-${arch}.json`));
  assert(runtime.passed && runtime.arch === arch);
  const render = read(resolve(output, `render-${arch}.json`));
  assert(render.passed && render.uid === 1000 && render.providerCalls === 0);
  assert.equal(render.arch, arch === "amd64" ? "x64" : "arm64");
  const evidence = resolve("artifacts/verification/release-image/build/acceptance");
  mkdirSync(evidence, { recursive: true });
  write(resolve(evidence, "native.json"), {
    passed: true, version, arch, sourceRevision: revision, image, imageDigest,
    manifestDigest: imageDigest, configDigest: manifest.config.digest,
    compressedLayerBytes, layerCount: manifest.layers.length,
    localReportedSizeBytes: local.Size,
  });
  copyFileSync(resolve(output, "docker-smoke.json"), resolve(evidence, "docker-smoke.json"));
  copyFileSync(resolve(output, `runtime-${arch}.json`), resolve(evidence, `runtime-${arch}.json`));
  copyFileSync(resolve(output, `render-${arch}.json`), resolve(evidence, `render-${arch}.json`));
  copyFileSync("artifacts/verification/release-image/build/image-build-metadata.json", resolve(evidence, "image-build-metadata.json"));
} else if (process.argv[2] === "publish") {
  const native = {};
  for (const arch of ["amd64", "arm64"]) {
    const record = read(`artifacts/verification/release-image/inputs/release-image-${arch}/native.json`);
    assert(record.passed && record.arch === arch && record.version === version && record.sourceRevision === revision);
    assert.equal(digest(record.image), record.imageDigest);
    native[arch] = record;
  }
  docker("buildx", "imagetools", "create",
    "--tag", `smartdoca/doca:${version}`, "--tag", "smartdoca/doca:latest",
    ...Object.values(native).map((record) => `smartdoca/doca@${record.imageDigest}`));
  const indexDigest = digest(`smartdoca/doca:${version}`);
  const index = raw(`smartdoca/doca:${version}`);
  const images = {};
  const results = [];
  for (const arch of ["amd64", "arm64"]) {
    const record = native[arch];
    const entry = index.manifests.find((item) => item.platform?.os === "linux" && item.platform?.architecture === arch);
    assert.equal(entry?.digest, record.manifestDigest);
    assert.equal(raw(`smartdoca/doca@${entry.digest}`).config.digest, record.configDigest);
    images[arch] = { manifestDigest: record.manifestDigest, configDigest: record.configDigest,
      compressedLayerBytes: record.compressedLayerBytes, layerCount: record.layerCount };
    const input = resolve(`artifacts/verification/release-image/inputs/release-image-${arch}`);
    const smoke = read(resolve(input, "docker-smoke.json"));
    assert(smoke.passed && smoke.results.length === 1);
    results.push(...smoke.results);
    copyFileSync(resolve(input, `runtime-${arch}.json`), resolve(output, `runtime-${arch}.json`));
    copyFileSync(resolve(input, `render-${arch}.json`), resolve(output, `render-${arch}.json`));
    copyFileSync(resolve(input, "native.json"), resolve(output, `native-${arch}.json`));
    copyFileSync(resolve(input, "image-build-metadata.json"), resolve(output, `image-build-${arch}-metadata.json`));
  }
  write(resolve(output, "image-build.json"), { sourceRevision: revision, indexDigest, images });
  write(resolve(output, "docker-smoke.json"), { passed: true, image: `smartdoca/doca:${version}`, results });
  for (const tag of [version, "latest"])
    execFileSync(process.execPath, ["scripts/qa-release-registry.mjs", tag], { stdio: "inherit" });
  write(resolve(output, "ci-publication.json"), {
    passed: true, sourceRevision: revision, indexDigest,
    workflow: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    architectures: ["amd64", "arm64"], nativeRunners: true,
  });
  const evidence = resolve("artifacts/verification/release-image/published");
  mkdirSync(evidence, { recursive: true });
  for (const name of ["image-build.json", "docker-smoke.json", "runtime-amd64.json", "runtime-arm64.json",
    "render-amd64.json", "render-arm64.json",
    "native-amd64.json", "native-arm64.json", "image-build-amd64-metadata.json", "image-build-arm64-metadata.json",
    `registry-${version}.json`, "registry-latest.json", "ci-publication.json"])
    copyFileSync(resolve(output, name), resolve(evidence, name));
} else {
  throw new Error("Usage: qa-release-ci.mjs native amd64|arm64, or publish");
}
