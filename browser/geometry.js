export function textItemBox(transform,advance,pageWidth,pageHeight){
  const [a,b,c,d,x,y]=transform,norm=Math.hypot(a,b)||1;
  const dx=a/norm*Math.max(1,advance),dy=b/norm*Math.max(1,advance);
  const corners=[[x+.88*c,y+.88*d],[x+dx+.88*c,y+dy+.88*d],[x-.12*c,y-.12*d],[x+dx-.12*c,y+dy-.12*d]];
  return [Math.max(0,Math.min(...corners.map(p=>p[0]))),Math.max(0,Math.min(...corners.map(p=>p[1]))),Math.min(pageWidth,Math.max(...corners.map(p=>p[0]))),Math.min(pageHeight,Math.max(...corners.map(p=>p[1])))];
}
export function normalizedPointToPdf(point,viewport){return viewport.convertToPdfPoint(point[0]*viewport.width,point[1]*viewport.height)}
export function normalizedRectToPdf(rect,viewport){
  const corners=[[rect[0],rect[1]],[rect[2],rect[1]],[rect[0],rect[3]],[rect[2],rect[3]]].map(p=>normalizedPointToPdf(p,viewport));
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
}
