import ts from "typescript";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const packages = [
  "plugin-contracts",
  "files-capability",
  "search-host",
  "knowledge-capability",
  "web-plugin-registry",
  "plugin-sdk",
];
const output = await mkdtemp(join(tmpdir(), "doca-sdk-build-"));
try {
  const program = ts.createProgram(
    packages
      .map((name) => resolve(`packages/${name}/src/index.ts`))
      .concat(
        [
          "platform",
          "files",
          "ai",
          "testing",
          "search",
          "knowledge",
          "web",
        ].map((name) => resolve(`packages/plugin-sdk/src/${name}.ts`)),
      ),
    {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      declaration: true,
      rootDir: resolve("packages"),
      outDir: output,
    },
  );
  const result = program.emit();
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...result.diagnostics,
  ];
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
  for (const name of packages) {
    const target = resolve(`packages/${name}/dist`);
    await mkdir(target, { recursive: true });
    await cp(join(output, name, "src"), target, { recursive: true });
    await cp(resolve("LICENSE"), join(target, "LICENSE"));
    await cp(resolve("LICENSING.md"), join(target, "LICENSING.md"));
    await cp(resolve("LICENSING.zh-CN.md"), join(target, "LICENSING.zh-CN.md"));
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
