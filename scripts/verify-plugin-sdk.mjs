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
  const source = `import { pluginDatabaseToken, pluginObjectStorageToken, pluginCredentialToken, type PluginCredentialServiceV1, type PluginDatabaseSchema, type PluginDatabaseServiceV1, type PluginObjectStorageServiceV1 } from '@smartdoca/plugin-sdk/storage';
const schema: PluginDatabaseSchema = { version:1, tables:{ messages:{ columns:{ id:{type:'text',nullable:false},title:{type:'text',nullable:false} }, primaryKey:['id'], unique:[] } } };
const verifyStorageTypes = async (database: PluginDatabaseServiceV1, objects: PluginObjectStorageServiceV1) => { await database.defineSchema(schema); await database.transaction(async tx => { await tx.insert('messages',[{id:'one',title:'Hello'}]); return tx.select('messages',{where:[{column:'id',operator:'=',value:'one'}]}); }); const object = await objects.put({data:new Uint8Array([1]),mime:'application/octet-stream'}); await objects.get(object.id); await objects.remove(object.id); };
const verifyCredentialTypes = async (service: PluginCredentialServiceV1) => { const created = await service.create({value:'server-only-secret'}); await service.inspect(created.id); const read = await service.get(created.id); if (read) { const updated = await service.update({id:read.credential.id,value:'refreshed',expectedRevision:read.credential.revision}); await service.remove({id:updated.id,expectedRevision:updated.revision}); } };
void verifyCredentialTypes;
if(pluginCredentialToken.id !== 'storage.credentials.v1') throw Error('public credential token');
void verifyStorageTypes;
if(pluginDatabaseToken.id !== 'storage.sql.v1' || pluginObjectStorageToken.id !== 'storage.objects.v1') throw Error('public storage tokens');
import { createPluginElementPayload, pluginElementState, type PluginElementContribution } from '@smartdoca/plugin-sdk/editor-elements';
import { templatesServiceToken, materialsServiceToken, type TemplateProvider, type MaterialProvider, type MaterialsServiceV2, type MaterialCollectionResult } from '@smartdoca/plugin-sdk/creation-resources';
import { documentReadServiceToken, librariesServiceToken } from '@smartdoca/plugin-sdk/documents';
import { createPluginPlatformClient, createPluginAssistantClient, validateAssistantOpenInput, type PluginAssistantOpenInput, type PluginAssistantOpenResult, type NavigationSlot, type ExtensionSlot, type WebPluginBundle, type PluginWebHost, type PluginTemplatePickerProps, type PluginMaterialPickerProps } from '@smartdoca/plugin-sdk/web';
import { usersServiceToken, type DirectorySource } from '@smartdoca/plugin-sdk/platform';
import { WebPluginRegistry, navigationSlots, extensionSlots } from '@smartdoca/web-plugin-registry';
const ids = [documentReadServiceToken.id, librariesServiceToken.id, usersServiceToken.id];
if (ids.join(',') !== 'documents.read.v1,libraries.v1,users.v1') throw Error('public tokens');
const bundle: WebPluginBundle = { manifest: {pluginId:'example.consumer',version:'1.0.0',targets:['web']}, commands: [{id:'example.consumer.read',pluginId:'example.consumer',title:{zh:'读取',en:'Read'},supportedContexts:['document'],execute(context){context.signal.throwIfAborted();}}], placements:[{id:'example.consumer.menu',pluginId:'example.consumer',slot:'document.menu',commandId:'example.consumer.read'}] };
const registry = new WebPluginRegistry(); registry.register(bundle)();
const sidebar: NavigationSlot = 'web.leftMore'; const globalSidebar: ExtensionSlot = 'global.leftMore';
if (!navigationSlots.includes(sidebar) || !extensionSlots.includes(globalSidebar)) throw Error('public sidebar More slots');
registry.register({manifest:{pluginId:'example.sidebar',version:'1.0.0',targets:['web']},commands:[{id:'example.sidebar.open',pluginId:'example.sidebar',title:{zh:'打开',en:'Open'},supportedContexts:['global'],execute(){}}],placements:[{id:'example.sidebar.menu',pluginId:'example.sidebar',slot:globalSidebar,commandId:'example.sidebar.open'}]})();
const calls: string[] = [];
const requests: {operation:string;input:unknown}[]=[];
const client = createPluginPlatformClient(async <T,>(operation: string,input:unknown) => {calls.push(operation);requests.push({operation,input});return {} as T});
await client.documents.readSnapshot({documentId:'doc'}); await client.users.me();
if (calls.join(',') !== 'documents.readSnapshot,users.me') throw Error('public transport');
if(templatesServiceToken.id !== 'templates.v1' || materialsServiceToken.id !== 'materials.v2') throw Error('resource tokens');
await client.templates.search({contract:{id:'doca.document.rich_text',version:1},providerIds:['example.templates']}); await client.materials.tags({providerIds:[]});
await client.templates.retrieve({query:'季度经营汇报模板',providerIds:['example.templates'],mode:'auto',topK:8});
await client.materials.retrieve({query:'科技风背景图',providerIds:['example.images'],mode:'keyword',target:'all',topK:8});
const collectionRef = {providerId:'example.images',id:'palette',revision:'1'};
await client.materials.collectionDescribe(collectionRef);
await client.materials.collectionItems({ref:collectionRef,query:'红色',limit:12});
await client.materials.search({target:'collections',collectionTags:['doca.tag.theme'],cursors:{collections:'cursor'},limit:12});
if(!requests.some(request=>request.operation==='materials.collectionItems')) throw Error('material collection transport');
const verifyMaterialTypes = async (service: MaterialsServiceV2, provider: MaterialProvider) => {
  if (provider.version !== 2) throw Error('material protocol');
  const dispose = service.register(provider);
  const result = await client.materials.search({target:'all'});
  const groups: readonly MaterialCollectionResult[] = result.collections.items;
  result.materials.items.forEach(asset => asset.collections.forEach(ref => { void ref.revision; }));
  void groups; void result.collections.nextCursor; dispose();
};
void verifyMaterialTypes;
if(!requests.some(request=>request.operation==='templates.retrieve' && (request.input as {providerIds?:string[]}).providerIds?.[0]==='example.templates')) throw Error('resource source selection');
type Host = PluginWebHost; type Source = DirectorySource; type TemplateSource = TemplateProvider;
const openAssistant = (host: Host, input: PluginAssistantOpenInput): Promise<PluginAssistantOpenResult> => host.ai.open(input);
void openAssistant;
validateAssistantOpenInput({prompt:'Summarize',context:'Plugin context',autoSend:false});
const assistantRequests: string[] = [];
const assistant = createPluginAssistantClient('example.consumer', async <T,>(path: string) => {assistantRequests.push(path);return (path.endsWith('/users.me') ? {id:'user'} : path==='/ai/options' ? {defaultModel:'model',models:[{id:'model'}],webSearchAvailable:false} : {id:'11111111-1111-4111-8111-111111111111'}) as T;}, () => {}, () => '22222222-2222-4222-8222-222222222222');
await assistant.open({prompt:'Summarize'});
if(assistantRequests.some(path=>path.endsWith('/messages')))throw Error('draft launch sent a message');
type TemplateUI = Host['TemplatePicker']; type MaterialUI = Host['MaterialPicker'];
const selectTemplate: PluginTemplatePickerProps['select'] = (selection, resource) => { void selection.ref; void resource.source.title.en; };
const selectMaterial: PluginMaterialPickerProps['select'] = file => { void file.id; void file.source.description; };
void selectTemplate; void selectMaterial;
const element: PluginElementContribution = {id:'example.elements.countdown',pluginId:'example.elements',title:{zh:'倒计时',en:'Countdown'},dataVersion:1,formats:['rich_text','spreadsheet'],validate(data){return typeof data.targetAt==='string';},text(){return 'Countdown';},renderEditor(){return null;},render(){return null;},renderCell(){}};
const disposeElements = registry.register({manifest:{pluginId:'example.elements',version:'1.0.0',targets:['web']},elements:[element]});
const payload = createPluginElementPayload(element,{targetAt:'2026-10-03T00:00:00Z'},'en');
if(pluginElementState(payload,registry.elements.get(element.id),'rich_text')!=='ready')throw Error('element registration');
disposeElements(); if(pluginElementState(payload,registry.elements.get(element.id),'rich_text')!=='unsupported')throw Error('missing element placeholder');
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
