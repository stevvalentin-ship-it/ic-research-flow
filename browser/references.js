// Citation discovery reads the original word geometry, independently of translation layout.
const heading=/^\s*(?:\d+[. ]\s*)?(?:references|bibliography|参考文献)\s*(?=$|\[)/iu;
const endHeading=/^\s*(?:(?:[A-Z]|\d+)[. ]\s*)?(?:appendix(?:\s+[A-Z])?|appendices|author biographies|acknowledg(?:e)?ments|附录)\s*$/iu;
const compact=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');

export function citationTitles(paper){
  const clean=text=>String(text||'').replace(/\.pdf$/i,'').replace(/\s*[（(]副本[）)]\s*$/,'')
    .replace(/^\s*\d{1,4}\s*[:：._、-]\s*/, '').trim();
  return [...new Set([clean(paper.title),clean(paper.filename)].filter(title=>{
    const words=title.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)||[];
    return compact(title).length>=20&&words.length>=4;
  }))];
}

function pageLines(page){
  if(!page.words?.length)return String(page.text||'').split(/\r?\n/);
  const columns=page.columns==='double'?[0,1]:[0],lines=[];
  for(const column of columns){
    const words=page.words.filter(w=>columns.length===1||(w.bbox[0]>=page.width/2-10?1:0)===column)
      .sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);
    const rows=[];
    for(const word of words){
      const height=word.bbox[3]-word.bbox[1];
      const row=rows.findLast(r=>Math.abs(r.y-word.bbox[1])<Math.max(2,height*.35));
      if(row)row.words.push(word);else rows.push({y:word.bbox[1],words:[word]});
    }
    lines.push(...rows.map(row=>row.words.sort((a,b)=>a.bbox[0]-b.bbox[0]).map(w=>w.text).join(' ')));
  }
  return lines;
}

function bibliography(paper){
  const sections=[];let active=false;
  for(const page of paper.manifest?.pages||[]){
    const lines=[];
    for(const line of pageLines(page)){
      const start=heading.exec(line);
      if(start){active=true;const rest=line.slice(start[0].length);if(rest.trim())lines.push(rest);continue;}
      if(active&&endHeading.test(line)){active=false;continue;}
      if(active)lines.push(line);
    }
    if(lines.some(line=>line.trim()))sections.push({page:page.page,text:lines.join('\n')});
  }
  return sections;
}

// Offsets retain the original PDF text and page even when punctuation/line breaks differ.
function indexedText(sections){
  let raw='',normalized='';const offsets=[],pages=[];
  for(const section of sections){
    const start=raw.length;raw+=section.text+'\n';
    for(let i=0;i<section.text.length;){
      const char=String.fromCodePoint(section.text.codePointAt(i));
      const normalizedChar=compact(char);normalized+=normalizedChar;
      for(let n=0;n<normalizedChar.length;n++){offsets.push(start+i);pages.push(section.page);}
      i+=char.length;
    }
  }
  return {raw,normalized,offsets,pages};
}

export function scanReferences(papers){
  const startedAt=Date.now(),edges=[],details=[];
  const targets=papers.map(p=>({...p,titles:citationTitles(p)}));
  for(const source of papers){
    const sections=bibliography(source),index=indexedText(sections);
    const detail={paperId:source.id,title:source.title,pagesScanned:source.manifest?.pages.length||0,
      referencePages:sections.map(s=>s.page),titleVariants:citationTitles(source),matches:0};
    for(const target of targets){
      if(source.id===target.id)continue;
      const doi=String(target.doi||'').replace(/^https?:\/\/(?:dx\.)?doi.org\//i,'').trim();
      // Full titles tolerate PDF hyphenation, ligatures and line wrapping. Short acronyms never suffice.
      const candidates=[...(/^10\.\d{4,9}\/\S+$/i.test(doi)?[{text:doi,doi:true,label:'参考文献 DOI 匹配'}]:[]),
        ...target.titles.map(text=>({text,label:'参考文献完整标题匹配'}))];
      for(const candidate of candidates){
        const needle=compact(candidate.text);
        const doiMatch=candidate.doi?new RegExp(candidate.text.split('').map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*')+'(?![\\p{L}\\p{N}/_-]|\\.[\\p{L}\\p{N}])','iu').exec(index.raw):null;
        const at=candidate.doi?(doiMatch?index.offsets.findIndex(offset=>offset>=doiMatch.index):-1):index.normalized.indexOf(needle);
        if(!needle||at<0)continue;
        const start=doiMatch?doiMatch.index:index.offsets[at],end=doiMatch?start+doiMatch[0].length:index.offsets[at+needle.length-1]+1;
        edges.push({source:source.id,target:target.id,relation:'background',confirmed:false,
          page:index.pages[at],evidence:index.raw.slice(Math.max(0,start-160),end+180),evidenceLabel:candidate.label});
        detail.matches++;break;
      }
    }
    details.push(detail);
  }
  return {edges,diagnostics:{id:crypto.randomUUID(),startedAt,finishedAt:Date.now(),elapsedMs:Date.now()-startedAt,
    papersScanned:papers.length,pagesScanned:details.reduce((n,p)=>n+p.pagesScanned,0),
    referencePages:details.reduce((n,p)=>n+p.referencePages.length,0),papersWithReferences:details.filter(p=>p.referencePages.length).length,
    matchedPairs:edges.length,papers:details}};
}
