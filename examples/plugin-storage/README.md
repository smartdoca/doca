# Host-managed storage example

Independent server/Web example for SDK source 0.1.7. No host imports, database driver, disk paths or environment readers. It exercises plugin-scoped relational data, private objects, ordinary file/folder creation with idempotency and content-source, template and material registration. The plugin owns its per-user note authorization.

Run `node examples/plugin-storage/build.mjs` from the repository root. It bundles the server and generates the Web version from the package manifest, then verify with `pnpm exec tsc --noEmit -p examples/plugin-storage/tsconfig.json`. Package **only** package.json, manifest.json, server.js and web/; do not include source TypeScript in the installed archive. The checked-in server.js is the compiled complete runtime bundle. Upload a ZIP rooted at package.json, or publish the package through the normal npm files list.

Install on an isolated new-format Doca deployment, restart every instance, then open “Storage SDK acceptance”. Nothing is installed by default. User files remain on uninstall; the host clears private plugin data. This is a development example, not a production business package or a proof of native-device acceptance.
