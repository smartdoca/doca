// Read-only, isolated visual fixture server; never connects to a Doca database.
import { createServer, loadConfigFromFile } from "vite";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const project = resolve(directory,"../../..");
const stamp = new Date();
const formats = ["rich_text","spreadsheet","markdown","presentation","canvas"];
const titles = ["调研","产品计划表","接口说明","项目介绍","工作流程"];
const resources = formats.map((format,index)=>({
  id:`qa-${format}`,kind:"document",format,title:titles[index],owner_id:"qa-user",ownerName:"管理员",
  library_id:"qa-library",libraryName:"我的",parent_id:"qa-library",tree_order:index,version:1,role:"reader",
  access_mode:"inherit",visibility:"invited",requests_enabled:0,history_readers:0,discoverable:0,
  updated_at:new Date(stamp-index*3600000).toISOString(),created_at:new Date(stamp-86400000*(index+1)).toISOString(),
  visited_at:new Date(stamp-index*3600000).toISOString(),favorite:false,pinned:index===0,collected:false,is_public:false,
  deleted_at:null,cover_asset_id:null,page_width:null,inLibrary:true,
}));
resources.push({...resources[0],id:"qa-library",kind:"library",title:"我的",library_id:null,parent_id:null,pinned:false,inLibrary:false});
const entries = [
  ["home","Home","首页","home"], ["ai","AI assistant","AI 助手","ai"],
  ["documents","Documents","文档","documents"], ["libraries","Libraries","知识库","libraries"],
  ["knowledge-books","Knowledge books","知识册","knowledge-books"], ["files","Folders","文件夹","files"],
  ["shared-files","Shared folders","共享文件夹","shared-files"], ["discover","Public resources","公共资源","discover"],
  ["trash","Trash","回收站","trash"],
].map(([id,en,zh,icon],index)=>({id:`doca.${id}`,title:{en,zh},icon,webPath:`/${id}`,allowedSlots:["web.left"],defaults:["web.left"],order:index}));
const navigation = {revision:1,entries,layout:{placements:entries.map(entry=>({entryId:entry.id,slot:"web.left",order:entry.order})),home:{web:"doca.home"}}};
const activity = resources.map(r=>({id:r.id,kind:r.kind,title:r.title,format:r.format,visited_at:r.visited_at,updated_at:r.updated_at,collected:false,public:false,href:`#/r/${r.id}`,inLibrary:r.inLibrary,libraryName:r.libraryName}));
activity.push({id:"qa-file",kind:"file",title:"image.png",format:null,visited_at:new Date(stamp-30000000).toISOString(),updated_at:stamp.toISOString(),collected:false,public:false,href:"#/files",inLibrary:false,libraryName:null});

const configured = await loadConfigFromFile({command:"serve",mode:"development"},resolve(project,"apps/web/vite.config.ts"));
if (!configured) throw new Error("Could not load the workspace Vite config");
const server = await createServer({
  ...configured.config,
  configFile:false,
  root:directory,
  cacheDir:resolve(directory,".vite"),
  plugins:[...(configured.config.plugins??[]),{
    name:"doca-isolated-visual-fixture",
    configureServer(server) {
      server.middlewares.use(async(req,res,next)=>{
        const url = new URL(req.url??"/","http://127.0.0.1");
        if (url.pathname==="/__baseline-css") {
          const relative=url.searchParams.get("path");
          const allowed = new Set([
            "apps/web/src/styles/globals.css","apps/web/src/styles/theme.css","apps/web/src/styles/platform-polish.css",
            "apps/web/src/features/workspace/workspace.css","apps/web/src/features/workspace/workspace-density.css",
            "apps/web/src/features/workspace/home.css","apps/web/src/features/workspace/navigation-collapse.css",
            "apps/web/src/features/documents/document-icons.css","apps/web/src/features/documents/document-tree.css",
            "apps/web/src/plugins/navigation.css",
          ]);
          if(!allowed.has(relative)){res.statusCode=404;res.end();return;}
          res.setHeader("Content-Type","text/css");
          res.end(await readFile(resolve(directory,"baseline-css",relative),"utf8"));return;
        }
        if (!url.pathname.startsWith("/api/v1/")) return next();
        res.setHeader("Content-Type","application/json");
        if(req.method!=="GET"){res.statusCode=405;res.end(JSON.stringify({message:"Visual fixture is read-only"}));return;}
        let result;
        if(url.pathname==="/api/v1/navigation") result=navigation;
        else if(url.pathname==="/api/v1/workspace/overview") result={ownedDocuments:5,libraries:1,todos:[{kind:"tickets",status:"ready",more:false,items:[]},{kind:"books",status:"ready",more:false,items:[{id:"qa-task",title:"核对资料",updatedAt:stamp.toISOString(),href:"#/knowledge-books"}]}]};
        else if(url.pathname==="/api/v1/workspace/activity") {
          const kind=url.searchParams.get("kind");
          result={items:kind?activity.filter(item=>item.kind===kind):activity,nextCursor:null,sources:[],unavailableSources:[]};
        } else if(url.pathname==="/api/v1/resources") {
          let items=resources;
          if(url.searchParams.get("scope")==="pins") items=items.filter(r=>r.pinned);
          if(url.searchParams.has("kind"))items=items.filter(r=>r.kind===url.searchParams.get("kind"));
          if(url.searchParams.has("format"))items=items.filter(r=>r.format===url.searchParams.get("format"));
          if(url.searchParams.has("libraryId"))items=items.filter(r=>r.library_id===url.searchParams.get("libraryId"));
          result={items,total:items.length,nextCursor:null,truncated:false};
        } else {res.statusCode=404;res.end(JSON.stringify({message:"No visual fixture for this read"}));return;}
        res.end(JSON.stringify(result));
      });
    }
  }],
  server:{host:"127.0.0.1",port:39421,strictPort:true,fs:{allow:[project]}},
});
await server.listen();
server.printUrls();
