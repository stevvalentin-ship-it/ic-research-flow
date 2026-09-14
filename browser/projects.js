import JSZip from 'jszip';
import { db, sha256, publicSpec } from './store.js';

export function validateNote(raw,pages){
  if(!raw||!Number.isInteger(raw.page)||raw.page<1||raw.page>pages||!['highlight','box','ink'].includes(raw.kind))throw new Error('笔记页码或类型无效。');
  const note={page:raw.page,kind:raw.kind};
  for(const k of ['quote','latex','answer','comment','model']){if(raw[k]!==undefined&&typeof raw[k]!=='string')throw new Error('笔记文本无效。');note[k]=(raw[k]||'').slice(0,k==='model'?150:30000)}
  for(const [key,size,max]of [['rects',4,150],['points',2,1500]]){
    const arr=raw[key]||[];if(!Array.isArray(arr)||arr.length>max||arr.some(r=>!Array.isArray(r)||r.length!==size||r.some(n=>!Number.isFinite(n)||n<0||n>1)||(size===4&&(r[0]>=r[2]||r[1]>=r[3]))))throw new Error('笔记坐标无效。');note[key]=arr;
  }
  return note;
}
export async function exportProject(paper){
  const files=await db.files.get(paper.id),zip=new JSZip();
  const notes=(await db.notes.where('paper_id').equals(paper.id).toArray()).map(n=>({...validateNote(n,paper.pages),created:n.created}));
  const currentBlocks=new Map(paper.manifest.pages.flatMap(pg=>pg.blocks).map(b=>[b.id,b.sourceHash]));
  const translations=(await db.translations.where('paper_id').equals(paper.id).toArray()).filter(t=>currentBlocks.get(t.block_id)===t.source_hash).map(t=>({block_id:t.block_id,source_hash:t.source_hash,target:t.target,edited:t.edited,profile:publicSpec(t.profile)}));
  const {title,authors,year,doi,tags,filename}=paper;
  zip.file('original.pdf',await files.original.arrayBuffer());
  zip.file('project.json',JSON.stringify({schema:'icrf-project-v3',edition:'browser-3.1',paperId:paper.id,metadata:{title,authors,year,doi,tags,filename},layout:paper.manifest,notes,translations,translatedCurrent:!!paper.translated,translationAlignment:paper.translation?.alignment||[],outputProfile:paper.output?publicSpec(paper.output.profile):null,exported:Date.now()/1000}));
  zip.file('CHECKSUMS.json',JSON.stringify({'original.pdf':paper.id}));
  if(files.translated)zip.file('translated.pdf',await files.translated.arrayBuffer());
  return zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:3}});
}
export async function readProject(file){
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const names=Object.keys(zip.files);if(names.length>6||names.some(n=>!['original.pdf','project.json','translated.pdf','CHECKSUMS.json'].includes(n)))throw new Error('项目包包含不支持的文件。');
  if(!zip.file('original.pdf')||!zip.file('project.json'))throw new Error('项目包缺少 original.pdf 或 project.json。');
  // Reject excessive declared sizes before decompression, then check actual sizes too.
  for(const item of Object.values(zip.files)){const size=item._data?.uncompressedSize;if(size>150*1024*1024||(item.name==='project.json'&&size>20*1024*1024))throw new Error('项目包解压后超过大小限制。');}
  const metadata=await zip.file('project.json').async('string');if(metadata.length>20*1024*1024)throw new Error('项目记录过大。');
  const payload=JSON.parse(metadata),bytes=await zip.file('original.pdf').async('uint8array');
  if(bytes.length>100*1024*1024)throw new Error('原 PDF 超过 100 MB。');
  const id=await sha256(bytes);if(payload.schema!=='icrf-project-v3'||payload.paperId!==id)throw new Error('项目格式或 PDF 指纹不匹配。');
  if(!Array.isArray(payload.notes)||payload.notes.length>3000||!Array.isArray(payload.translations)||payload.translations.length>30000)throw new Error('项目记录数量无效。');
  const translated=zip.file('translated.pdf')?new Blob([await zip.file('translated.pdf').async('uint8array')],{type:'application/pdf'}):null;
  if(translated?.size>150*1024*1024)throw new Error('译文 PDF 超过大小限制。');
  return {payload,id,translated,file:new File([bytes],String(payload.metadata?.filename||'restored.pdf'),{type:'application/pdf'})};
}
export function validateAlignment(rows,source,target){
  if(!Array.isArray(rows)||rows.length>100000)throw new Error('译文段落对齐记录无效。');
  return rows.map(row=>{
    const pg=source.pages[row.sourcePage-1],tp=target.pages[row.targetPage-1];
    if(!pg||!tp||typeof row.blockId!=='string'||row.blockId.length>100)throw new Error('译文段落页码无效。');
    for(const [r,p]of [[row.sourceRect,pg],[row.targetRect,tp]])if(!Array.isArray(r)||r.length!==4||r.some(x=>!Number.isFinite(x))||r[0]<0||r[1]<0||r[2]>p.width+.1||r[3]>p.height+.1||r[0]>=r[2]||r[1]>=r[3])throw new Error('译文段落坐标无效。');
    return {blockId:row.blockId,sourcePage:row.sourcePage,targetPage:row.targetPage,sourceRect:row.sourceRect,targetRect:row.targetRect};
  });
}
export async function restoreLayout(saved,fresh){
  if(!saved||!Array.isArray(saved.pages)||saved.pages.length!==fresh.pages.length)throw new Error('项目版式页数不匹配。');
  const ids=new Set(),pages=[];
  for(let i=0;i<fresh.pages.length;i++){
    const old=saved.pages[i],pg=fresh.pages[i];
    if(old.page!==pg.page||Math.abs(old.width-pg.width)>.1||Math.abs(old.height-pg.height)>.1||!Array.isArray(old.blocks)||old.blocks.length>2000)throw new Error('项目页面尺寸或记录无效。');
    const rect=r=>{if(!Array.isArray(r)||r.length!==4||r.some(n=>!Number.isFinite(n))||r[0]<-.1||r[1]<-.1||r[2]>pg.width+.1||r[3]>pg.height+.1||r[0]>=r[2]||r[1]>=r[3])throw new Error('项目版式坐标无效。');return r};
    const blocks=[];
    for(const b of old.blocks){
      if(typeof b.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.id)||ids.has(b.id)||!['text','protected','ignore'].includes(b.kind)||typeof b.text!=='string'||b.text.length>30000||!Number.isInteger(b.order)||b.order<0)throw new Error('项目内容块无效。');
      ids.add(b.id);blocks.push({id:b.id,page:pg.page,kind:b.kind,text:b.text,order:b.order,bbox:rect(b.bbox),sourceHash:await sha256(b.text),fontSize:10.5,role:b.role==='asset'?'asset':'paragraph',reason:'由项目备份恢复，请对照原页核对。'});
    }
    if(!Array.isArray(old.words)||old.words.length>18000)throw new Error('项目文字层无效。');
    const words=old.words.map(w=>{if(typeof w.text!=='string'||w.text.length>30000||(w.blockId&&!blocks.some(b=>b.id===w.blockId)))throw new Error('项目文字层引用无效。');return {text:w.text,bbox:rect(w.bbox),blockId:w.blockId||null}});
    pages.push({...pg,blocks,words,text:blocks.filter(b=>b.kind==='text').map(b=>b.text).join('\n\n'),scanned:!!old.scanned,layoutReviewed:!!old.layoutReviewed,ocr:!!old.ocr});
  }
  return {...fresh,pages};
}
