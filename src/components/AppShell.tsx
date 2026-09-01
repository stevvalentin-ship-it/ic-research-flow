import { BookOpenText, Boxes, Cpu, FlaskConical, Network, Plus, Search, Settings2, ShieldCheck } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'

const links = [
  { to: '/', label: '投入论文', icon: Plus },
  { to: '/library', label: '论文库', icon: BookOpenText },
  { to: '/research', label: '科研检索', icon: Network },
  { to: '/jobs', label: '处理队列', icon: Boxes },
]

export function AppShell() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="芯研流首页">
          <span className="brand-mark"><Cpu size={19} /></span>
          <span><strong>芯研流</strong><small>IC RESEARCH FLOW</small></span>
        </NavLink>
        <div className="global-search"><Search size={15} /><span>检索本地论文、方法、工艺节点…</span><kbd>⌘ K</kbd></div>
        <div className="privacy-indicator"><ShieldCheck size={14} />LOCAL ONLY</div>
      </header>
      <aside className="sidebar">
        <nav>{links.map(({ to, label, icon: Icon }) => <NavLink key={to} end={to === '/'} to={to}><Icon size={18} /><span>{label}</span></NavLink>)}</nav>
        <div className="sidebar-bottom">
          <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer"><FlaskConical size={18} /><span>API 控制台</span></a>
          <NavLink to="/"><Settings2 size={18} /><span>连接设置</span></NavLink>
        </div>
      </aside>
      <main className="workspace"><Outlet /></main>
    </div>
  )
}
