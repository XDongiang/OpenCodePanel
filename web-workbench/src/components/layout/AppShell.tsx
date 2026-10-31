import { useEffect, useState, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { MigrationBanner } from './MigrationBanner'
import { useSettingsStore } from '../../stores/settings-store'
import { serverApi } from '../../lib/api/server'
import { useAuthStore } from '../../stores/auth-store'
import type { AppNotification } from '../../types'

interface AppShellProps {
  children: ReactNode
}

/** 消息铃铛:未读计数(30s 轮询),展开最近消息,支持标已读/清空。 */
function NotificationBell() {
  const token = useAuthStore((s) => s.token)
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    if (!token) return
    try {
      const { count } = await serverApi.notificationUnreadCount()
      setUnread(count)
    } catch {
      /* 服务端不可达时保持现状 */
    }
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const toggle = async () => {
    setOpen((v) => !v)
    if (!open && token) {
      try {
        const list = await serverApi.listNotifications(10)
        setItems(list)
        void refresh()
      } catch {
        /* ignore */
      }
    }
  }

  const markRead = async (id: string) => {
    if (busy) return
    setBusy(true)
    try {
      await serverApi.markNotificationRead(id)
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readBy: [...n.readBy, token ?? ''] } : n)))
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      await serverApi.clearNotifications()
      setItems([])
      setUnread(0)
    } finally {
      setBusy(false)
    }
  }

  const isRead = (n: AppNotification) => token ? n.readBy.includes(token) : false

  return (
    <div className="relative">
      <button
        onClick={() => void toggle()}
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        title="消息中心"
      >
        <span className="text-lg leading-none">🔔</span>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <span className="text-xs font-medium text-slate-600">消息中心</span>
              {items.length > 0 && (
                <button onClick={() => void clearAll()} className="text-xs text-slate-400 hover:text-red-500">全部清空</button>
              )}
            </div>
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-slate-400">暂无消息</p>
            ) : (
              <ul className="max-h-80 divide-y divide-slate-50 overflow-y-auto">
                {items.map((n) => (
                  <li key={n.id} className={'px-3 py-2 ' + (isRead(n) ? 'opacity-50' : '')}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-slate-700">{n.title}</p>
                      {!isRead(n) && (
                        <button onClick={() => void markRead(n.id)} className="shrink-0 text-[10px] text-blue-500 hover:underline">
                          标为已读
                        </button>
                      )}
                    </div>
                    {n.body && <p className="mt-0.5 text-[11px] text-slate-500">{n.body}</p>}
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {n.link ? (
                        <a href={n.link} className="text-blue-500 hover:underline" onClick={() => setOpen(false)}>前往 ↗</a>
                      ) : null}
                      {' ' + new Date(n.createdAt).toLocaleString('zh-CN')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function AppShell({ children }: AppShellProps) {
  // 启动时从服务端加载人员名单(旧 localStorage 数据由 MigrationBanner 一次性迁移)
  useEffect(() => {
    void useSettingsStore.getState().hydratePersonnel()
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50">
      <MigrationBanner />
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <div className="flex h-12 items-center justify-end border-b border-slate-200 bg-white px-4">
          <NotificationBell />
        </div>
        {children}
      </main>
    </div>
  )
}
