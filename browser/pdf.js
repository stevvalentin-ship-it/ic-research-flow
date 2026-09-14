import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { sha256 } from './store.js';
import {textItemBox,normalizedPointToPdf,normalizedRectToPdf} from './geometry.js';

pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
const asset = p=>new URL(import.meta.env.BASE_URL+p,document.baseURI).href;
export async function openPdf(blob,password='') {
  const task=pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer()),password,
    cMapUrl:asset('pdfjs/cmaps/'),cMapPacked:true,standardFontDataUrl:asset('pdfjs/standard_fonts/'),wasmUrl:asset('pdfjs/wasm/'),isEvalSupported:false});
  try{const doc=await task.promise;return Object.assign(doc,{destroy:()=>task.destroy()})}catch(e){await task.destroy();throw new Error(e.name==='PasswordException'?'PDF 需要正确的密码，请重新导入。':`PDF 无法打开：${e.message}`)}
}
const check=s=>s?.throwIfAborted();
const union=items=>[Math.min(...items.map(x=>x.bbox[0])),Math.min(...items.map(x=>x.bbox[1])),Math.max(...items.map(x=>x.bbox[2])),Math.max(...items.map(x=>x.bbox[3]))];
export async function parseDocument(doc,{signal,progress=()=>{}}={}) {
  if(doc.numPages>250)throw new Error('单篇最多支持 250 页。');
  const pages=[];
  for(let page=1;page<=doc.numPages;page++){
    check(signal);const p=await doc.getPage(page),viewport=p.getViewport({scale:1});
    const content=await p.getTextContent();check(signal);
    const words=content.items.filter(i=>typeof i.str==='string'&&i.str.trim()).map(i=>{
      const t=pdfjs.Util.transform(viewport.transform,i.transform);
      return {text:i.str,bbox:textItemBox(t,i.width,viewport.width,viewport.height),eol:i.hasEOL};
    }).filter(w=>w.bbox[2]>w.bbox[0]&&w.bbox[3]>w.bbox[1]);
    const lines=[];
    for(const w of [...words].sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0])){
      let line=lines.findLast(l=>Math.abs(l.bbox[1]-w.bbox[1])<Math.max(2,(w.bbox[3]-w.bbox[1])*.35)&&w.bbox[0]-l.bbox[2]<30);
      if(line){line.words.push(w);line.words.sort((a,b)=>a.bbox[0]-b.bbox[0]);line.bbox=union(line.words)}
      else lines.push({words:[w],bbox:[...w.bbox]});
    }
    const mid=viewport.width/2;
    const left=lines.filter(l=>l.bbox[2]<mid+10&&l.bbox[0]<mid-50),right=lines.filter(l=>l.bbox[0]>mid-10);
    const double=left.length>8&&right.length>8;
    const top=double?Math.min(left[0].bbox[1],right[0].bbox[1]):0;
    const group=l=>!double?0:l.bbox[1]<top-3?0:l.bbox[0]>=mid-10?2:l.bbox[2]<mid+10?1:3;
    lines.sort((a,b)=>group(a)-group(b)||a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);
    const groups=[];
    for(const line of lines){
      const prev=groups.at(-1),last=prev?.at(-1),height=line.bbox[3]-line.bbox[1];
      if(last&&group(last)===group(line)&&line.bbox[1]-last.bbox[3]<height*.65&&Math.abs(line.bbox[0]-last.bbox[0])<24&&prev.length<12)prev.push(line);
      else groups.push([line]);
    }
    const blocks=[];
    for(const [order,ls] of groups.entries()){
      const ws=ls.flatMap(l=>l.words),text=ls.map(l=>l.words.map(w=>w.text).join(' ')).join('\n');
      const hash=await sha256(text),id=`p${page}-${order}-${hash.slice(0,12)}`;ws.forEach(w=>w.blockId=id);
      blocks.push({id,page,order,kind:'text',role:'paragraph',text,sourceHash:hash,bbox:union(ws),fontSize:ls[0].bbox[3]-ls[0].bbox[1],reason:'PDF.js 文字层分组；请核对双栏顺序与公式。'});
    }
    const text=blocks.map(b=>b.text).join('\n\n');
    // A source-page facsimile retains every diagram and equation in the translated PDF.
    blocks.push({id:`p${page}-source`,page,order:blocks.length,kind:'protected',role:'asset',text:'原页图表与公式核对图',sourceHash:await sha256(`source-${page}`),bbox:[0,0,viewport.width,viewport.height],fontSize:10,reason:'原页缩图保留全部图表与公式；正文译文在前。'});
    pages.push({page,width:viewport.width,height:viewport.height,words,blocks,text,columns:double?'double':'single',scanned:text.trim().length<20});
    p.cleanup();await progress(page,doc.numPages);
  }
  return {version:'icrf-browser-layout-3.1',pages};
}
export async function renderPage(doc,pageNumber,scale=1.5,rect=null){
  const page=await doc.getPage(pageNumber),vp=page.getViewport({scale:Math.min(3,scale)});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('浏览器不能创建 PDF 画布。');
  await page.render({canvas,canvasContext:ctx,viewport:vp,background:'#ffffff'}).promise;
  let out=canvas;
  if(rect){out=document.createElement('canvas');out.width=Math.max(1,Math.round((rect[2]-rect[0])*canvas.width));out.height=Math.max(1,Math.round((rect[3]-rect[1])*canvas.height));out.getContext('2d').drawImage(canvas,rect[0]*canvas.width,rect[1]*canvas.height,out.width,out.height,0,0,out.width,out.height)}
  const blob=await new Promise((res,rej)=>out.toBlob(b=>b?res(b):rej(new Error('页面图像生成失败。')),'image/png'));canvas.width=0;out.width=0;return blob;
}
let fontBytes;
async function loadFont(pdf){
  fontBytes??=fetch(asset('fonts/NotoSansCJKsc-Regular.otf')).then(r=>{if(!r.ok)throw new Error('中文字体载入失败，请检查网络后重新排版。');return r.arrayBuffer()}).catch(e=>{fontBytes=null;throw e});
  pdf.registerFontkit(fontkit);return pdf.embedFont(await fontBytes,{subset:true});
}
export async function composePdf(paper,values,doc,{signal,progress=()=>{}}={}){
  const pdf=await PDFDocument.create(),font=await loadFont(pdf);pdf.setTitle(`${paper.title} · 译文`);
  const W=595,H=842,M=42,lineHeight=17,fontSize=11,pages=[],alignment=[];
  let page,pg,y;
  function next(){page=pdf.addPage([W,H]);pg={page:pages.length+1,width:W,height:H,words:[],blocks:[]};pages.push(pg);y=M}
  function line(text,b){
    if(y+lineHeight>H-M)next();const rect=[M,y,W-M,y+lineHeight];
    page.drawText(text,{x:M,y:H-y-fontSize,size:fontSize,font,color:rgb(.1,.15,.13)});
    pg.words.push({text,bbox:rect,blockId:b.id});pg.blocks.push({id:b.id,order:pg.blocks.length,bbox:rect,kind:'text'});
    alignment.push({blockId:b.id,sourcePage:b.page,sourceRect:b.bbox,targetPage:pg.page,targetRect:rect});y+=lineHeight;
  }
  next();
  for(const source of paper.manifest.pages){
    check(signal);if(y>M)next();
    const heading={id:`page-${source.page}`,page:source.page,bbox:[0,0,source.width,30]};line(`原文第 ${source.page} 页 · 译文 / 保留区域`,heading);y+=10;
    for(const b of [...source.blocks].sort((a,b)=>a.order-b.order)){
      check(signal);if(b.kind==='ignore')continue;
      if(b.kind==='protected'){
        const blob=await renderPage(doc,source.page,1.2,b.bbox.map((n,i)=>n/(i%2?source.height:source.width)));
        const image=await pdf.embedPng(await blob.arrayBuffer()),width=Math.min(W-2*M,image.width),height=image.height*width/image.width;
        const factor=Math.min(1,(H-2*M-30)/height),iw=width*factor,ih=height*factor;
        if(y+ih>H-M)next();page.drawImage(image,{x:M,y:H-y-ih,width:iw,height:ih});
        const rect=[M,y,M+iw,y+ih];pg.blocks.push({id:b.id,order:pg.blocks.length,bbox:rect,kind:'protected'});alignment.push({blockId:b.id,sourcePage:b.page,sourceRect:b.bbox,targetPage:pg.page,targetRect:rect});y+=ih+15;continue;
      }
      const text=values[b.id];if(typeof text!=='string'||!text.trim())throw new Error(`原文第 ${b.page} 页有缺失译文，请先继续翻译。`);
      let current='';
      for(const ch of text.replace(/\r/g,'')){
        if(ch==='\n'){if(current)line(current,b);current='';continue}
        if(font.widthOfTextAtSize(current+ch,fontSize)>W-2*M){line(current,b);current=''}current+=ch;
      }
      if(current)line(current,b);y+=9;
    }
    await progress(source.page,paper.pages);
  }
  check(signal);return {blob:new Blob([await pdf.save()],{type:'application/pdf'}),manifest:{pages,alignment}};
}
export async function annotatedPdf(blob,notes,password){
  if(password)throw new Error('加密原件请先在 PDF 工具中另存为解锁副本，再导出带批注 PDF；笔记 ZIP 仍可导出。');
  const pdf=await PDFDocument.load(await blob.arrayBuffer()),source=await openPdf(blob);
  try{for(const n of notes){const p=pdf.getPage(n.page-1),vp=(await source.getPage(n.page)).getViewport({scale:1});
    for(const r of n.rects||[])p.drawRectangle({...normalizedRectToPdf(r,vp),color:rgb(1,.8,0),opacity:.23,borderColor:rgb(.7,.4,0),borderWidth:.4});
    for(let i=1;i<(n.points||[]).length;i++){const a=normalizedPointToPdf(n.points[i-1],vp),b=normalizedPointToPdf(n.points[i],vp);p.drawLine({start:{x:a[0],y:a[1]},end:{x:b[0],y:b[1]},color:rgb(.1,.4,.3),thickness:1.2})}
  }}finally{await source.destroy()}
  return new Blob([await pdf.save()],{type:'application/pdf'});
}
