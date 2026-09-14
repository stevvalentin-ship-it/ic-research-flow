// @vitest-environment node
import 'fake-indexeddb/auto';
import {afterEach,it,expect} from 'vitest';
import JSZip from 'jszip';
import {db,sha256} from './store.js';
import {exportProject,readProject,restoreLayout,validateNote} from './projects.js';
afterEach(async()=>{for(const table of db.tables)await table.clear()});
const manifest={pages:[{page:1,width:595,height:842,blocks:[{id:'p1-block',order:0,kind:'text',text:'source',bbox:[20,20,200,50]}],words:[{text:'source',blockId:'p1-block',bbox:[20,20,200,50]}],scanned:false}]};
it('exports paper data and translations without any profile secrets',async()=>{
  const original=new Blob(['%PDF-fixture']);const id=await sha256(await original.arrayBuffer());
  await db.files.put({id,original});await db.translations.put({cache_key:'x',paper_id:id,block_id:'p1-block',source_hash:await sha256('source'),target:'中文译文',profile:{profile:{base_url:'https://model.example',model:'example',api_key:'SHOULD_NOT_EXPORT'},target:'zh-CN',consent:true},edited:true});
  const current=structuredClone(manifest);current.pages[0].blocks[0].sourceHash=await sha256('source');
  const blob=await exportProject({id,title:'Fixture',filename:'fixture.pdf',pages:1,authors:[],tags:[],manifest:current});
  const zip=await JSZip.loadAsync(await blob.arrayBuffer()),text=await zip.file('project.json').async('string');expect(text).not.toContain('SHOULD_NOT_EXPORT');expect(text).not.toContain('api_key');
  const restored=await readProject(new File([blob],'project.zip'));expect(restored.id).toBe(id);expect(restored.payload.translations[0].target).toBe('中文译文');
});
it('rejects swapped PDFs and unexpected archive entries',async()=>{
  const zip=new JSZip();zip.file('original.pdf','%PDF-other');zip.file('project.json',JSON.stringify({schema:'icrf-project-v3',paperId:'wrong'}));
  await expect(readProject(new File([await zip.generateAsync({type:'uint8array'})],'bad.zip'))).rejects.toThrow('指纹');
  zip.file('run.exe','not executable');await expect(readProject(new File([await zip.generateAsync({type:'uint8array'})],'bad.zip'))).rejects.toThrow('不支持');
});
it('validates restored geometry and recomputes source hashes',async()=>{
  const restored=await restoreLayout(manifest,manifest);expect(restored.pages[0].blocks[0].sourceHash).toBe(await sha256('source'));
  const bad=structuredClone(manifest);bad.pages[0].blocks[0].bbox=[0,0,900,50];await expect(restoreLayout(bad,manifest)).rejects.toThrow('坐标');
  expect(()=>validateNote({page:2,kind:'ink',points:[]},1)).toThrow();expect(()=>validateNote({page:1,kind:'box',rects:[[0,0,NaN,1]]},1)).toThrow();
});
