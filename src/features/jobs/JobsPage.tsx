import { Clock3, ListChecks } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProcessingJob } from '../../domain/types'
import { researchDatabase } from '../../storage/database'
import { StatusBadge } from '../../components/StatusBadge'

export function JobsPage() {
  const [jobs, setJobs] = useState<ProcessingJob[]>([])
  useEffect(() => { void researchDatabase.jobs.orderBy('updatedAt').reverse().toArray().then(setJobs) }, [])
  return <div className="page-container"><div className="page-title-row"><div><p className="eyebrow">RESUMABLE PIPELINE</p><h1>处理队列</h1><p>每篇论文独立解析；单篇失败不会中断整个批次。</p></div></div><section className="table-card job-card">{jobs.length ? jobs.map((job) => <div className="job-row" key={job.id}><ListChecks size={18} /><div><strong>{job.paperId.slice(0, 16)}</strong><progress value={job.progress} max="100" /></div><StatusBadge status={job.stage} /><span>{job.progress}%</span></div>) : <div className="empty-library"><div><Clock3 size={30} /></div><h2>当前没有等待任务</h2><p>导入论文后，解析、AI 分析和索引进度会显示在这里。</p></div>}</section></div>
}
