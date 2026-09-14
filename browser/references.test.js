// @vitest-environment node
import {expect,it} from 'vitest';
import {scanReferences} from './references.js';
const paper=(id,title,text,extra={})=>({id,title,manifest:{pages:[{page:1,text}]},...extra});
it('uses a full filename title for short metadata and strips file numbering',()=>{
  const target=paper('b','cuZK','',{filename:'06：cuZK：Accelerating Zero-Knowledge Proof with A Faster Parallel Multi-Scalar Multiplication Algorithm on GPUs.pdf'});
  const source=paper('a','Study','References\n[1] Lu et al. Cuzk: Accelerating zero-knowledge proof with a faster parallel multi-scalar multiplication algorithm on gpus.');
  expect(scanReferences([source,target]).edges).toMatchObject([{source:'a',target:'b',page:1,confirmed:false}]);
  source.manifest.pages[0].text='References\ncuZK';expect(scanReferences([source,target]).edges).toEqual([]);
});
it('reads each bibliography column separately when the legacy text mixed both columns',()=>{
  const source=paper('a','Study','References [21] another item\nMIXED COLUMN TEXT');
  source.manifest.pages[0]={page:7,width:600,columns:'double',text:'References [21] another item',words:[
    {text:'References',bbox:[40,180,100,190]},
    {text:'[1] A completely separate reference.',bbox:[40,200,280,210]},
    {text:'[20] PipeZK: Accel-',bbox:[320,180,540,190]},
    {text:'erating Zero-Knowledge Proof with a Pipelined Architecture.',bbox:[320,200,575,210]}]};
  const target=paper('b','04：PipeZK：Accelerating Zero-Knowledge Proof with a Pipelined Architecture','');
  const result=scanReferences([source,target]);expect(result.edges).toMatchObject([{source:'a',target:'b',page:7}]);
  expect(result.edges[0].evidence).toContain('Accel-\nerating');expect(result.diagnostics.papersWithReferences).toBe(1);
});
it('matches a full title across pages and records its starting page',()=>{
  const source=paper('a','Study','');source.manifest.pages=[{page:2,text:'References\n[1] Energy Efficient'},
    {page:3,text:'Memory Accelerator Design.'}];
  const target=paper('b','Energy Efficient Memory Accelerator Design','');
  expect(scanReferences([source,target]).edges).toMatchObject([{page:2}]);
  source.manifest.pages=[{page:1,text:'Body mentions Energy Efficient Memory Accelerator Design.\nReferences\n[1] Unrelated.\nAppendix A\nEnergy Efficient Memory Accelerator Design.'}];
  expect(scanReferences([source,target]).edges).toEqual([]);
});
it('preserves DOI punctuation and does not match a longer DOI sharing the same prefix',()=>{
  const source=paper('a','Study','References\nhttps://doi.org/10.1234/abc-12.'),target=paper('b','Short','',{doi:'10.1234/abc-12'});
  expect(scanReferences([source,target]).edges[0].evidenceLabel).toContain('DOI');
  target.doi='10.1234/abc12';expect(scanReferences([source,target]).edges).toEqual([]);
  target.doi='10.1234/abc';expect(scanReferences([source,target]).edges).toEqual([]);
});
