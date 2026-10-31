import { useEffect, type ReactNode } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { ChatView } from './pages/ChatView'
import { HistoryPage } from './pages/HistoryPage'
import { MonitorPage } from './pages/MonitorPage'
import { SettingsPage } from './pages/SettingsPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { JobsPage } from './pages/JobsPage'
import { ResearchPage } from './pages/ResearchPage'
import { LoginPage } from './pages/LoginPage'
import { useAuthStore } from './stores/auth-store'
import { setUnauthorizedHandler } from './lib/api/server'

/** 受保护区域:会话恢复完成后,未登录跳转登录页。 */
function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)

  if (status === 'loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        正在恢复会话...
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function LoginRoute() {
  const user = useAuthStore((s) => s.user)
  if (user) return <Navigate to="/" replace />
  return <LoginPage />
}

export function App() {
  const hydrate = useAuthStore((s) => s.hydrate)
  const forceLogout = useAuthStore((s) => s.forceLogout)

  useEffect(() => {
    void hydrate()
    // 任意 /api 请求返回 401 → 本地清会话,守卫自动跳登录
    setUnauthorizedHandler(() => forceLogout())
    return () => setUnauthorizedHandler(null)
  }, [hydrate, forceLogout])

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route path="/" element={<ChatView />} />
                <Route path="/chat/:id" element={<ChatView />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/monitor" element={<MonitorPage />} />
                <Route path="/kb" element={<KnowledgePage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/research" element={<ResearchPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
