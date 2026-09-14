import {describe,it,expect} from 'vitest';
import {readerAlignment,alignmentAt} from './alignment';
describe('Paper Parallel reader geometry',()=>{
  it('preserves independent source and target pages and disjoint highlight rectangles',()=>{
    const rows=readerAlignment({units:[{id:'group-1',source:[{page:7,rects:[{x:10,y:20,w:30,h:5},{x:10,y:30,w:20,h:5}]}],target:[{page:4,rects:[{x:50,y:60,w:20,h:8}]}]}]});
    expect(rows[0]).toMatchObject({blockId:'group-1',sourcePage:8,targetPage:5,sourceRects:[[10,20,40,25],[10,30,30,35]],targetRects:[[50,60,70,68]]});
    expect(alignmentAt(rows,'target',5,[52,61,55,65])).toBe(rows[0]);
    expect(alignmentAt(rows,'source',8,[12,31,16,34])).toBe(rows[0]);
    expect(alignmentAt(rows,'target',8,[52,61,55,65])).toBeUndefined();
  });
  it('omits unavailable coordinates and chooses the actual nearby text fragment',()=>{
    const rows=[{blockId:'a',sourcePage:1,sourceRect:[0,0,200,200],sourceRects:[[0,0,20,10],[180,190,200,200]]},
      {blockId:'b',sourcePage:1,sourceRect:[80,80,120,120],sourceRects:[[80,80,120,120]]}];
    expect(alignmentAt(rows,'source',1,[90,90,100,100]).blockId).toBe('b');
    expect(readerAlignment({units:[{id:'missing',source:[],target:[{page:1,rects:[{x:1,y:1,w:1,h:1}]}]}]})).toEqual([]);
  });
});
