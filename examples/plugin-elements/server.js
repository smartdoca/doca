import manifest from "./manifest.json" with { type: "json" };
// Public plugin lifecycle, no host imports, dependencies or private database.
export default () => ({ manifest, async uninstall() {} });
