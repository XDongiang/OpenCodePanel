import { useState, useEffect, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { JOB_CATEGORIES, type JobCategory, type JobPosting, type JobStatus } from '../types'
import { DEPARTMENTS } from '../lib/departments'
import { serverApi } from '../lib/api/server'
import { useAuthStore } from '../stores/auth-store'

/**
 * 就业指导:招聘岗位信息库。
 * 读:所有登录用户;写(新增/编辑/删除/导入/失效标记):仅 admin。
 * 支持关键词/学历/地点/状态/学院筛选,Excel 导入导出与就业信息简报。
 */

const DEGREES = ['不限', '大专', '本科', '硕士', '博士'] as const
const STATUS_LABEL: Record<JobStatus, string> = { active: '在招', expired: '已失效' }

/** Excel 表头 → 字段映射(导入与导出共用)。 */
const JOB_COLUMNS: Array<{ key: keyof JobPosting | 'statusLabel'; label: string; aliases?: string[] }> = [
  { key: 'company', label: '单位名称', aliases: ['单位', '公司'] },
  { key: 'position', label: '招聘岗位', aliases: ['岗位', '职位'] },
  { key: 'major', label: '招聘专业', aliases: ['专业'] },
  { key: 'degree', label: '学历要求', aliases: ['学历'] },
  { key: 'location', label: '工作地点', aliases: ['地点', '城市'] },
  { key: 'headcount', label: '招聘人数', aliases: ['人数'] },
  { key: 'salary', label: '薪资待遇', aliases: ['薪资'] },
  { key: 'applyStart', label: '报名时间', aliases: ['报名'] },
  { key: 'deadline', label: '截止时间', aliases: ['截止'] },
  { key: 'url', label: '招聘公告链接', aliases: ['公告链接', '公告', '链接'] },
  { key: 'contact', label: '联系方式', aliases: ['联系'] },
  { key: 'source', label: '信息来源', aliases: ['来源'] },
  { key: 'publishedAt', label: '发布时间', aliases: ['发布'] },
  { key: 'statusLabel', label: '状态', aliases: ['有效期'] },
  { key: 'category', label: '岗位分类', aliases: ['分类', '类别'] },
]

interface JobForm {
  company: string
  position: string
  major: string
  degree: string
  location: string
  headcount: string
  salary: string
  applyStart: string
  deadline: string
  url: string
  contact: string
  source: string
  publishedAt: string
  college: string
  notes: string
}

const EMPTY_FORM: JobForm = {
  company: '', position: '', major: '', degree: '不限', location: '',
  headcount: '', salary: '', applyStart: '', deadline: '', url: '',
  contact: '', source: '手动录入', publishedAt: '', college: '', notes: '',
}

function toForm(j: JobPosting): JobForm {
  return {
    company: j.company, position: j.position, major: j.major ?? '',
    degree: j.degree ?? '不限', location: j.location ?? '', headcount: j.headcount ?? '',
    salary: j.salary ?? '', applyStart: j.applyStart ?? '', deadline: j.deadline ?? '',
    url: j.url ?? '', contact: j.contact ?? '', source: j.source ?? '手动录入',
    publishedAt: j.publishedAt ?? '', college: j.college ?? '', notes: j.notes ?? '',
  }
}

function formToPayload(f: JobForm): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    company: f.company.trim(),
    position: f.position.trim(),
    source: f.source.trim() || '手动录入',
  }
  const optional: Array<[keyof JobForm, string]> = [
    ['major', 'major'], ['degree', 'degree'], ['location', 'location'],
    ['headcount', 'headcount'], ['salary', 'salary'], ['applyStart', 'applyStart'],
    ['deadline', 'deadline'], ['url', 'url'], ['contact', 'contact'],
    ['publishedAt', 'publishedAt'], ['college', 'college'], ['notes', 'notes'],
  ]
  for (const [field, key] of optional) {
    const v = f[field].trim()
    if (v && v !== '不限') payload[key] = v
  }
  return payload
}

function buildBrief(jobs: JobPosting[]): string {
  const now = new Date().toLocaleString('zh-CN')
  const lines: string[] = ['# 就业信息简报', '', '生成时间:' + now, '岗位数量:' + jobs.length + ' 条', '']
  jobs.forEach((j, i) => {
    const head = (i + 1) + '. **' + j.company + '** — ' + j.position
    lines.push(head)
    const parts = [
      j.degree, j.major, j.location,
      j.salary ? '薪资:' + j.salary : '',
      j.deadline ? '截止:' + j.deadline : '',
      j.status === 'expired' ? '⚠ 已失效' : '',
    ].filter(Boolean)
    if (parts.length > 0) lines.push('    ' + parts.join(' | '))
    if (j.url) lines.push('    公告:' + j.url)
    lines.push('')
  })
  return lines.join('\n')
}

const statusCell = (j: JobPosting) =>
  j.status === 'expired'
    ? 'bg-slate-100 text-slate-500'
    : 'bg-emerald-50 text-emerald-600'

export function JobsPage() {
  const auth = useAuthStore()
  const isAdmin = auth.user?.role === 'admin'
  const [jobs, setJobs] = useState<JobPosting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // filters
  const [q, setQ] = useState('')
  const [degree, setDegree] = useState('')
  const [location, setLocation] = useState('')
  const [status, setStatus] = useState('')
  const [college, setCollege] = useState('')
  const [category, setCategory] = useState('')

  // form state
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<JobForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [brief, setBrief] = useState('')
  const [briefOpen, setBriefOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await serverApi.listJobs({
        q: q || undefined,
        degree: degree || undefined,
        location: location || undefined,
        status: status as JobStatus | undefined,
        college: college || undefined,
        category: (category || undefined) as JobCategory | undefined,
      })
      setJobs(list)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载岗位失败')
    } finally {
      setLoading(false)
    }
  }, [q, degree, location, status, college, category])

  useEffect(() => { void load() }, [load])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (j: JobPosting) => {
    setEditingId(j.id)
    setForm(toForm(j))
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!form.company.trim() || !form.position.trim()) {
      setError('单位名称与招聘岗位必填')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (editingId) {
        await serverApi.updateJob(editingId, formToPayload(form))
      } else {
        await serverApi.createJob(formToPayload(form) as unknown as Omit<JobPosting, 'id' | 'createdAt' | 'updatedAt'>)
      }
      setFormOpen(false)
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (j: JobPosting) => {
    if (!confirm('确定删除「' + j.company + ' ' + j.position + '」?')) return
    try {
      await serverApi.deleteJob(j.id)
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const toggleStatus = async (j: JobPosting) => {
    try {
      await serverApi.updateJob(j.id, { status: j.status === 'active' ? 'expired' : 'active' })
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态切换失败')
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    setError('')
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const sheetName = wb.SheetNames[0]
      if (!sheetName) throw new Error('Excel 文件为空')
      const ws = wb.Sheets[sheetName]
      if (!ws) throw new Error('无法读取工作表')
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]
      const header = (rows[0] ?? []) as string[]
      const colIndex: Record<string, number> = {}
      for (const col of JOB_COLUMNS) {
        const idx = header.findIndex((h) => {
          const t = String(h ?? '').trim().toLowerCase()
          return t === col.label.toLowerCase() || (col.aliases ?? []).some((a) => t === a.toLowerCase())
        })
        if (idx >= 0) colIndex[col.key] = idx
      }
      const companyIdx = colIndex['company']
      const positionIdx = colIndex['position']
      if (companyIdx === undefined || positionIdx === undefined) {
        throw new Error('表头需包含「单位名称」与「招聘岗位」列')
      }
      const entries: JobPosting[] = rows.slice(1)
        .filter((row) => row[companyIdx] && String(row[companyIdx]).trim())
        .map((row) => {
          const cell = (key: string) => {
            const idx = colIndex[key]
            return idx === undefined ? '' : String(row[idx] ?? '').trim()
          }
          return {
            id: '',
            company: cell('company'),
            position: cell('position'),
            major: cell('major') || undefined,
            degree: cell('degree') || undefined,
            location: cell('location') || undefined,
            headcount: cell('headcount') || undefined,
            salary: cell('salary') || undefined,
            applyStart: cell('applyStart') || undefined,
            deadline: cell('deadline') || undefined,
            url: cell('url') || undefined,
            contact: cell('contact') || undefined,
            source: cell('source') || 'Excel 导入',
            publishedAt: cell('publishedAt') || undefined,
            status: cell('statusLabel') === '已失效' ? 'expired' as const : 'active' as const,
            createdAt: '', updatedAt: '',
          }
        })
      const result = await serverApi.bulkJobs(entries)
      setError('导入完成:新增 ' + result.added + ' 条,跳过重复 ' + (entries.length - result.added) + ' 条')
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleExport = () => {
    if (jobs.length === 0) {
      alert('当前筛选结果为空,无可导出数据')
      return
    }
    const rows = jobs.map((j) => {
      const row: Record<string, string> = {}
      for (const col of JOB_COLUMNS) {
        row[col.label] = col.key === 'statusLabel'
          ? STATUS_LABEL[j.status]
          : String(j[col.key] ?? '')
      }
      return row
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '招聘信息')
    XLSX.writeFile(wb, '就业信息-' + new Date().toISOString().slice(0, 10) + '.xlsx')
  }

  const handleBrief = () => {
    if (jobs.length === 0) {
      alert('当前筛选结果为空')
      return
    }
    setBrief(buildBrief(jobs))
    setBriefOpen(true)
  }

  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(brief)
      alert('简报已复制到剪贴板')
    } catch {
      alert('复制失败,请手动选择文本复制')
    }
  }

  const field = (label: string, key: keyof JobForm, placeholder: string, wide = false) => (
    <label className={'block ' + (wide ? 'col-span-2' : '')}>
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
      />
    </label>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">💼 就业指导</h1>
        <p className="mt-1 text-xs text-slate-500">
          招聘信息采集与分类管理{isAdmin ? ';管理员可新增/编辑/导入/失效标记' : '(只读)'},支持按专业、学历、地点筛选与 Excel 导出
        </p>
      </div>

      <div className="flex items-center gap-2 border-b border-slate-200 px-6 py-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索单位 / 岗位 / 专业..."
          className="w-56 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-blue-500"
        />
        <select value={degree} onChange={(e) => setDegree(e.target.value)} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800">
          <option value="">学历:全部</option>
          {DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="地点"
          className="w-24 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-blue-500"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800">
          <option value="">状态:全部</option>
          <option value="active">在招</option>
          <option value="expired">已失效</option>
        </select>
        <select value={college} onChange={(e) => setCollege(e.target.value)} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800">
          <option value="">面向学院:全部</option>
          {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800">
          <option value="">岗位分类:全部</option>
          {JOB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <div className="ml-auto flex gap-2">
          {isAdmin && (
            <>
              <button onClick={openCreate} className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500">
                + 新增岗位
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={importing}
                className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {importing ? '导入中...' : '⬆ 导入 Excel'}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={(e) => void handleImport(e)} className="hidden" />
            </>
          )}
          <button onClick={handleExport} className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            ⬇ 导出 Excel
          </button>
          <button onClick={handleBrief} className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            📄 生成简报
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="text-sm text-slate-500">加载中...</p>
        ) : jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-500">
            暂无岗位信息{isAdmin ? ',点击「+ 新增岗位」或「导入 Excel」添加' : ',请等待管理员导入'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5 font-medium">单位 / 岗位</th>
                  <th className="px-4 py-2.5 font-medium">专业</th>
                  <th className="px-4 py-2.5 font-medium">学历</th>
                  <th className="px-4 py-2.5 font-medium">地点</th>
                  <th className="px-4 py-2.5 font-medium">薪资</th>
                  <th className="px-4 py-2.5 font-medium">截止</th>
                  <th className="px-4 py-2.5 font-medium">来源</th>
                  <th className="px-4 py-2.5 font-medium">岗位分类</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  {isAdmin && <th className="px-4 py-2.5 font-medium text-right">操作</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((j) => (
                  <tr key={j.id} className="text-slate-600 hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-slate-800">{j.company}</p>
                      <p className="text-xs text-slate-500">
                        {j.position}
                        {j.college ? ' · 面向 ' + j.college : ''}
                        {j.url ? ' · 公告' : ''}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-xs">{j.major || '-'}</td>
                    <td className="px-4 py-2.5 text-xs">{j.degree || '-'}</td>
                    <td className="px-4 py-2.5 text-xs">{j.location || '-'}</td>
                    <td className="px-4 py-2.5 text-xs">{j.salary || '-'}</td>
                    <td className={'px-4 py-2.5 text-xs ' + (j.deadline ? '' : 'text-slate-400')}>{j.deadline || '-'}</td>
                    <td className="px-4 py-2.5 text-xs">{j.source}</td>
                    <td className="px-4 py-2.5">
                      {j.category ? (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">{j.category}</span>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={'rounded-full px-2 py-0.5 text-xs ' + statusCell(j)}>
                        {STATUS_LABEL[j.status]}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-2.5 text-right text-xs">
                        <button onClick={() => void toggleStatus(j)} className="text-slate-500 hover:text-blue-600" title="切换生效状态">
                          {j.status === 'active' ? '标失效' : '恢复'}
                        </button>
                        <button onClick={() => openEdit(j)} className="ml-3 text-slate-500 hover:text-blue-600">编辑</button>
                        <button onClick={() => void handleDelete(j)} className="ml-3 text-slate-500 hover:text-red-500">删除</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-slate-100 bg-white px-4 py-2 text-xs text-slate-500">
              共 {jobs.length} 条(截图时请按当前筛选条件核对)
            </div>
          </div>
        )}
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setFormOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-base font-semibold text-slate-900">
              {editingId ? '编辑岗位' : '新增岗位'}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {field('单位名称 *', 'company', '如:腾讯、湖北省教育厅')}
              {field('招聘岗位 *', 'position', '如:算法工程师、教师(编制)')}
              {field('招聘专业', 'major', '如:计算机、不限')}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">学历要求</span>
                <select
                  value={form.degree}
                  onChange={(e) => setForm({ ...form, degree: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  {DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              {field('工作地点', 'location', '如:武汉')}
              {field('招聘人数', 'headcount', '如:10 人')}
              {field('薪资待遇', 'salary', '如:15-25k·14薪')}
              {field('报名时间', 'applyStart', '如:2026-09-01')}
              {field('截止时间', 'deadline', '如:2026-10-31')}
              {field('招聘公告链接', 'url', 'https://...')}
              {field('联系方式', 'contact', '邮箱 / 电话')}
              {field('信息来源', 'source', '如:企业官网、高校就业平台')}
              {field('发布时间', 'publishedAt', '如:2026-09-01')}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">面向学院(可选)</span>
                <select
                  value={form.college}
                  onChange={(e) => setForm({ ...form, college: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="">不限学院</option>
                  {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              {field('备注', 'notes', '岗位说明、待遇细节等', true)}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setFormOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                取消
              </button>
              <button onClick={() => void handleSave()} disabled={saving} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {briefOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setBriefOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-base font-semibold text-slate-900">就业信息简报(当前筛选结果)</h3>
            <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-700">{brief}</pre>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  const blob = new Blob([brief], { type: 'text/markdown;charset=utf-8' })
                  const a = document.createElement('a')
                  a.href = URL.createObjectURL(blob)
                  a.download = '就业信息简报-' + new Date().toISOString().slice(0, 10) + '.md'
                  a.click()
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                ⬇ 下载 .md
              </button>
              <button onClick={() => void copyBrief()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
                复制
              </button>
              <button onClick={() => setBriefOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
