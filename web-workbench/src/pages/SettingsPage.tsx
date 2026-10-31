import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { useSettingsStore } from '../stores/settings-store'
import { useAuthStore } from '../stores/auth-store'
import { serverApi } from '../lib/api/server'
import type { PersonEntry, PersonnelLevel, ReportLevel, DigestConfig, PushPeriod } from '../types'
import { PERSON_CATEGORIES } from '../types'
import { DEPARTMENTS } from '../lib/departments'
import { getClient } from '../lib/api/client'
import { exportAllData, restoreFromJson } from '../lib/migration'

const LEVEL_LABELS: Record<PersonnelLevel, string> = {
  school: '校级',
  college: '学院级',
  department: '专业级',
  class: '班级级',
  course: '课程',
  individual: '个人',
}

export function SettingsPage() {
  const settings = useSettingsStore()
  const auth = useAuthStore()
  const navigate = useNavigate()
  const isAdmin = auth.user?.role === 'admin'
  const [apiUrl, setApiUrl] = useState(settings.apiUrl)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [tab, setTab] = useState<'connection' | 'namelist' | 'xhs' | 'users'>('connection')
  const fileRef = useRef<HTMLInputElement>(null as unknown as HTMLInputElement)

  useEffect(() => {
    setApiUrl(settings.apiUrl)
  }, [settings.apiUrl])

  const handleSave = () => {
    settings.updateSettings({ apiUrl })
    const updated = useSettingsStore.getState()
    setApiUrl(updated.apiUrl)
    getClient(updated)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const client = getClient(useSettingsStore.getState())
      await client.listThreads()
      setTestResult({ ok: true, msg: '连接成功!运行时接口可用' })
    } catch (err) {
      setTestResult({ ok: false, msg: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result, { type: 'binary' })
        const firstSheet = wb.SheetNames[0]
        if (!firstSheet) { alert('Excel 文件为空'); return }
        const ws = wb.Sheets[firstSheet]
        if (!ws) { alert('无法读取工作表'); return }
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]

        if (rows.length < 2) {
          alert('Excel 文件至少需要表头行 + 一行数据')
          return
        }

        const header = (rows[0] ?? []) as string[]
        const nameColIdx = header.findIndex(
          (h) => h && ['姓名', '名字', 'name', '名称'].includes(h.trim().toLowerCase())
        )
        const deptColIdx = header.findIndex(
          (h) => h && ['部门', '学院', 'department', 'unit'].includes(h.trim().toLowerCase())
        )
        const roleColIdx = header.findIndex(
          (h) => h && ['职务', '角色', 'role', 'title'].includes(h.trim().toLowerCase())
        )
        const levelColIdx = header.findIndex(
          (h) => h && ['层级', '级别', 'level'].includes(h.trim().toLowerCase())
        )
        const categoryColIdx = header.findIndex(
          (h) => h && ['分类', '类别', 'category'].includes(h.trim().toLowerCase())
        )

        if (nameColIdx === -1) {
          alert('未找到姓名列。请确保表头包含"姓名"列。')
          return
        }

        const now = new Date().toISOString()
        const list: PersonEntry[] = rows.slice(1)
          .filter((row) => row[nameColIdx] && String(row[nameColIdx]).trim())
          .map((row) => {
            const levelRaw = levelColIdx >= 0 ? String(row[levelColIdx] || '').trim() : ''
            const categoryRaw = categoryColIdx >= 0 ? String(row[categoryColIdx] || '').trim() : ''
            const deptRaw = deptColIdx >= 0 ? String(row[deptColIdx] || '').trim() : ''
            const roleRaw = roleColIdx >= 0 ? String(row[roleColIdx] || '').trim() : ''

            // Auto-detect level
            let level: PersonnelLevel = 'individual'
            if (levelRaw.includes('校') || levelRaw === 'school') level = 'school'
            else if (levelRaw.includes('院') || levelRaw === 'college') level = 'college'

            // Auto-detect category
            let category = '其他'
            if (PERSON_CATEGORIES.includes(categoryRaw as never)) {
              category = categoryRaw
            } else if (categoryRaw) {
              category = categoryRaw // free-form
            } else if (level === 'school' && !roleRaw.includes('院')) {
              category = '校领导'
            } else if (level === 'college') {
              category = '院领导'
            }

            return {
              id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: String(row[nameColIdx]).trim(),
              level,
              category,
              college: deptRaw || undefined,
              role: roleRaw || undefined,
              createdAt: now,
              updatedAt: now,
            }
          })

        settings.importPersonnel(list)
        alert(`成功导入 ${list.length} 人`)
      } catch {
        alert('文件解析失败，请确认是有效的 .xlsx 文件')
      }
    }
    reader.readAsBinaryString(file)
  }

  const tabs = [
    { key: 'connection' as const, label: '服务连接' },
    { key: 'namelist' as const, label: '人员名单' },
    { key: 'xhs' as const, label: '小红书' },
    ...(isAdmin ? [{ key: 'users' as const, label: '用户管理' }, { key: 'digests' as const, label: '定期汇总' }] : []),
  ]

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">设置</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 px-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'connection' && (
          <ConnectionTab
            apiUrl={apiUrl}
            saved={saved}
            testing={testing}
            testResult={testResult}
            user={auth.user}
            onApiUrlChange={setApiUrl}
            onSave={handleSave}
            onTest={handleTest}
            onLogout={async () => {
              await auth.logout()
              navigate('/login', { replace: true })
            }}
          />
        )}

        {tab === 'namelist' && (
          <>
            {settings.personnelStatus === 'loading' && (
              <p className="mb-3 text-xs text-slate-500">名单加载中...</p>
            )}
            {settings.personnelStatus === 'error' && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-400">
                名单加载失败:{settings.personnelError ?? '未知错误'}。请检查服务端连接后刷新页面。
              </div>
            )}
            <PersonnelTab
              personnel={settings.personnel}
              readonly={!isAdmin}
              onAdd={settings.addPerson}
              onUpdate={settings.updatePerson}
              onDelete={settings.deletePerson}
              onImport={handleFileUpload}
              onClear={settings.clearPersonnel}
              fileRef={fileRef}
            />
          </>
        )}
        {tab === 'xhs' && <XhsTab />}
        {tab === 'users' && isAdmin && <UsersTab />}
        {tab === 'digests' && isAdmin && <DigestConfigTab />}

        {/* 数据备份(仅管理员) */}
        {isAdmin && (
          <div className="mt-8 border-t border-slate-200 pt-6">
            <h2 className="text-sm font-medium text-slate-600 mb-3">数据备份</h2>
            <BackupSection />
          </div>
        )}
      </div>
    </div>
  )
}

// ── 数据备份 ──
function BackupSection() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleExport = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const json = await exportAllData()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ccnu-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setMsg({ ok: true, text: '已导出备份文件(名单 + 报告)' })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '导出失败' })
    } finally {
      setBusy(false)
    }
  }

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!confirm('还原将整体替换服务器上的名单与报告,确定继续?')) return

    setBusy(true)
    setMsg(null)
    try {
      const text = await file.text()
      const result = await restoreFromJson(text)
      setMsg({ ok: true, text: `还原成功:名单 ${result.personnel} 人,报告 ${result.reports} 份` })
      await useSettingsStore.getState().hydratePersonnel()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '还原失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-lg rounded-xl border border-slate-200 bg-white p-4">
      <p className="mb-3 text-xs text-slate-500">
        导出服务器上的全部名单与报告为 JSON 文件;还原时整体替换。迁移或误删后可用此功能恢复。
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => void handleExport()}
          disabled={busy}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
        >
          {busy ? '处理中...' : '⬇ 导出备份'}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
        >
          ⬆ 还原备份
        </button>
        <input ref={fileRef} type="file" accept=".json" onChange={(e) => void handleRestoreFile(e)} className="hidden" />
      </div>
      {msg && (
        <p className={`mt-3 text-xs ${msg.ok ? 'text-emerald-600' : 'text-red-400'}`}>{msg.text}</p>
      )}
    </div>
  )
}

// ── Connection Tab ──
const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  school: '校级用户',
  college: '院级用户',
}

function ConnectionTab({
  apiUrl, saved, testing, testResult, user,
  onApiUrlChange, onSave, onTest, onLogout,
}: {
  apiUrl: string; saved: boolean; testing: boolean
  testResult: { ok: boolean; msg: string } | null
  user: { username: string; role: string; college?: string } | null
  onApiUrlChange: (v: string) => void
  onSave: () => void; onTest: () => void; onLogout: () => void | Promise<void>
}) {
  return (
    <div className="max-w-lg space-y-5">
      {/* 当前登录用户 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="mb-2.5 block text-sm font-medium text-slate-600">当前登录</label>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-600">
            {user?.username.slice(0, 1).toUpperCase() ?? '?'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-800">{user?.username}</p>
            <p className="text-xs text-slate-500">
              {user ? `${ROLE_LABELS[user.role] ?? user.role}${user.college ? ` · ${user.college}` : ''}` : '未登录'}
            </p>
          </div>
          <button
            onClick={() => void onLogout()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-red-400 transition-colors"
          >
            退出登录
          </button>
        </div>
        <p className="mt-2.5 text-xs text-slate-500">角色与可见范围由管理员在「用户管理」中分配,此处无需手动配置令牌。</p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-slate-600">运行时 API 地址</label>
        <input type="text" value={apiUrl} onChange={(e) => onApiUrlChange(e.target.value)}
          placeholder="/runtime-api"
          className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none transition-colors" />
        <p className="mt-1.5 text-xs text-slate-500">一般保持默认(<code className="text-slate-500">/runtime-api</code>),由服务器代理到 CodeWhale Runtime</p>
      </div>
      <div className="flex gap-3">
        <button onClick={onSave}
          className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
          {saved ? '✓ 已保存' : '保存'}
        </button>
        <button onClick={() => void onTest()} disabled={testing}
          className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors">
          {testing ? '检测中...' : '测试连接'}
        </button>
      </div>
      {testResult && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          testResult.ok ? 'border-emerald-200 bg-emerald-500/5 text-emerald-600'
            : 'border-red-200 bg-red-50 text-red-400'}`}>
          {testResult.msg}
        </div>
      )}
    </div>
  )
}

// ── Personnel Tab ──
function PersonnelTab({
  personnel, readonly, onAdd, onUpdate, onDelete, onImport, onClear, fileRef,
}: {
  personnel: PersonEntry[]
  readonly?: boolean
  onAdd: (entry: Omit<PersonEntry, 'id' | 'createdAt' | 'updatedAt'>) => void
  onUpdate: (id: string, patch: Partial<PersonEntry>) => void
  onDelete: (id: string) => void
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
  onClear: () => void
  fileRef: React.RefObject<HTMLInputElement>
}) {
  const [levelFilter, setLevelFilter] = useState<ReportLevel | 'all'>('all')
  const [collegeFilter, setCollegeFilter] = useState('')
  const [searchText, setSearchText] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Collect state
  const [showCollect, setShowCollect] = useState(false)
  const [collectDept, setCollectDept] = useState<string>(DEPARTMENTS[0])
  const [collecting, setCollecting] = useState(false)
  const [collectResult, setCollectResult] = useState<PersonEntry[] | null>(null)
  const [collectError, setCollectError] = useState('')
  const [collectPreview, setCollectPreview] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Form state
  const emptyForm = () => ({
    name: '', level: 'individual' as PersonnelLevel, category: '其他',
    college: '', role: '',
  })
  const [form, setForm] = useState(emptyForm())

  // Filter
  const filtered = personnel.filter(p => {
    if (levelFilter !== 'all' && p.level !== levelFilter) return false
    if (collegeFilter && p.college !== collegeFilter) return false
    if (searchText) {
      const q = searchText.toLowerCase()
      if (!p.name.toLowerCase().includes(q) &&
        !(p.role || '').toLowerCase().includes(q) &&
        !(p.college || '').toLowerCase().includes(q)) return false
    }
    return true
  })

  // Group by level
  const schoolGroup = filtered.filter(p => p.level === 'school')
  const collegeGroup = filtered.filter(p => p.level === 'college')
  const deptGroup = filtered.filter(p => p.level === 'department')
  const classGroup = filtered.filter(p => p.level === 'class')
  const courseGroup = filtered.filter(p => p.level === 'course')
  const individualGroup = filtered.filter(p => p.level === 'individual')

  // Unique colleges from personnel for filter dropdown
  const usedColleges = [...new Set(personnel.map(p => p.college).filter(Boolean))] as string[]

  const startEdit = (p: PersonEntry) => {
    setEditingId(p.id)
    setForm({ name: p.name, level: p.level, category: p.category, college: p.college || '', role: p.role || '' })
    setShowAddForm(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setForm(emptyForm())
  }

  const handleAdd = () => {
    if (!form.name.trim()) return
    onAdd({
      name: form.name.trim(),
      level: form.level,
      category: form.category,
      college: form.college || undefined,
      role: form.role || undefined,
    })
    setForm(emptyForm())
    setShowAddForm(false)
  }

  const handleUpdate = () => {
    if (!editingId || !form.name.trim()) return
    onUpdate(editingId, {
      name: form.name.trim(),
      level: form.level,
      category: form.category,
      college: form.college || undefined,
      role: form.role || undefined,
    })
    cancelEdit()
  }

  const handleSubmit = () => {
    if (editingId) handleUpdate()
    else handleAdd()
  }

  // ── Collect handler ──
  const handleCollect = async () => {
    setCollecting(true)
    setCollectError('')
    setCollectResult(null)
    try {
      const client = getClient()
      const thread = await client.createThread({ model: 'deepseek-v4-pro', auto_approve: true })
      const collegeName = collectDept
      await client.startTurn(thread.id, {
        prompt: `$ccnu-personnel-collect 请采集华中师范大学${collegeName}的领导和教师信息。先参考 memory/ccnu-websites.md 获取官网地址，如未找到则用 web_search 搜索。最终以 JSON 代码块输出所有采集到的人员信息。`,
        input_summary: `采集${collegeName}人员信息`,
        auto_approve: true,
      })

      // Poll until complete
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 3000))
        try {
          const detail = await client.getThread(thread.id)
          const agentItems = (detail.items || []).filter(
            (item: any) => item.kind === 'agent_message' && item.status === 'completed'
          )
          const turns = detail.turns || []
          const lastTurn = turns[turns.length - 1]

          if (agentItems.length > 0 && lastTurn?.status === 'completed') {
            const text = agentItems.map((item: any) => item.detail || item.summary).join('\n')
            // Parse JSON from the response
            const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
            const jsonStr = jsonMatch?.[1]
            if (!jsonStr) {
              setCollectError('Agent 返回的结果中没有找到 JSON 数据块，请重试')
              return
            }
            const parsed = JSON.parse(jsonStr)
            if (parsed.error) {
              setCollectError(`采集失败：${parsed.reason || parsed.error}`)
              return
            }
            if (!parsed.entries || parsed.entries.length === 0) {
              setCollectError('未采集到该学院的人员信息，官网可能没有公开教师列表')
              return
            }
            const now = new Date().toISOString()
            const entries: PersonEntry[] = parsed.entries
              .filter((e: any) => e.name && typeof e.name === 'string')
              .map((e: any) => ({
                id: `collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: e.name,
                level: (e.level || 'college') as PersonnelLevel,
                category: e.category || '其他',
                college: e.college || collegeName,
                department: e.department || undefined,
                role: e.role || undefined,
                notes: e.notes || undefined,
                createdAt: now,
                updatedAt: now,
              }))
            setCollectResult(entries)
            setSelectedIds(new Set(entries.map(e => e.id)))
            setCollectPreview(true)
            return
          }
          if (lastTurn?.status === 'failed') {
            setCollectError('采集执行失败，请重试')
            return
          }
        } catch { /* retry */ }
      }
      setCollectError('采集超时（4.5分钟），请重试')
    } catch (err: any) {
      setCollectError(err.message || '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  const importCollected = () => {
    if (!collectResult) return
    const selected = collectResult.filter(e => selectedIds.has(e.id))
    if (selected.length === 0) { alert('请至少选择一条'); return }
    selected.forEach(e => onAdd({
      name: e.name,
      level: e.level,
      category: e.category,
      college: e.college,
      department: e.department,
      role: e.role,
      notes: e.notes,
    }))
    setShowCollect(false)
    setCollectResult(null)
    setCollectPreview(false)
    setSelectedIds(new Set())
    alert(`已导入 ${selected.length} 人`)
  }

  const LevelBadge = ({ level }: { level: PersonnelLevel }) => {
    const colors: Record<PersonnelLevel, string> = {
      school: 'bg-purple-500/15 text-purple-600 border-purple-500/30',
      college: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
      department: 'bg-teal-500/15 text-teal-600 border-teal-500/30',
      class: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
      course: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
      individual: 'bg-slate-500/15 text-slate-500 border-slate-500/30',
    }
    return (
      <span className={`inline-block rounded-md border px-1.5 py-0.5 text-xs font-medium ${colors[level]}`}>
        {LEVEL_LABELS[level]}
      </span>
    )
  }

  const FormFields = () => (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="mb-0.5 block text-xs text-slate-500">姓名 *</label>
        <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="输入姓名"
          className="w-28 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none" />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-slate-500">层级</label>
        <select value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value as PersonnelLevel }))}
          className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none">
          <option value="school">校级</option>
          <option value="college">学院级</option>
          <option value="department">专业级</option>
          <option value="class">班级级</option>
          <option value="course">课程</option>
          <option value="individual">个人</option>
        </select>
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-slate-500">分类</label>
        <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          className="w-32 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none">
          {PERSON_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {(form.level === 'college' || form.level === 'individual') && (
        <div>
          <label className="mb-0.5 block text-xs text-slate-500">学院</label>
          <select value={form.college} onChange={e => setForm(f => ({ ...f, college: e.target.value }))}
            className="w-36 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none">
            <option value="">-- 不限 --</option>
            {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="mb-0.5 block text-xs text-slate-500">职务</label>
        <input type="text" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
          placeholder="如：院长"
          className="w-28 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none" />
      </div>
      <button onClick={handleSubmit} disabled={!form.name.trim()}
        className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
        {editingId ? '保存' : '添加'}
      </button>
      {(showAddForm || editingId) && (
        <button onClick={cancelEdit}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:text-slate-600 transition-colors">取消</button>
      )}
    </div>
  )

  const PersonRow = ({ p }: { p: PersonEntry }) => (
    <tr className="text-slate-500 hover:bg-slate-100 group">
      <td className="px-3 py-1.5 text-slate-800 font-medium">{p.name}</td>
      <td className="px-3 py-1.5"><LevelBadge level={p.level} /></td>
      <td className="px-3 py-1.5 text-xs">{p.category}</td>
      <td className="px-3 py-1.5 text-xs">{p.college || '-'}</td>
      <td className="px-3 py-1.5 text-xs">{p.role || '-'}</td>
      <td className="px-3 py-1.5 text-right">
        {!readonly && (
          <>
            <button onClick={() => startEdit(p)}
              className="text-xs text-slate-500 hover:text-blue-600 px-1.5 py-0.5 rounded transition-colors opacity-0 group-hover:opacity-100">
              编辑
            </button>
            <button onClick={() => { if (confirm(`确定删除 ${p.name}？`)) onDelete(p.id) }}
              className="text-xs text-slate-500 hover:text-red-400 px-1.5 py-0.5 rounded transition-colors opacity-0 group-hover:opacity-100">
              删除
            </button>
          </>
        )}
      </td>
    </tr>
  )

  const GroupSection = ({ label, items, colorClass }: {
    label: string; items: PersonEntry[]; colorClass: string
  }) => {
    if (items.length === 0) return null
    return (
      <div className="mb-4">
        <h4 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${colorClass}`}>
          {label} <span className="font-normal text-slate-500">({items.length}人)</span>
        </h4>
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-100 bg-white">
                <th className="text-left px-3 py-1.5 font-medium">姓名</th>
                <th className="text-left px-3 py-1.5 font-medium">层级</th>
                <th className="text-left px-3 py-1.5 font-medium">分类</th>
                <th className="text-left px-3 py-1.5 font-medium">学院</th>
                <th className="text-left px-3 py-1.5 font-medium">职务</th>
                <th className="text-right px-3 py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map(p => <PersonRow key={p.id} p={p} />)}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-lg bg-white p-0.5 border border-slate-200">
          {(['all', 'school', 'college', 'department', 'class', 'course', 'individual'] as const).map(lvl => (
            <button key={lvl} onClick={() => setLevelFilter(lvl)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                levelFilter === lvl ? 'bg-slate-700 text-slate-800' : 'text-slate-500 hover:text-slate-600'
              }`}>
              {lvl === 'all' ? '全部' : LEVEL_LABELS[lvl]}
            </button>
          ))}
        </div>
        <select value={collegeFilter} onChange={e => setCollegeFilter(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 focus:border-blue-500 focus:outline-none">
          <option value="">所有学院</option>
          {usedColleges.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="text" value={searchText} onChange={e => setSearchText(e.target.value)}
          placeholder="搜索姓名/职务..."
          className="w-40 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none" />

        <div className="flex-1" />

        {readonly ? (
          <span className="text-xs text-slate-500">名单只读(由管理员维护)</span>
        ) : (
          <>
            <button onClick={() => { setShowAddForm(!showAddForm); setEditingId(null); setForm(emptyForm()) }}
              className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 transition-colors">
              {showAddForm ? '收起' : '+ 添加人员'}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onImport} className="hidden" />
            <button onClick={() => { setShowCollect(true); setCollectResult(null); setCollectError(''); setCollectPreview(false) }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 transition-colors">
              🌐 采集人员
            </button>
            <button onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 transition-colors">
              📎 导入 Excel
            </button>
          </>
        )}
        {!readonly && personnel.length > 0 && (
          <button onClick={() => { if (confirm('确定清空全部人员？')) onClear() }}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-400 hover:bg-red-50 transition-colors">
            清空全部
          </button>
        )}
      </div>

      {/* Add/Edit form */}
      {(showAddForm || editingId) && (
        <div className={`rounded-xl border p-4 ${editingId ? 'border-yellow-500/20 bg-yellow-500/5' : 'border-blue-200 bg-blue-50'}`}>
          {editingId && <p className="text-xs text-amber-600 mb-2">正在编辑：{personnel.find(p => p.id === editingId)?.name}</p>}
          <FormFields />
        </div>
      )}

      {/* Info bar */}
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span>共 <span className="text-slate-600 font-medium">{personnel.length}</span> 人</span>
        {levelFilter === 'all' && (
          <>
            <span className="text-purple-600">校级 {schoolGroup.length}</span>
            <span className="text-blue-600">学院 {collegeGroup.length}</span>
            <span className="text-teal-600">专业 {deptGroup.length}</span>
            <span className="text-emerald-600">班级 {classGroup.length}</span>
            <span className="text-rose-600">课程 {courseGroup.length}</span>
            <span className="text-slate-500">个人 {individualGroup.length}</span>
          </>
        )}
      </div>

      {/* Grouped list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-500">
          <span className="text-3xl mb-2">📋</span>
          <p className="text-sm">
            {personnel.length === 0 ? '还没有添加任何人员，点击"添加人员"或导入Excel' : '没有匹配的人员'}
          </p>
        </div>
      ) : (
        <>
          {levelFilter === 'all' ? (
            <>
              <GroupSection label="校级人员" items={schoolGroup} colorClass="text-purple-600" />
              <GroupSection label="学院级人员" items={collegeGroup} colorClass="text-blue-600" />
              <GroupSection label="专业级人员" items={deptGroup} colorClass="text-teal-600" />
              <GroupSection label="班级级人员" items={classGroup} colorClass="text-emerald-600" />
              <GroupSection label="课程" items={courseGroup} colorClass="text-rose-600" />
              <GroupSection label="个人" items={individualGroup} colorClass="text-slate-500" />
            </>
          ) : (
            <GroupSection
              label={
                levelFilter === 'school' ? '校级人员' :
                levelFilter === 'college' ? '学院级人员' :
                levelFilter === 'department' ? '专业级人员' :
                levelFilter === 'class' ? '班级级人员' :
                levelFilter === 'course' ? '课程' : '个人'
              }
              items={filtered}
              colorClass={
                levelFilter === 'school' ? 'text-purple-600' :
                levelFilter === 'college' ? 'text-blue-600' :
                levelFilter === 'department' ? 'text-teal-600' :
                levelFilter === 'class' ? 'text-emerald-600' :
                levelFilter === 'course' ? 'text-rose-600' : 'text-slate-500'
              }
            />
          )}
        </>
      )}

      {/* ── Collect Modal ── */}
      {showCollect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { if (!collecting) setShowCollect(false) }}>
          <div className="w-full max-w-lg rounded-2xl border border-slate-300 bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="text-base font-semibold text-slate-900">🌐 采集学院人员</h3>
              <button onClick={() => { if (!collecting) setShowCollect(false) }} className="text-slate-500 hover:text-slate-600 text-lg leading-none">&times;</button>
            </div>
            <div className="p-5 space-y-4">
              {!collectPreview ? (
                <>
                  <p className="text-sm text-slate-500">AI 将自动访问学院官网，采集领导、系主任、教授、辅导员等公开信息。</p>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">选择学院</label>
                    <select value={collectDept} onChange={e => setCollectDept(e.target.value)} disabled={collecting}
                      className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none disabled:opacity-50">
                      {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  {collecting && (
                    <div className="flex items-center gap-3 py-4">
                      <div className="w-6 h-6 rounded-full border-3 border-slate-300 border-t-blue-500 animate-spin" />
                      <p className="text-sm text-slate-500">正在访问 {collectDept} 官网，采集人员信息...</p>
                    </div>
                  )}
                  {collectError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-400">{collectError}</div>
                  )}
                  <div className="flex gap-3 justify-end pt-2">
                    <button onClick={() => setShowCollect(false)} disabled={collecting}
                      className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-500 hover:text-slate-600 disabled:opacity-50 transition-colors">取消</button>
                    <button onClick={() => void handleCollect()} disabled={collecting}
                      className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
                      {collecting ? '采集中...' : '开始采集'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-600">
                    采集完成！共获取 <span className="font-bold">{collectResult?.length || 0}</span> 条人员信息。
                  </div>
                  {collectResult && collectResult.length > 0 && (
                    <div className="max-h-60 overflow-y-auto rounded-xl border border-slate-200">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-slate-50">
                          <tr className="text-xs text-slate-500 border-b border-slate-200">
                            <th className="px-2 py-1.5 text-left font-medium w-8">✓</th>
                            <th className="px-2 py-1.5 text-left font-medium">姓名</th>
                            <th className="px-2 py-1.5 text-left font-medium">分类</th>
                            <th className="px-2 py-1.5 text-left font-medium">职务</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {collectResult.map(e => (
                            <tr key={e.id} className="hover:bg-slate-100">
                              <td className="px-2 py-1.5">
                                <input type="checkbox" checked={selectedIds.has(e.id)}
                                  onChange={() => {
                                    const next = new Set(selectedIds)
                                    if (next.has(e.id)) next.delete(e.id); else next.add(e.id)
                                    setSelectedIds(next)
                                  }} className="rounded accent-blue-500" />
                              </td>
                              <td className="px-2 py-1.5 text-slate-800">{e.name}</td>
                              <td className="px-2 py-1.5 text-xs text-slate-500">{e.category}</td>
                              <td className="px-2 py-1.5 text-xs text-slate-500">{e.role || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex gap-3 justify-end pt-2">
                    <button onClick={() => { setCollectPreview(false); setCollectResult(null) }}
                      className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-500 hover:text-slate-600 transition-colors">放弃</button>
                    <button onClick={importCollected}
                      className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors">
                      导入选中 ({selectedIds.size})
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── 用户管理 Tab(仅 admin)──
function UsersTab() {
  const [users, setUsers] = useState<Array<{ id: string; username: string; role: string; college?: string; disabled: boolean }>>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ username: '', password: '', role: 'college', college: String(DEPARTMENTS[0]) })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ role: 'college', college: String(DEPARTMENTS[0]), password: '' })

  const load = useCallback(async () => {
    try {
      setUsers(await serverApi.listUsers())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载用户失败')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleCreate = async () => {
    setBusy(true); setError('')
    try {
      await serverApi.createUser({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        college: form.role === 'college' ? form.college : undefined,
      })
      setForm({ username: '', password: '', role: 'college', college: DEPARTMENTS[0] })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally { setBusy(false) }
  }

  const handleSaveEdit = async (id: string) => {
    setBusy(true); setError('')
    try {
      await serverApi.updateUser(id, {
        role: editForm.role,
        college: editForm.role === 'college' ? editForm.college : undefined,
        password: editForm.password || undefined,
      })
      setEditingId(null)
      setEditForm({ role: 'college', college: DEPARTMENTS[0], password: '' })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
    } finally { setBusy(false) }
  }

  const handleToggleDisabled = async (id: string, disabled: boolean) => {
    try {
      await serverApi.updateUser(id, { disabled })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  const handleDelete = async (id: string, username: string) => {
    if (!confirm(`确定删除用户 ${username}?`)) return
    try {
      await serverApi.deleteUser(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-400">{error}</div>
      )}

      {/* 创建用户 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-slate-600">新建用户</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="用户名" className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none" />
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="密码(至少8位)" className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none">
            <option value="college">院级用户</option>
            <option value="school">校级用户</option>
            <option value="admin">管理员</option>
          </select>
          {form.role === 'college' && (
            <select value={form.college} onChange={(e) => setForm({ ...form, college: e.target.value })}
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none">
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <button onClick={() => void handleCreate()} disabled={busy || !form.username.trim() || form.password.length < 8}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
            创建
          </button>
        </div>
      </div>

      {/* 用户列表 */}
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-100 bg-white">
              <th className="text-left px-4 py-2 font-medium">用户名</th>
              <th className="text-left px-4 py-2 font-medium">角色</th>
              <th className="text-left px-4 py-2 font-medium">学院</th>
              <th className="text-left px-4 py-2 font-medium">状态</th>
              <th className="text-right px-4 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map((u) => (
              <tr key={u.id} className="text-slate-500 hover:bg-slate-100">
                <td className="px-4 py-2 text-slate-800 font-medium">{u.username}</td>
                <td className="px-4 py-2 text-xs">
                  {editingId === u.id ? (
                    <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                      className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-800">
                      <option value="college">院级用户</option>
                      <option value="school">校级用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  ) : (
                    ROLE_LABELS[u.role] ?? u.role
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  {editingId === u.id && editForm.role === 'college' ? (
                    <select value={editForm.college} onChange={(e) => setEditForm({ ...editForm, college: e.target.value })}
                      className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-800">
                      {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  ) : (
                    u.college || '-'
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  {u.disabled ? <span className="text-red-400">已禁用</span> : <span className="text-emerald-600">正常</span>}
                </td>
                <td className="px-4 py-2 text-right text-xs space-x-1">
                  {editingId === u.id ? (
                    <>
                      <button onClick={() => void handleSaveEdit(u.id)} disabled={busy}
                        className="rounded bg-emerald-600 px-2 py-1 text-white hover:bg-emerald-500 disabled:opacity-50">保存</button>
                      <button onClick={() => setEditingId(null)}
                        className="rounded border border-slate-300 px-2 py-1 text-slate-500 hover:text-slate-800">取消</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setEditingId(u.id); setEditForm({ role: u.role, college: u.college ?? String(DEPARTMENTS[0]), password: '' }) }}
                        className="rounded border border-slate-300 px-2 py-1 text-slate-500 hover:text-blue-600">编辑</button>
                      <button onClick={() => {
                        const p = window.prompt(`为 ${u.username} 设置新密码(至少8位)`)
                        if (p && p.length >= 8) {
                          void serverApi.updateUser(u.id, { password: p }).then(load).catch((err) => setError(err instanceof Error ? err.message : '重置密码失败'))
                        } else if (p !== null && p !== '') {
                          setError('密码至少 8 位')
                        }
                      }}
                        className="rounded border border-slate-300 px-2 py-1 text-slate-500 hover:text-amber-600">重置密码</button>
                      <button onClick={() => void handleToggleDisabled(u.id, !u.disabled)}
                        className="rounded border border-slate-300 px-2 py-1 text-slate-500 hover:text-amber-600">
                        {u.disabled ? '启用' : '禁用'}
                      </button>
                      <button onClick={() => void handleDelete(u.id, u.username)}
                        className="rounded border border-red-200 px-2 py-1 text-red-400 hover:bg-red-50">删除</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 小红书 Tab ──
function XhsTab() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null) // null = checking
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  /** idle | generating(发起中) | scanning(显示二维码/扫码中) */
  const [step, setStep] = useState<'idle' | 'generating' | 'scanning'>('idle')
  const [qrImage, setQrImage] = useState('')   // 二维码图片(dataURL,可扫码)
  const [qrAscii, setQrAscii] = useState('')   // 无链接时退化的 ASCII
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const api = (url: string, method = 'GET', timeout = 15000) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    const headers: Record<string, string> = {}
    const token = useSettingsStore.getState().authToken
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(url, { method, signal: ctrl.signal, headers })
      .then(r => r.json())
      .catch(() => ({ ok: false, output: '请求超时或失败' }))
      .finally(() => clearTimeout(timer))
  }

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    api('/api/xhs/status').then(d => {
      setLoggedIn(d.ok && !d.output.includes('Not logged in'))
      if (d.ok) setMsg(d.output.slice(0, 200))
    })
    return stopPolling
  }, [])

  const doLogin = async () => {
    setBusy(true)
    setMsg('')
    const d = await api('/api/xhs/login', 'POST')
    setMsg(d.output)
    if (d.ok) {
      const s = await api('/api/xhs/status')
      setLoggedIn(s.ok && !s.output.includes('Not logged in'))
    }
    setBusy(false)
  }

  const generateQr = async () => {
    setStep('generating')
    setMsg('正在启动扫码登录,请稍候...')
    setQrImage('')
    setQrAscii('')

    const d = await api('/api/xhs/login-qrcode', 'POST', 60000)
    if (!d.ok) {
      setMsg(d.output || '启动扫码登录失败')
      setStep('idle')
      return
    }
    setMsg('请用小红书 App 扫描二维码(生成后请尽快扫码)')

    // 有链接 → 渲染成图片(大、清晰可扫);否则退化为 ASCII
    if (typeof d.qrUrl === 'string' && d.qrUrl) {
      setQrAscii('')
      try {
        const QRCode = (await import('qrcode')).default
        setQrImage(await QRCode.toDataURL(d.qrUrl, { width: 240, margin: 1 }))
      } catch {
        setQrImage('')
        setQrAscii(d.output || '')
      }
    } else {
      setQrAscii(d.output || '')
    }

    setStep('scanning')
    stopPolling()
    let tries = 0
    pollRef.current = setInterval(async () => {
      tries += 1
      const s = await api('/api/xhs/status')
      if (s.ok && !s.output.includes('Not logged in')) {
        setLoggedIn(true)
        setMsg('✅ 登录成功:' + s.output.slice(0, 120))
        setStep('idle')
        setQrImage('')
        setQrAscii('')
        stopPolling()
        return
      }
      if (tries >= 90) {
        setMsg('二维码已过期,请点击「重新生成」再试')
        setStep('idle')
        setQrImage('')
        setQrAscii('')
        stopPolling()
      }
    }, 2000)
  }

  const cancelQr = async () => {
    await api('/api/xhs/cancel', 'POST')
    stopPolling()
    setStep('idle')
    setQrImage('')
    setQrAscii('')
    setMsg('已取消扫码登录')
  }

  const doLogout = async () => {
    setBusy(true)
    await api('/api/xhs/logout', 'POST')
    setLoggedIn(false)
    setMsg('')
    setBusy(false)
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <span className="text-3xl">📕</span>
        <h3 className="text-base font-semibold text-slate-800 mt-2 mb-1">小红书</h3>
        <p className="text-sm text-slate-500 mb-4">
          {loggedIn === null ? '检测中...' : loggedIn ? '✅ 已登录' : '未登录'}
        </p>

        {/* 二维码图片(推荐) */}
        {qrImage && (
          <div className="mb-4 inline-block rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <img src={qrImage} alt="小红书登录二维码" className="h-60 w-60" />
          </div>
        )}
        {/* 退化的 ASCII 二维码 */}
        {!qrImage && qrAscii && step === 'scanning' && (
          <div className="mb-4 inline-block max-w-full overflow-x-auto rounded-lg border border-slate-200 bg-white p-3">
            <pre className="text-[8px] leading-[8px] text-black font-mono select-all whitespace-pre">{qrAscii}</pre>
          </div>
        )}

        {/* 扫码中:进度提示 */}
        {step === 'scanning' && (
          <div className="mb-4 flex items-center justify-center gap-2 text-xs text-slate-500">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" />
            等待扫码(超时 3 分钟自动过期)
          </div>
        )}

        {msg && step !== 'scanning' && (
          <p className="mb-4 text-xs text-slate-500 whitespace-pre-wrap break-all max-h-20 overflow-auto font-mono">{msg}</p>
        )}

        <div className="flex flex-col gap-2 items-center">
          {!loggedIn && step === 'idle' && (
            <>
              <button onClick={doLogin} disabled={busy}
                className="w-48 rounded-xl bg-gradient-to-r from-red-500 to-pink-500 px-4 py-2.5 text-sm font-medium text-white hover:from-red-400 disabled:opacity-50 transition-all">
                {busy ? '...' : '🔑 浏览器登录'}
              </button>
              <button onClick={() => void generateQr()} disabled={busy}
                className="w-48 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-all">
                📱 扫码登录
              </button>
            </>
          )}
          {!loggedIn && step === 'generating' && (
            <button disabled
              className="w-48 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-500">
              正在生成二维码...
            </button>
          )}
          {!loggedIn && step === 'scanning' && (
            <>
              <button onClick={() => void cancelQr()} disabled={busy}
                className="w-48 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-50 transition-all">
                取消
              </button>
              <button onClick={() => void generateQr()} disabled={busy}
                className="w-48 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-50 transition-all">
                重新生成
              </button>
            </>
          )}
          {loggedIn && (
            <button onClick={doLogout} disabled={busy}
              className="w-48 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50 transition-all">
              退出登录
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
