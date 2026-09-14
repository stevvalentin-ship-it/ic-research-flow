import Dexie from 'dexie';

// A separate database keeps the former React edition available for explicit migration.
export const db = new Dexie('icrf-browser-3');
db.version(1).stores({papers:'id,updated', files:'id', notes:'id,paper_id', translations:'cache_key,paper_id', jobs:'id,paper_id,status,updated', edges:'[source+target]'});
export const now = () => Date.now()/1000;
export async function sha256(value) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function publicSpec(s) {
  return {profile:{base_url:s.profile?.base_url||'',model:s.profile?.model||''},target:s.target||'zh-CN',glossary:s.glossary||{}};
}
export function assertRevision(actual, expected) {
  if(actual !== expected) throw new Error('内容已在其他页面修改，请重新载入后再保存。');
}
export async function getPaper(id) {
  const p = await db.papers.get(id);
  if(!p) throw new Error('论文不存在，请返回论文库。');
  return p;
}
export async function removePaper(id) {
  const active = await db.jobs.where('paper_id').equals(id).filter(j=>['queued','running'].includes(j.status)).count();
  if(active) throw new Error('请先停止这篇论文的处理任务，再删除。');
  await db.transaction('rw',db.papers,db.files,db.notes,db.translations,db.edges,async()=>{
    await db.papers.delete(id);await db.files.delete(id);
    await db.notes.where('paper_id').equals(id).delete();
    await db.translations.where('paper_id').equals(id).delete();
    await db.edges.filter(e=>e.source===id||e.target===id).delete();
  });
}
