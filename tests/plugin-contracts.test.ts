import { describe, expect, it } from "vitest";
import {
  PluginContractError,
  satisfiesPluginVersion,
  validatePluginConfig,
  validatePluginManifest,
  type JsonObject,
} from "../packages/plugin-contracts/src/index.js";

const manifestInput = {
  schemaVersion: 1,
  id: "doca.example",
  version: "1.2.3",
  sdkRange: "^0.1.0",
  displayName: "Example",
  contributions: [
    { id: "doca.example.tool.lookup", kind: "ai-tool", target: "server" },
  ],
  dependencies: [
    { id: "doca.foundation", range: "^2.0.0" },
    { id: "doca.optional", range: "~1.4.0", optional: true },
  ],
  config: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        pattern: "^https://",
        minLength: 10,
      },
      retries: {
        type: "integer",
        minimum: 0,
        maximum: 5,
        default: 2,
      },
      options: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
        },
        additionalProperties: false,
      },
    },
    required: ["endpoint"],
    additionalProperties: false,
  },
} as const;

describe("plugin contracts", () => {
  it("normalizes a valid manifest and validates config with defaults", () => {
    const manifest = validatePluginManifest(manifestInput);
    const config = validatePluginConfig<
      JsonObject & {
        endpoint: string;
        retries: number;
        options: { enabled: boolean };
      }
    >(manifest, {
      endpoint: "https://plugins.test",
      options: {},
    });

    expect(manifest.dependencies).toEqual(manifestInput.dependencies);
    expect(manifest.sdkRange).toBe("^0.1.0");
    expect(manifest.contributions).toEqual(manifestInput.contributions);
    expect(config).toEqual({
      endpoint: "https://plugins.test",
      retries: 2,
      options: { enabled: true },
    });
  });

  it("rejects unknown fields, malformed manifests and invalid config values", () => {
    expect(() =>
      validatePluginManifest({ ...manifestInput, entrypoint: "./unsafe.js" }),
    ).toThrowError(
      expect.objectContaining<Partial<PluginContractError>>({
        code: "INVALID_MANIFEST",
        path: "$.entrypoint",
      }),
    );
    expect(() =>
      validatePluginManifest({
        ...manifestInput,
        version: "latest",
      }),
    ).toThrow(/semantic version/);
    expect(() =>
      validatePluginManifest({
        ...manifestInput,
        dependencies: [{ id: "doca.foundation", range: ">=2" }],
      }),
    ).toThrow(/unsupported semantic version range/);
    expect(() =>
      validatePluginManifest({
        ...manifestInput,
        contributions: [
          { id: "another.plugin.tool", kind: "ai-tool", target: "server" },
        ],
      }),
    ).toThrow(/must use the .*doca\.example\..* namespace/);

    const manifest = validatePluginManifest(manifestInput);
    expect(() =>
      validatePluginConfig(manifest, {
        endpoint: "http://insecure.test",
        extra: true,
      }),
    ).toThrow(/required pattern/);
    expect(() =>
      validatePluginConfig(manifest, {
        endpoint: "https://plugins.test",
        retries: 1.5,
      }),
    ).toThrow(/expected integer/);
    expect(() =>
      validatePluginConfig(manifest, {
        endpoint: "https://plugins.test",
        extra: true,
      }),
    ).toThrow(/unknown configuration field/);
  });

  it("implements the documented exact, caret and tilde version ranges", () => {
    expect(satisfiesPluginVersion("1.2.3+build.7", "1.2.3")).toBe(true);
    expect(satisfiesPluginVersion("1.9.0", "^1.2.3")).toBe(true);
    expect(satisfiesPluginVersion("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesPluginVersion("0.2.8", "^0.2.3")).toBe(true);
    expect(satisfiesPluginVersion("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesPluginVersion("3.4.9", "~3.4.1")).toBe(true);
    expect(satisfiesPluginVersion("3.5.0", "~3.4.1")).toBe(false);
  });
});
