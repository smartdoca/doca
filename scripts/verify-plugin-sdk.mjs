// Verify an independent consumer against built public artifacts, without host aliases.
import ts from "typescript";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const packages = [
  "plugin-contracts",
  "files-capability",
  "search-host",
  "knowledge-capability",
  "web-plugin-registry",
  "plugin-sdk",
];
const fixture = await mkdtemp(join(tmpdir(), "doca-sdk-consumer-"));
try {
  await mkdir(join(fixture, "node_modules/@smartdoca"), { recursive: true });
  for (const name of packages) {
    const source = resolve(`packages/${name}`),
      target = join(fixture, "node_modules/@smartdoca", name);
    const info = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    await mkdir(target);
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({ ...info, ...info.publishConfig }),
    );
  }
  await mkdir(join(fixture, "node_modules/@deepseek-ai"));
  const cordis = await realpath(
    resolve("packages/plugin-sdk/node_modules/@deepseek-ai/cordis"),
  );
  await symlink(cordis, join(fixture, "node_modules/@deepseek-ai/cordis"));
  const source = `import { templatesServiceToken, materialsServiceToken, type TemplateProvider } from '@smartdoca/plugin-sdk/creation-resources';
import { documentReadServiceToken, librariesServiceToken } from '@smartdoca/plugin-sdk/documents';
import { createPluginPlatformClient, type WebPluginBundle, type PluginWebHost } from '@smartdoca/plugin-sdk/web';
import { usersServiceToken, type DirectorySource } from '@smartdoca/plugin-sdk/platform';
import { WebPluginRegistry } from '@smartdoca/web-plugin-registry';
const ids = [documentReadServiceToken.id, librariesServiceToken.id, usersServiceToken.id];
if (ids.join(',') !== 'documents.read.v1,libraries.v1,users.v1') throw Error('public tokens');
const bundle: WebPluginBundle = { manifest: {pluginId:'example.consumer',version:'1.0.0',targets:['web']}, commands: [{id:'example.consumer.read',pluginId:'example.consumer',title:{zh:'读取',en:'Read'},supportedContexts:['document'],execute(context){context.signal.throwIfAborted();}}], placements:[{id:'example.consumer.menu',pluginId:'example.consumer',slot:'document.menu',commandId:'example.consumer.read'}] };
const registry = new WebPluginRegistry(); registry.register(bundle)();
const calls: string[] = [];
const client = createPluginPlatformClient(async <T,>(operation: string) => {calls.push(operation);return {} as T});
await client.documents.readSnapshot({documentId:'doc'}); await client.users.me();
if (calls.join(',') !== 'documents.readSnapshot,users.me') throw Error('public transport');
if(templatesServiceToken.id !== 'templates.v1' || materialsServiceToken.id !== 'materials.v1') throw Error('resource tokens');
await client.templates.search({contract:{id:'doca.document.rich_text',version:1}}); await client.materials.tags({});
type Host = PluginWebHost; type Source = DirectorySource; type TemplateSource = TemplateProvider;
type TemplateUI = Host['TemplatePicker']; type MaterialUI = Host['MaterialPicker'];
console.log('Independent SDK JavaScript and declarations passed');`;
  const file = join(fixture, "consumer.mts");
  await writeFile(file, source);
  const output = join(fixture, "output");
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: false,
    outDir: output,
    types: [],
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  });
  const emitted = program.emit();
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...emitted.diagnostics,
  ];
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => fixture,
        getNewLine: () => "\n",
      }),
    );
  execFileSync(process.execPath, [join(output, "consumer.mjs")], {
    stdio: "inherit",
  });
} finally {
  await rm(fixture, { recursive: true, force: true });
}
