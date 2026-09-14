// @vitest-environment node
import {it,expect} from 'vitest';
import {textItemBox,normalizedRectToPdf} from './geometry.js';
it('maps horizontal and rotated glyph bounds',()=>{
  expect(textItemBox([12,0,0,-12,50,100],100,600,800)).toEqual([50,89.44,150,101.44]);
  expect(textItemBox([0,12,12,0,50,100],100,600,800)).toEqual([48.56,100,60.56,200]);
});
it('inverts rotated view coordinates including CropBox offsets',()=>{
  const viewport={width:800,height:600,convertToPdfPoint:(x,y)=>[y+30,x+50]};
  expect(normalizedRectToPdf([.1,.2,.3,.4],viewport)).toEqual({x:150,y:130,width:120,height:160});
});
