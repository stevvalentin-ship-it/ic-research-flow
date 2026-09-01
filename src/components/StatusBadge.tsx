import type { AnalysisStatus } from '../domain/types'

const labels: Record<AnalysisStatus, string> = {
  queued: '等待中', parsing: '解析中', analyzing: 'AI 分析中', indexing: '建立索引',
  completed: '已完成', failed: '失败', paused: '已暂停',
}

export function StatusBadge({ status }: { status: AnalysisStatus }) {
  return <span className={`status-badge status-${status}`}><i />{labels[status]}</span>
}
