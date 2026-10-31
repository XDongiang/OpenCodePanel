import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { getClient } from '../../lib/api/client'
import { useSettingsStore } from '../../stores/settings-store'
import { useAuthStore } from '../../stores/auth-store'

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  school: '校级用户',
  college: '院级用户',
}

const navItems = [
  { to: '/', label: '对话', icon: '💬', end: true },
  { to: '/monitor', label: '舆情监控', icon: '📊' },
  { to: '/jobs', label: '就业指导', icon: '💼' },
  { to: '/research', label: '科研助理', icon: '🔬' },
  { to: '/kb', label: '知识库', icon: '📚' },
  { to: '/history', label: '历史', icon: '📋' },
  { to: '/settings', label: '设置', icon: '⚙️' },
]

export function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const settings = useSettingsStore()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const [apiStatus, setApiStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking')

  useEffect(() => {
    let cancelled = false
    async function check() {
      setApiStatus('checking')
      try {
        const client = getClient(settings)
        await client.listThreads()
        if (!cancelled) setApiStatus('connected')
      } catch {
        if (!cancelled) setApiStatus('disconnected')
      }
    }
    void check()
    return () => { cancelled = true }
  }, [settings])

  return (
    <aside className="flex h-full w-56 flex-col border-r border-slate-200 bg-gradient-to-b from-white via-white to-slate-50">
      {/* Logo */}
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4">
        {/* CCNU Logo */}
        <img src="/ccnulogo.png" alt="华中师范大学" className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-slate-300/40" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-slate-900 tracking-wide">华师 AI 工作台</h1>
          <p className="text-[10px] text-slate-500">华中师范大学</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 p-3">
        {navItems.map((item) => {
          const active = item.end
            ? location.pathname === item.to
            : location.pathname.startsWith(item.to)

          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 ${
                active
                  ? 'bg-blue-600/10 text-blue-600 font-medium shadow-sm shadow-blue-500/5'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              <span>{item.label}</span>
              {active && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-400" />
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-200 p-3">
        {/* 当前用户 */}
        {user && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-medium text-blue-600">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-800">{user.username}</p>
              <p className="truncate text-[10px] text-slate-500">
                {ROLE_LABEL[user.role] ?? user.role}
                {user.college ? ` · ${user.college}` : ''}
              </p>
            </div>
            <button
              onClick={() => {
                void logout()
                navigate('/login', { replace: true })
              }}
              title="退出登录"
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-400 transition-colors"
            >
              ⎋
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-lg px-3 py-2">
          <span
            className={`inline-block h-2 w-2 rounded-full transition-colors ${
              apiStatus === 'connected'
                ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50'
                : apiStatus === 'checking'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400'
            }`}
          />
          <span className="text-xs text-slate-500">
            {apiStatus === 'connected'
              ? '服务已连接'
              : apiStatus === 'checking'
                ? '检测中...'
                : '服务未连接'}
          </span>
        </div>
      </div>
    </aside>
  )
}
