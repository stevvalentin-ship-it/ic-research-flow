// @vitest-environment node
import { describe,it,expect } from 'vitest';
import {buildGraph,pageRank,searchPapers,discoverReferences,tokens} from './search.js';
const paper=(id,title,text,year=2025)=>({id,title,tags:[],year,manifest:{pages:[{page:1,text}]}});
describe('browser research evidence',()=>{
  it('never fabricates edges or fills unrelated search results',()=>{
    const ps=[paper('a','SRAM energy','SRAM energy'),paper('b','Quantum optics','quantum photons')];
    expect(buildGraph(ps).edges).toEqual([]);expect(searchPapers(ps,[],{query:'unmatched'}).results).toEqual([]);
    expect(searchPapers(ps,[],{query:'SRAM'}).results.map(r=>r.id)).toEqual(['a']);
    expect(searchPapers(ps,[],{query:'SRAM'}).results[0].features.influence).toBe(0);
  });
  it('finds full-title references only in the bibliography and keeps their direction',()=>{
    const target=paper('b','SRAM Energy Efficient Accelerator Design','This is the paper.'),source=paper('a','Study','Discussion: SRAM Energy Efficient Accelerator Design\nReferences\n[1] SRAM Energy Efficient Accelerator Design.');
    expect(discoverReferences([source,target])).toMatchObject([{source:'a',target:'b',confirmed:false,page:1}]);
    source.manifest.pages[0].text='Discussion: SRAM Energy Efficient Accelerator Design';
    expect(discoverReferences([source,target])).toEqual([]);
  });
  it('does not count similarity or excluded candidates in PageRank',()=>{
    const ids=['a','b','c'];const ranks=pageRank(ids,[{source:'a',target:'b',relation:'background'}]);
    expect(ranks.b).toBeGreaterThan(ranks.a);expect(Object.values(ranks).reduce((s,x)=>s+x,0)).toBeCloseTo(1,8);
    expect(pageRank(ids,[{source:'a',target:'b',relation:'similarity'}])).toEqual(pageRank(ids,[]));
    const ps=[paper('a','SRAM Energy Efficient Accelerator Design','References\nA Circuit Memory Accelerator Design'),paper('b','A Circuit Memory Accelerator Design','')];
    expect(buildGraph(ps,[{source:'a',target:'b',excluded:true}]).edges).toEqual([]);
  });
  it('uses field weights, year filters and zero-valued parameters',()=>{
    const ps=[paper('a','SRAM','noise',2020),paper('b','noise','SRAM SRAM',2026)];
    expect(searchPapers(ps,[],{query:'SRAM',fields:{title:0,fulltext:1,abstract:0,keywords:0},year_from:2025}).results.map(p=>p.id)).toEqual(['b']);
    expect(pageRank(['a','b'],[{source:'a',target:'b',relation:'extends'}],{damping:0})).toEqual({a:.5,b:.5});
    expect(tokens('芯片存储器')).toEqual(['芯片','片存','存储','储器']);
  });
  it('falls back to balanced scores for all-zero weights and returns the actual late reference',()=>{
    const target=paper('b','SRAM Energy Efficient Accelerator Design','SRAM'),source=paper('a','Study','References\n'+('Unrelated reference. '.repeat(100))+'\nSRAM Energy Efficient Accelerator Design.');
    expect(discoverReferences([source,target])[0].evidence).toContain(target.title);
    expect(searchPapers([target],[],{query:'SRAM',weights:{relevance:0,influence:0,recency:0,evidence:0,bridge:0}}).results[0].score).toBeGreaterThan(0);
  });
});
