// Reader coordinates remain top-left PDF points. Engine pages are zero-based.
const union = rects => [Math.min(...rects.map(r=>r[0])), Math.min(...rects.map(r=>r[1])),
  Math.max(...rects.map(r=>r[2])), Math.max(...rects.map(r=>r[3]))];
const boxes = set => set.rects.filter(r=>r.w>0&&r.h>0).map(r=>[r.x,r.y,r.x+r.w,r.y+r.h]);
export function readerAlignment(manifest) {
  return manifest.units.flatMap(unit => unit.source.flatMap(source => unit.target.flatMap(target => {
    const sourceRects=boxes(source),targetRects=boxes(target);
    return sourceRects.length&&targetRects.length ? [{blockId:unit.id,sourcePage:source.page+1,
      targetPage:target.page+1,sourceRect:union(sourceRects),targetRect:union(targetRects),sourceRects,targetRects}] : [];
  })));
}
export function alignmentAt(alignment,side,page,bbox) {
  const x=(bbox[0]+bbox[2])/2,y=(bbox[1]+bbox[3])/2;
  let best,score=Infinity;
  for(const row of alignment) {
    if(row[side+'Page']!==page)continue;
    for(const r of row[side+'Rects']||[row[side+'Rect']]) {
      const dx=Math.max(r[0]-x,0,x-r[2]),dy=Math.max(r[1]-y,0,y-r[3]);
      const distance=dx*dx+dy*dy*4;
      if(distance<score){score=distance;best=row;}
    }
  }
  return best;
}
