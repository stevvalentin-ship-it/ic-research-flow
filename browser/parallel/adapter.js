import {createProjectRepository} from './engine/core/project/repository';
import {PaperParallelDb} from './engine/core/project/db';
import {createTaskSnapshot} from './engine/core/task/stateMachine';
import {createBrowserPipelineStages} from './engine/core/pipeline/browserStages';
import {runProductionPipeline} from './engine/core/pipeline/productionPipeline';
import {normalizeDeepSeekModelId} from './engine/core/translate/models';
import {getDocument} from './engine/core/pdf/runtime';
import {normalizeTextItem} from './engine/core/parser/pdfjsAdapter';
import {readerAlignment,alignmentAt} from './alignment.js';
import {buildTranslationCacheKey} from './engine/core/project/cacheKey';
import {SYSTEM_PROMPT_VERSION} from './engine/core/translate/prompts';
import {validateBatchResponse} from './engine/core/translate/protected';

export const ENGINE='paper-parallel-v4.1';
export const DATABASE='icrf-paper-parallel-v1';
const repository=createProjectRepository(DATABASE);
const projectIdFor=id=>'icrf-pp-'+id;
const stagesLabel={parsing:'解析原始 PDF','analyzing-layout':'V4.1 Flash 版式识别',
  'building-glossary':'建立术语表',translating:'翻译与缓存',composing:'生成中文单栏',
  compiling:'编译中文 PDF',aligning:'建立双语对齐',validating:'逐页检查',completed:'完成'};

export async function clearParallelCache(id) {
  const database=new PaperParallelDb(DATABASE),projectId=projectIdFor(id);
  try { await database.transaction('rw',database.tables,async()=>{
    await database.tasks.delete(projectId);
    await database.aiLogs.delete(projectId);
    await database.artifacts.where('projectId').equals(projectId).delete();
    await database.translations.where('projectId').equals(projectId).delete();
  }); } finally { database.close(); }
}

export function validateParallelSpec(spec) {
  if(spec.target && spec.target!=='zh-CN')throw new Error('双 PDF 核心目前生成简体中文单栏 PDF。');
  const model=normalizeDeepSeekModelId(spec.profile.model);
  if(!['deepseek-flash','deepseek-v4-pro'].includes(model))throw new Error('双 PDF 对照请选择 DeepSeek V4.1 Flash 或 V4 Pro；版式检查固定使用 V4.1 Flash。');
  return model;
}

export async function editorRows(id) {
  const input=await repository.findArtifact(projectIdFor(id)+':editor-input');
  if(!input)return [];
  const rows=JSON.parse(await input.blob.text());
  return Promise.all(rows.map(async row=>{
    const cached=await repository.findTranslation(row.key);
    return {...row,cache_key:row.block_id,target:cached?.translation||'',updated:cached?.validatedAt||0,edited:!!cached?.edited};
  }));
}

export async function editTranslation(id,blockId,text,updated) {
  const row=(await editorRows(id)).find(row=>row.block_id===blockId);
  if(!row||row.updated!==updated)throw new Error('译文已更新，请重新载入校对页。');
  const response={blockId,translation:text,alignmentGroups:[{
    sourceSentenceIds:row.request.sourceSentences.map(sentence=>sentence.id),targetSegments:[text],
  }],newTerms:[],warnings:[]};
  const validation=validateBatchResponse([row.request],{blocks:[response]});
  if(!validation.ok)throw new Error('修改未保存：请保留原有数字、公式及保护标记。'+validation.issues.map(issue=>issue.message).join('；'));
  await repository.putTranslation({key:row.key,projectId:projectIdFor(id),blockId,translation:text,
    alignmentGroups:response.alignmentGroups,validatedAt:Date.now(),edited:true});
}

async function targetManifest(blob,alignment,signal) {
  const task=getDocument({data:new Uint8Array(await blob.arrayBuffer())});
  try {
    const pdf=await task.promise,pages=[];
    for(let index=0;index<pdf.numPages;index++) {
      signal.throwIfAborted();
      const page=await pdf.getPage(index+1),viewport=page.getViewport({scale:1}),content=await page.getTextContent();
      const words=content.items.filter(item=>typeof item.str==='string'&&item.str.trim()).map(item=>{
        const r=normalizeTextItem(item,viewport),bbox=[Math.max(0,r.x),Math.max(0,r.y),Math.min(viewport.width,r.x+r.w),Math.min(viewport.height,r.y+r.h)];
        return {text:item.str,bbox,blockId:alignmentAt(alignment,'target',index+1,bbox)?.blockId||''};
      }).filter(w=>w.bbox[2]>w.bbox[0]&&w.bbox[3]>w.bbox[1]);
      const blocks=alignment.filter(row=>row.targetPage===index+1).map((row,order)=>({id:row.blockId,order,kind:'text',bbox:row.targetRect}));
      pages.push({page:index+1,width:viewport.width,height:viewport.height,words,blocks,text:words.map(w=>w.text).join(' ')});
      page.cleanup();
    }
    return {version:ENGINE,pages,alignment};
  } finally { await task.destroy(); }
}

export async function runParallel({paper,file,spec,signal,onProgress=()=>{}}) {
  const modelId=validateParallelSpec(spec),projectId=projectIdFor(paper.id);
  if(spec.fresh)await clearParallelCache(paper.id);
  // Old IC paragraph caches never enter this engine. Only exact engine caches resume.
  await repository.clearProjectLayoutOutputs(projectId);
  const snapshot={...createTaskSnapshot(projectId),settings:{modelId,visionModelId:'deepseek-flash',
    thinkingMode:'disabled',qualityPolicy:spec.qualityPolicy==='strict'?'strict':'readable-first',
    sourceFileName:paper.filename,sourceFileHash:paper.id,targetLayoutPolicy:'single-column',layoutProfileVersion:'zh-single-column-v1'}};
  await repository.putArtifact({key:projectId+':english-pdf',projectId,kind:'english-pdf',blob:file,updatedAt:Date.now()});
  await repository.saveTask(snapshot);
  await repository.clearAiLog(projectId);
  const events=[];
  let progressWrites=Promise.resolve(),writeError,phase='',sourceDone=0,reviewDone=0;
  const notify=patch=>{progressWrites=progressWrites.then(()=>onProgress(patch)).catch(error=>{writeError??=error;});};
  const stages=createBrowserPipelineStages({projectId,snapshot,repository,apiKey:spec.profile.api_key,
    baseUrl:spec.profile.base_url,onAiEvent:event=>{
      events.push({...event,message:event.type+(event.page?`：第 ${event.page}/${event.totalPages} 页`:'')});
      if(event.type==='vision-layout-page')notify({done:++sourceDone,total:event.totalPages,stage:'V4.1 Flash 版式识别',message:`已识别 ${sourceDone}/${event.totalPages} 页${event.cached?'（缓存）':''}`});
      if(event.type==='vision-review-page')notify({done:++reviewDone,total:event.totalPages,stage:'逐页检查',message:`已检查 ${reviewDone}/${event.totalPages} 页`});
    },onCompileProgress:()=>notify({stage:'编译中文 PDF',message:'正在生成中文 PDF 与预览，请保持页面打开。'})});
  const buildGlossary=stages.buildGlossary;
  stages.buildGlossary=(input,signal)=>buildGlossary({...input,glossary:Object.entries(spec.glossary||{}).map(([source,target])=>({source,target}))},signal);
  try {
    const result=await runProductionPipeline({snapshot,repository,signal,stages,onSnapshot:state=>{
      if(state.stage!==phase){phase=state.stage;notify({stage:stagesLabel[phase]||phase,done:0,total:0,message:stagesLabel[phase]||phase});}
      if(phase==='translating')notify({done:state.progress.completed,total:state.progress.total,message:`译文已通过 ${state.progress.completed}/${state.progress.total}，重试 ${state.progress.retries}`});
    }});
    if(result.snapshot.status!=='completed')throw new Error(result.snapshot.error||'双 PDF 处理未完成');
    const [pdf,quality,alignment]=await Promise.all([repository.findArtifact(projectId+':chinese-pdf'),
      repository.findArtifact(projectId+':quality-report'),repository.loadAlignmentManifest(projectId)]);
    if(!pdf||!quality||!alignment)throw new Error('中文 PDF 或检查报告尚未完整保存');
    const report=JSON.parse(await quality.blob.text());
    const manifest=await targetManifest(pdf.blob,readerAlignment(alignment),signal);
    const glossary=Object.entries(spec.glossary||{}).map(([source,target])=>({source,target}));
    const prepared=new Map(result.value.prepared.units.map(unit=>[unit.id,unit]));
    const sourceBlocks=new Map(result.value.doc.blocks.map(block=>[block.id,block]));
    const editorInput=result.value.requests.map(request=>{
      const unit=prepared.get(request.blockId);
      const blockIds=[...(unit?.sourceBlockIds||[]),unit?.sourceBlockId,request.blockId].filter(Boolean);
      return {block_id:request.blockId,source:request.source,request,
        source_pages:[...new Set(blockIds.map(id=>sourceBlocks.get(id)?.pageIndex).filter(page=>page!==undefined).map(page=>page+1))],
        profile:{profile:{base_url:spec.profile.base_url,model:modelId},target:'zh-CN',glossary:spec.glossary||{}},
        key:buildTranslationCacheKey({fileHash:paper.id,promptVersion:SYSTEM_PROMPT_VERSION,modelId,thinkingMode:'disabled',
          glossaryHash:JSON.stringify(glossary),blockId:request.blockId,sourceText:request.source,protectedTokens:request.protectedTokens})};
    });
    await repository.putArtifact({key:projectId+':editor-input',projectId,kind:'icrf-editor-input',
      blob:new Blob([JSON.stringify(editorInput)],{type:'application/json'}),updatedAt:Date.now()});
    await progressWrites;if(writeError)throw writeError;
    return {blob:pdf.blob,manifest,report,engine:ENGINE,projectId,snapshot:result.snapshot};
  } finally {await progressWrites;await repository.saveAiLog(projectId,events);}
}
