import type { GraphCitationEdge, GraphPaperNode } from './graphModel'

function position(index: number, count: number) {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2
  const radius = index === 0 ? 0 : 155 + (index % 3) * 28
  return { x: 340 + Math.cos(angle) * radius, y: 250 + Math.sin(angle) * radius }
}

export function InfluenceGraph({ nodes, edges, selectedId, onSelect }: { nodes: GraphPaperNode[]; edges: GraphCitationEdge[]; selectedId?: string; onSelect: (id: string) => void }) {
  const positions = new Map(nodes.map((node, index) => [node.id, position(index, nodes.length)]))
  return <div className="graph-canvas"><svg viewBox="0 0 680 500" role="img" aria-label="论文影响力关系图"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#88a8cc" /></marker><filter id="glow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>{edges.map((edge, index) => { const a = positions.get(edge.source); const b = positions.get(edge.target); return a && b ? <line key={`${edge.source}-${edge.target}-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`graph-edge relation-${edge.relation}`} markerEnd="url(#arrow)" strokeWidth={1 + edge.weight * 2.6} strokeOpacity={0.28 + Math.min(0.62, edge.weight * 0.55)} /> : null })}{nodes.map((node, index) => { const p = positions.get(node.id)!; const radius = 10 + node.score * 12; return <g key={node.id} className={`graph-node role-${node.role} ${selectedId === node.id ? 'selected' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect(node.id)} tabIndex={0} role="button"><circle r={radius + 7} className="node-halo" /><circle r={radius} filter={selectedId === node.id ? 'url(#glow)' : undefined} /><text y={radius + 20}>{index + 1}</text><title>{node.title}</title></g> })}</svg><div className="graph-legend"><span><i className="foundation" />奠基</span><span><i className="hub" />枢纽</span><span><i className="frontier" />前沿</span></div></div>
}
