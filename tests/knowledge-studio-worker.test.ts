import {it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {openTestDatabase} from './database.js';
import {createContent} from '@core/workflows/resources.js';
import {createKnowledgeConversation,sendKnowledgeMessage} from '@core/modules/knowledge/conversations.js';
import {registerKnowledgeStudio} from '../apps/server/src/routes/knowledge-studio.js';
const processing=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('../apps/server/src/services/ai/knowledge-studio.js',async original=>({...await original<typeof import('../apps/server/src/services/ai/knowledge-studio.js')>(),createKnowledgeStudio:()=>({process:processing})}));
it('continues dispatching conversations while answer index publication is pending',async()=>{
 const db=await openTestDatabase({driver:'sqlite',path:':memory:'});const api=Fastify();
 const actor={id:randomUUID(),display_name:'QA',admin:0};
 await db.insertInto('users').values({...actor,login:'qa',status:'active',password_hash:'unused',created_at:new Date().toISOString()}).execute();
 const library=await createContent(db).create(actor,{kind:'library',format:'markdown',title:'QA'});
 await db.updateTable('resources').set({ai_curated:1}).where('id','=',library.id).execute();
 let release!:()=>void;const blocked=new Promise<void>(r=>{release=r;});
 const prepare=vi.fn(()=>blocked);
 registerKnowledgeStudio(api,db,()=>actor,{prepare,search:async()=>[],mode:async()=> 'keyword'});
 try{
  await api.ready(); await vi.waitFor(()=>expect(prepare).toHaveBeenCalled(),{timeout:2500});
  const c=await createKnowledgeConversation(db,actor,library.id,'curation','QA'); const id=randomUUID();
  await sendKnowledgeMessage(db,actor,c.id,'检查内部资料',id,'manual');
  await vi.waitFor(()=>expect(processing).toHaveBeenCalledWith(id),{timeout:2500});
 }finally{release();await api.close();await db.destroy();}
});
