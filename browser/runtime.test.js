// @vitest-environment node
import 'fake-indexeddb/auto';
import {it,expect,vi,beforeEach,afterAll} from 'vitest';
vi.hoisted(()=>{globalThis.BroadcastChannel=undefined});
vi.mock('./pdf.js',()=>({
  openPdf:vi.fn(async()=>({numPages:1,getMetadata:async()=>({info:{Title:'Fixture'}}),destroy:async()=>{}})),
  parseDocument:vi.fn(async()=>({version:'test',pages:[{page:1,width:595,height:842,scanned:false,text:'source text',words:[],blocks:[{id:'p1-shared',page:1,order:0,kind:'text',text:'source text',sourceHash:'source-hash',bbox:[10,10,200,100]}]}]})),
  renderPage:vi.fn(async()=>new Blob(['png'],{type:'image/png'})),
  composePdf:vi.fn(async()=>({blob:new Blob(['%PDF-translated']),manifest:{pages:[{page:1,width:595,height:842,words:[],blocks:[]}],alignment:[]}})),
  annotatedPdf:vi.fn(async()=>new Blob(['%PDF-marked']))
}));
vi.mock('./ai.js',async importOriginal=>({...await importOriginal(),complete:vi.fn(async()=>({text:'中文译文',usage:{total_tokens:10}}))}));
import {db} from './store.js';
import {api,translationKey} from './runtime.js';
import {complete} from './ai.js';
import {composePdf} from './pdf.js';
const spec={profile:{base_url:'https://model.example',model:'m',api_key:'secret-key'},target:'zh-CN',glossary:{},consent:true};
async function settle(id){await vi.waitFor(async()=>{const j=await db.jobs.get(id);expect(['completed','failed','cancelled']).toContain(j.status)},{timeout:5000});return db.jobs.get(id)}
async function importPdf(name='a.pdf'){
  const form=new FormData();form.append('file',new File(['%PDF-'+name],name));form.append('consent','true');const result=await api('/api/papers/import',{method:'POST',body:form});const job=await settle(result.job_id);expect(job.status).toBe('completed');return job.paper_id;
}
beforeEach(async()=>{for(const t of db.tables)await t.clear();vi.clearAllMocks()});
afterAll(()=>db.close());
it('imports atomically, deduplicates and preserves notes after metadata edits',async()=>{
  const id=await importPdf();const form=new FormData();form.append('file',new File(['%PDF-a.pdf'],'a.pdf'));form.append('consent','true');expect(await api('/api/papers/import',{method:'POST',body:form})).toMatchObject({duplicate:true});
  await api(`/api/papers/${id}/notes`,{method:'POST',body:{page:1,kind:'highlight',rects:[[.1,.1,.5,.2]],comment:'本地笔记'}});
  await api(`/api/papers/${id}`,{method:'PUT',body:{revision:1,title:'Updated',authors:[],tags:[],year:2026,doi:''}});
  expect((await api(`/api/papers/${id}/notes`)).notes[0].comment).toBe('本地笔记');
  await expect(api(`/api/papers/${id}`,{method:'PUT',body:{revision:1,title:'Stale'}})).rejects.toThrow('重新载入');
});
it('keeps keys out of jobs/cache and reuses cached translations without billing',async()=>{
  const id=await importPdf();const run=await api(`/api/papers/${id}/translate`,{method:'POST',body:spec});expect((await settle(run.job_id)).status).toBe('completed');
  expect(complete).toHaveBeenCalledTimes(1);expect(composePdf).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await db.jobs.toArray())).not.toContain('secret-key');expect(JSON.stringify(await db.translations.toArray())).not.toContain('secret-key');
  const repeat=await api(`/api/papers/${id}/translate`,{method:'POST',body:spec});expect((await settle(repeat.job_id)).status).toBe('completed');expect(complete).toHaveBeenCalledTimes(1);
});
it('isolates identical source blocks by paper and rejects compose with missing cache',async()=>{
  expect(await translationKey('a',{id:'same',sourceHash:'same'},spec)).not.toBe(await translationKey('b',{id:'same',sourceHash:'same'},spec));
  const id=await importPdf();const run=await api(`/api/papers/${id}/compose`,{method:'POST',body:spec});expect((await settle(run.job_id)).status).toBe('failed');expect(complete).not.toHaveBeenCalled();
});
it('requires consent and never reads papers in normal chat',async()=>{
  await expect(api('/api/chat',{method:'POST',body:{profile:spec.profile,mode:'normal',question:'hello'}})).rejects.toThrow('同意');
  const noEvidence=await api('/api/chat',{method:'POST',body:{profile:spec.profile,mode:'evidence',question:'unmatched',consent:true}});expect(noEvidence.localOnly).toBe(true);expect(complete).not.toHaveBeenCalled();
  await importPdf();await api('/api/chat',{method:'POST',body:{profile:spec.profile,mode:'normal',question:'hello',consent:true}});expect(JSON.stringify(vi.mocked(complete).mock.calls[0][1])).not.toContain('source text');
});
it('invalidates generated PDFs when text changes and removes related data together',async()=>{
  const id=await importPdf();await api(`/api/papers/${id}/notes`,{method:'POST',body:{page:1,kind:'box',rects:[[.1,.1,.5,.2]],comment:'test'}});
  await api(`/api/papers/${id}/layout`,{method:'PUT',body:{revision:1,changes:[{id:'p1-shared',kind:'text',order:0,text:'corrected source'}]}});
  const p=await api(`/api/papers/${id}`);expect(p.revision).toBe(2);expect(p.manifest.pages[0].text).toBe('corrected source');expect(p.translated).toBe(0);
  await api(`/api/papers/${id}`,{method:'DELETE'});expect(await db.files.get(id)).toBeUndefined();expect(await db.notes.count()).toBe(0);
});
