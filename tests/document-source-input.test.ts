import {it,expect} from 'vitest';
import {resolveDocumentReferences} from '../apps/web/src/features/knowledge/document-source-input.js';
const id='20e776ed-246b-436e-980e-064411e5a309';
const rows=[{id,label:'Network / DNS guide'},{id:'6204c6f3-732b-42f0-beec-e20f40d851c6',label:'Internal / Runbook'},{id:'aca5fcd8-67aa-4256-9d57-6f7f171e80d8',label:'Other / Runbook'}];
it('recognizes links, IDs and unique titles and deduplicates references',()=>{expect(resolveDocumentReferences(`http://localhost:39130/#/r/${id}?view=doc\n${id}\nDNS guide`,rows)).toEqual({ids:[id],unresolved:[]});});
it('rejects ambiguous names and inaccessible IDs',()=>{const unknown='110fd176-11be-4cc2-8fa7-72f5831a9573';expect(resolveDocumentReferences(`Runbook\n${unknown}`,rows)).toEqual({ids:[],unresolved:['Runbook',unknown]});});
it('does not treat arbitrary text containing an ID as a document reference',()=>{expect(resolveDocumentReferences(`example ${id} is not a link`,rows).ids).toEqual([]);});
