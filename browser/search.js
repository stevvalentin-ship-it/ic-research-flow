import {scanReferences,citationTitles} from './references.js';
const relations={foundation:1.25,extends:1.1,validates:1,contradicts:1,background:.55};
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function tokens(text){
  const out=normalize(text).match(/[a-z0-9]+|[\u3400-\u9fff]+/g)||[];
  return out.flatMap(s=>/[\u3400-\u9fff]/.test(s)&&s.length>1?Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)):s);
}
const terms=p=>new Set(tokens(`${p.title} ${(p.tags||[]).join(' ')}`));
const similarity=(a,b)=>{const x=terms(a),y=terms(b);return [...x].filter(t=>y.has(t)).length/(new Set([...x,...y]).size||1)};
export const discoverReferences=papers=>scanReferences(papers).edges;
export function pageRank(ids,edges,{damping=.85,personalization={},weights=relations}={}){
  if(!ids.length)return {};
  const total=ids.reduce((s,id)=>s+Math.max(0,personalization[id]||0),0);
  const p=Object.fromEntries(ids.map(id=>[id,total?Math.max(0,personalization[id]||0)/total:1/ids.length]));
  const outgoing=new Map();
  for(const e of edges){if(!(e.source in p)||!(e.target in p)||e.relation==='similarity')continue;const w=weights[e.relation]??0;if(w>0)outgoing.set(e.source,[...(outgoing.get(e.source)||[]),{target:e.target,w}]);}
  let rank={...p};
  for(let i=0;i<150;i++){
    const next=Object.fromEntries(ids.map(id=>[id,(1-damping)*p[id]]));
    for(const id of ids){const es=outgoing.get(id)||[],sum=es.reduce((s,e)=>s+e.w,0);if(sum)for(const e of es)next[e.target]+=damping*rank[id]*e.w/sum;else for(const target of ids)next[target]+=damping*rank[id]*p[target];}
    const delta=ids.reduce((s,id)=>s+Math.abs(next[id]-rank[id]),0);rank=next;if(delta<1e-9)break;
  }
  return rank;
}
export function buildGraph(papers,saved=[],options={}){
  const ids=new Set(papers.map(p=>p.id));const valid=saved.filter(e=>ids.has(e.source)&&ids.has(e.target));
  const excluded=valid.filter(e=>e.excluded),confirmed=valid.filter(e=>!e.excluded);
  const scanned=scanReferences(papers);
  const automatic=scanned.edges.filter(e=>!valid.some(x=>x.source===e.source&&x.target===e.target));
  const edges=[...confirmed.map(e=>({...e,confirmed:true})),...automatic];
  const ranks=pageRank([...ids],edges.filter(e=>e.confirmed||options.include_candidates));
  const similarities=[],topicPapers=papers.map(p=>({...p,title:citationTitles(p)[0]||p.title}));
  if(options.similarity)for(let i=0;i<papers.length;i++)for(let j=i+1;j<papers.length;j++){const score=similarity(topicPapers[i],topicPapers[j]);if(score>.2)similarities.push({source:papers[i].id,target:papers[j].id,relation:'similarity',score,sharedTerms:[...terms(topicPapers[i])].filter(t=>terms(topicPapers[j]).has(t))});}
  return {nodes:papers.map(p=>({id:p.id,title:p.title,year:p.year,tags:p.tags,rank:ranks[p.id]})),edges,excluded,similarities,diagnostics:{topicSimilarity:{enabled:!!options.similarity,threshold:.2,pairs:similarities.length,method:'完整标题/标签 Jaccard；短标题由原文件名补足'},referenceScan:scanned.diagnostics,confirmedEdges:confirmed.length,candidateEdges:automatic.length,rankedEdges:edges.filter(e=>e.confirmed||options.include_candidates).length,ranks,scope:'仅当前浏览器论文库；主题相似不参与排名。'}};
}
export function searchPapers(papers,saved,args={}){
  const query=[...new Set(tokens(args.query))];if(!query.length)return {results:[],diagnostics:{candidates:0,hits:0}};
  const defaults={relevance:40,influence:30,recency:15,evidence:10,bridge:5};
  const fields={title:5,keywords:3,abstract:2,fulltext:1,...args.fields},weights={...defaults,...args.weights};
  if(Object.values(weights).every(w=>w===0))Object.assign(weights,defaults);
  const docs=papers.filter(p=>(!args.tag||p.tags.includes(args.tag))&&(!args.year_from||p.year>=args.year_from)&&(!args.year_to||p.year&&p.year<=args.year_to)).map(p=>({p,fields:{title:tokens(p.title),keywords:tokens(p.tags.join(' ')),abstract:tokens(p.manifest.pages[0]?.text?.slice(0,3000)),fulltext:tokens(p.manifest.pages.map(pg=>pg.text).join(' '))}}));
  const avg=Object.fromEntries(Object.keys(fields).map(f=>[f,docs.reduce((s,d)=>s+d.fields[f].length,0)/(docs.length||1)||1]));
  const frequency=Object.fromEntries(query.map(t=>[t,docs.filter(d=>Object.values(d.fields).some(ts=>ts.includes(t))).length]));
  const rows=docs.map(({p,fields:fs})=>{
    let score=0;
    for(const t of query){const idf=Math.log(1+(docs.length-frequency[t]+.5)/(frequency[t]+.5));for(const[f,w]of Object.entries(fields)){const tf=fs[f].filter(x=>x===t).length;score+=w*idf*tf*2.2/(tf+1.2*(.25+.75*fs[f].length/avg[f]));}}
    const snippets=p.manifest.pages.map(pg=>{const ts=tokens(pg.text),hits=query.filter(t=>ts.includes(t)).length;const first=query.map(t=>normalize(pg.text).indexOf(t)).filter(i=>i>=0).sort((a,b)=>a-b)[0]||0;return {page:pg.page,text:pg.text.slice(Math.max(0,first-120),first+600),hits}}).filter(s=>s.hits).sort((a,b)=>b.hits-a.hits).slice(0,3);
    return {...p,bm25:score,snippets};
  }).filter(p=>p.bm25>0);
  const graph=buildGraph(papers,saved,args),rankEdges=graph.edges.filter(e=>e.confirmed||args.include_candidates);
  const maxBM=Math.max(...rows.map(r=>r.bm25),1e-9),mix=args.personalization??.4;
  const ranks=pageRank(papers.map(p=>p.id),rankEdges,{damping:args.damping??.85,weights:{...relations,...args.relations},personalization:Object.fromEntries(papers.map(p=>[p.id,(1-mix)/(papers.length||1)+mix*(rows.find(r=>r.id===p.id)?.bm25||0)/maxBM]))});
  const maxRank=Math.max(...Object.values(ranks),1e-9),weightSum=Object.values(weights).reduce((s,w)=>s+w,0)||1;
  const ranked=rows.map(p=>{
    const neighbors=new Set(rankEdges.filter(e=>e.source===p.id||e.target===p.id).flatMap(e=>[e.source,e.target]).filter(id=>id!==p.id));
    const features={relevance:p.bm25/maxBM,influence:rankEdges.length?(ranks[p.id]||0)/maxRank:0,recency:p.year?Math.pow(.5,Math.max(0,new Date().getFullYear()-p.year)/(args.half_life||5)):0,evidence:Math.min(1,p.snippets.length/3),bridge:neighbors.size/Math.max(1,papers.length-1)};
    return {id:p.id,title:p.title,year:p.year,tags:p.tags,features,snippets:p.snippets,score:Object.entries(features).reduce((s,[k,v])=>s+v*weights[k]/weightSum,0)};
  });
  const chosen=[],remaining=[...ranked];while(remaining.length&&chosen.length<(args.limit||30)){
    remaining.sort((a,b)=>(b.score-(args.diversity??.15)*Math.max(0,...chosen.map(p=>similarity(p,b))))-(a.score-(args.diversity??.15)*Math.max(0,...chosen.map(p=>similarity(p,a)))));chosen.push(remaining.shift());
  }
  return {results:chosen,diagnostics:{candidates:docs.length,hits:rows.length,method:'BM25 按字段加权 + 个性化 PageRank + MMR',weights,fields,rankedEdges:rankEdges.length,unavailableYear:'缺失年份的新近度为 0',scope:'当前浏览器论文库'}};
}
