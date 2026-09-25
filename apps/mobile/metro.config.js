const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

// pnpm keeps real packages in the workspace store, outside this app folder.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

const mobileModules = path.resolve(projectRoot, "node_modules");
const singletonReact = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@doca/mobile/")) {
    const name = moduleName.slice("@doca/mobile/".length);
    const base = path.resolve(projectRoot, "src", name);
    const filePath = [`${base}.ts`, `${base}.tsx`].find((candidate) =>
      require("fs").existsSync(candidate),
    );
    if (!filePath) {
      throw new Error(`Cannot resolve ${moduleName}`);
    }
    return { type: "sourceFile", filePath };
  }
  if (moduleName === "@doca/i18n") {
    return {
      type: "sourceFile",
      filePath: path.resolve(workspaceRoot, "packages/i18n/src/index.ts"),
    };
  }
  if (singletonReact.has(moduleName)) {
    return {
      type: "sourceFile",
      filePath: require.resolve(moduleName, { paths: [mobileModules] }),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
