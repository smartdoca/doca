import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createApp } from "@server/app/create-app.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { pluginServices } from "@core/shared/plugin-services.js";
import { notificationPath } from "@core/modules/interactions/plugin-notifications.js";

it("delivers scoped idempotent notifications, checks current authorization and guards link navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "doca-notification-"));
  const pkg = join(root, "example.notifications");
  const config = { driver: "sqlite" as const, path: join(root, "host.sqlite") };
  let db = await openTestDatabase(config);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await mkdir(pkg, { recursive: true });
    const manifest = { schemaVersion: 1, id: "example.notifications", version: "1.0.0", displayName: "Notifications", sdkRange: "^0.1.7" };
    await writeFile(join(pkg, "package.json"), JSON.stringify({name:"example-notifications",version:"1.0.0",type:"module",doca:{dataVersion:"1",storage:"host",manifest:"./manifest.json",server:"./server.js"}}));
    await writeFile(join(pkg, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(pkg, "server.js"), `export default () => ({manifest:${JSON.stringify(manifest)}, async uninstall() {}, async mount(ctx) {
      ctx.inject({id:'permissions.v1'}).register({pluginId:'example.notifications',resourceType:'mailbox',async authorize(user,id,action){const current=await ctx.inject({id:'users.v1'}).status(user);return current?.status==='active' && user===id && action==='notification.read'}});
      const notifications=ctx.inject({id:'notifications.v1'});
      await ctx.inject({id:'http.v1'}).register('example.notifications', [{method:'POST',path:'/publish',handle(req){return notifications.publish(req.body.pluginId ?? 'example.notifications',{recipientId:req.principal.id,key:req.body.key??'mail:1',title:req.body.title??'New mail',body:'Message received',path:req.body.path??'/mail/inbox?message=1',resource:{type:'mailbox',id:req.principal.id}})}},{method:'POST',path:'/withdraw',async handle(req){await notifications.withdraw('example.notifications',{recipientId:req.principal.id,key:'mail:1'});return {ok:true}}}]);
    }});`);
    const owner = await createUser(db, {login:"notify", displayName:"Notify",password:"test-password-2026"}, {bootstrap:true});
    await createUser(db, {login:"other",displayName:"Other",password:"test-password-2026"}, {actor:{...owner,admin:1}});
    const origin = "http://localhost:39132";
    app = await createApp(db, {origin, pluginDirectory:root});
    const headers = {host:"localhost:39132",origin};
    const login = async (login:string) => {
      const result = await app!.inject({method:"POST",url:"/api/v1/auth/login",headers,payload:{login,password:"test-password-2026"}});
      expect(result.statusCode,result.body).toBe(200);
      return {...headers,cookie:String(result.headers["set-cookie"]).split(";")[0]!};
    };
    const user = await login("notify"), other = await login("other");
    const publish = (payload={}) => app!.inject({method:"POST",url:"/api/v1/plugins/example.notifications/publish",headers:user,payload});
    const results = await Promise.all([publish(),publish(),publish()]);
    for (const r of results) expect(r.statusCode,r.body).toBe(200);
    const id = results[0]!.json().id;
    expect(new Set(results.map(r=>r.json().id)).size).toBe(1);
    expect((await publish({title:"Changed"})).statusCode).toBe(409);
    expect((await publish({pluginId:"another.plugin"})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await publish({key:"unsafe",path:"//evil.test"})).statusCode).toBe(400);
    const list = await app.inject({url:"/api/v1/notifications",headers:user});
    expect(list.statusCode,list.body).toBe(200);
    expect(list.json()).toMatchObject({unread:1,items:[{id,title:"New mail",description:"Message received",href:`/api/v1/notifications/${id}/open`}]});
    const open = await app.inject({url:`/api/v1/notifications/${id}/open`,headers:user});
    expect(open.statusCode).toBe(303);expect(open.headers.location).toBe("/#/mail/inbox?message=1");
    expect((await app.inject({url:`/api/v1/notifications/${id}/open`,headers:other})).statusCode).toBe(404);
    await app.close(); await db.destroy();
    db = await openTestDatabase(config);
    app = await createApp(db, {origin, pluginDirectory:root});
    expect((await publish()).json().id).toBe(id);
    const source = pluginServices(db).permissions.get("example.notifications.mailbox")!;
    pluginServices(db).permissions.delete("example.notifications.mailbox");
    expect((await app.inject({url:"/api/v1/notifications",headers:user})).json()).toMatchObject({items:[],unread:0});
    expect((await app.inject({url:`/api/v1/notifications/${id}/open`,headers:user})).statusCode).toBe(404);
    pluginServices(db).permissions.set("example.notifications.mailbox",source);
    await app.inject({method:"POST",url:"/api/v1/notifications/read",headers:user,payload:{ids:[id]}});
    expect((await app.inject({url:"/api/v1/notifications",headers:user})).json().unread).toBe(0);
    expect((await app.inject({method:"POST",url:"/api/v1/plugins/example.notifications/withdraw",headers:user,payload:{}})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/v1/notifications/${id}/open`,headers:user})).statusCode).toBe(404);
    expect((await publish()).statusCode).toBe(410);
  } finally { await app?.close(); await db.destroy(); await rm(root,{recursive:true,force:true}); }
});
it("rejects external, encoded protocol-relative and control-character routes",()=>{
  for(const path of ["https://evil.test","javascript:alert(1)","//evil.test","/a\\evil","/a%0aevil","/a%5cevil","/%2fevil","/a#redirect"])
    expect(()=>notificationPath(path)).toThrow();
  expect(notificationPath("/mail/1?subject=%E4%BD%A0%E5%A5%BD")).toContain("/mail/1");
});
