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
vi.mock('./parallel/adapter.js',()=>({
  validateParallelSpec:vi.fn(),clearParallelCache:vi.fn(async()=>{}),
  runParallel:vi.fn(async()=>({blob:new Blob(['%PDF-parallel']),manifest:{pages:[{page:1,width:595,height:842,words:[],blocks:[]}],alignment:[]},
    engine:'paper-parallel-v4.1',projectId:'icrf-pp-test',report:{pass:false,deliveryStatus:'needs-review',attempts:[]}})),
}));
import {db} from './store.js';
import {api,translationKey} from './runtime.js';
import {complete} from './ai.js';
import {composePdf} from './pdf.js';
import {runParallel,clearParallelCache} from './parallel/adapter.js';
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
it('replaces the translation engine and preserves a truthful review report without changing source data',async()=>{
  const id=await importPdf();const run=await api(`/api/papers/${id}/translate`,{method:'POST',body:spec});expect((await settle(run.job_id)).status).toBe('completed');
  expect(runParallel).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();expect(composePdf).not.toHaveBeenCalled();
  expect((await db.papers.get(id)).manifest.pages[0].blocks[0].id).toBe('p1-shared');
  expect((await db.papers.get(id)).output.quality).toMatchObject({pass:false,deliveryStatus:'needs-review'});
  expect(JSON.stringify(await db.jobs.toArray())).not.toContain('secret-key');expect(JSON.stringify(await db.translations.toArray())).not.toContain('secret-key');
  const repeat=await api(`/api/papers/${id}/translate`,{method:'POST',body:spec});expect((await settle(repeat.job_id)).status).toBe('completed');expect(runParallel).toHaveBeenCalledTimes(2);expect(complete).not.toHaveBeenCalled();
  const reflow=await api(`/api/papers/${id}/compose`,{method:'POST',body:spec});expect((await settle(reflow.job_id)).status).toBe('completed');
  expect(runParallel).toHaveBeenCalledTimes(3);expect(composePdf).not.toHaveBeenCalled();
});
it('isolates identical source blocks by paper and requires consent for the new reflow review',async()=>{
  expect(await translationKey('a',{id:'same',sourceHash:'same'},spec)).not.toBe(await translationKey('b',{id:'same',sourceHash:'same'},spec));
  const id=await importPdf();await expect(api(`/api/papers/${id}/compose`,{method:'POST',body:{...spec,consent:false}})).rejects.toThrow('同意');expect(runParallel).not.toHaveBeenCalled();
});
it('requires consent and never reads papers in normal chat',async()=>{
  await expect(api('/api/chat',{method:'POST',body:{profile:spec.profile,mode:'normal',question:'hello'}})).rejects.toThrow('同意');
  const noEvidence=await api('/api/chat',{method:'POST',body:{profile:spec.profile,mode:'evidence',question:'unmatched',consent:true}});expect(noEvidence.localOnly).toBe(true);expect(complete).not.toHaveBeenCalled();
  await importPdf();await api('/api/chat',{method:'POST',body:{profile:spec.profile,mode:'normal',question:'hello',consent:true}});expect(JSON.stringify(vi.mocked(complete).mock.calls[0][1])).not.toContain('source text');
});
it('rescans current local papers and logs each run without using the model',async()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});
  try{
    const id=await importPdf();
    const first=await api('/api/graph/rescan',{method:'POST'});
    expect(first.diagnostics.referenceScan).toMatchObject({papersScanned:1,pagesScanned:1});
    await importPdf('b.pdf');
    const next=await api('/api/graph/rescan?similarity=true',{method:'POST'});
    expect(next.diagnostics.referenceScan.papersScanned).toBe(2);
    expect(next.diagnostics.referenceScan.id).not.toBe(first.diagnostics.referenceScan.id);
    expect(complete).not.toHaveBeenCalled();expect(log.mock.calls.filter(c=>c[0]==='[citation-scan] completed')).toHaveLength(2);
    expect(await db.papers.get(id)).toBeDefined();
  }finally{log.mockRestore();}
});
it('invalidates generated PDFs when text changes and removes related data together',async()=>{
  const id=await importPdf();await api(`/api/papers/${id}/notes`,{method:'POST',body:{page:1,kind:'box',rects:[[.1,.1,.5,.2]],comment:'test'}});
  await api(`/api/papers/${id}/layout`,{method:'PUT',body:{revision:1,changes:[{id:'p1-shared',kind:'text',order:0,text:'corrected source'}]}});
  const p=await api(`/api/papers/${id}`);expect(p.revision).toBe(2);expect(p.manifest.pages[0].text).toBe('corrected source');expect(p.translated).toBe(0);
  await api(`/api/papers/${id}`,{method:'DELETE'});expect(await db.files.get(id)).toBeUndefined();expect(await db.notes.count()).toBe(0);expect(clearParallelCache).toHaveBeenCalledWith(id);
});
