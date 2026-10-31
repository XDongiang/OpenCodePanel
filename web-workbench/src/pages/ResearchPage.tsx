import { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as XLSX from 'xlsx'
import type { FundProject, LiteratureHit, PaperRecord, PushPeriod, PushSubscription } from '../types'
import { serverApi, type PushLogEntry } from '../lib/api/server'
import { useAuthStore } from '../stores/auth-store'

/**
 * 科研助理(对齐《华师智能 ai 盒子》模块三):
 * - 文献检索:字段条件检索(关键词/作者/期刊/年份/学科分类)→ Crossref + Semantic Scholar
 * - 文献收藏:检索结果一键收藏,DOI/标题去重
 * - 基金辅助:基金项目库(Excel 导入)+ AI 分析(研究热点/选题/标书/学科代码建议)
 * - 论文推送:订阅(关键词/期刊/周期/邮箱)+ 一键生成推送简报
 */

const FIELDS = ['', '教育学', '管理学', '经济学', '法学', '社会学', '新闻传播学', '马克思主义理论', '公共管理', '计算机', '物理', '化学', '生命科学', '数学', '其他']
const PERIOD_LABEL: Record<PushPeriod, string> = { daily: '每日', weekly: '每周', monthly: '每月' }

const LOG_STATUS_BADGE: Record<PushLogEntry['status'], { cls: string; label: string }> = {
  sent: { cls: 'bg-emerald-50 text-emerald-600', label: '已发送' },
  generated: { cls: 'bg-slate-100 text-slate-500', label: '已生成' },
  failed: { cls: 'bg-red-50 text-red-500', label: '失败' },
}
const FUND_CATEGORIES = ['面上项目', '青年项目', '重点项目', '重大项目', '杰出青年基金', '优秀青年基金', '地区项目', '其他']
const QUICK_ANALYZE = [
  '请分析这些项目的年度分布与资助趋势',
  '请归纳当前的研究热点方向',
  '请给出一个推荐选题方向及理由',
  '请给出申请书的常见结构与写作要点',
  '请根据数据建议关键词与学科代码',
  '请给出本项目常见的技术路线设计参考',
  '请基于库内已结题项目归纳结题报告要点与分析',
]

export function ResearchPage() {
  const [tab, setTab] = useState<'lit' | 'fund' | 'push'>('lit')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">🔬 科研助理</h1>
        <div className="ml-6 flex gap-1">
          <button
            onClick={() => setTab('lit')}
            className={'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ' + (tab === 'lit' ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:text-slate-600')}
          >
            文献检索
          </button>
          <button
            onClick={() => setTab('fund')}
            className={'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ' + (tab === 'fund' ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:text-slate-600')}
          >
            基金辅助
          </button>
          <button
            onClick={() => setTab('push')}
            className={'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ' + (tab === 'push' ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:text-slate-600')}
          >
            论文推送
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'lit' && <LiteratureTab />}
        {tab === 'fund' && <FundTab />}
        {tab === 'push' && <PushTab />}
      </div>
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sm max-w-none text-sm leading-relaxed text-slate-700">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

// ── Tab 1: 文献检索 + 收藏 ──
function LiteratureTab() {
  const [q, setQ] = useState('')
  const [author, setAuthor] = useState('')
  const [journal, setJournal] = useState('')
  const [fromYear, setFromYear] = useState('')
  const [toYear, setToYear] = useState('')
  const [field, setField] = useState('')
  const [docType, setDocType] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<LiteratureHit[]>([])
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [summary, setSummary] = useState('')

  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [paperFilter, setPaperFilter] = useState('')

  const loadPapers = useCallback(async () => {
    try {
      const list = await serverApi.listPapers({ q: paperFilter || undefined })
      setPapers(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载收藏失败')
    }
  }, [paperFilter])

  useEffect(() => { void loadPapers() }, [loadPapers])

  const handleSearch = async () => {
    if (!q.trim()) { setError('请输入检索关键词'); return }
    setSearching(true)
    setError('')
    setMsg('')
    try {
      const result = await serverApi.researchSearch({
        q: q.trim(),
        author: author.trim() || undefined,
        journal: journal.trim() || undefined,
        fromYear: fromYear.trim() || undefined,
        toYear: toYear.trim() || undefined,
        type: (docType || undefined) as 'journal' | 'conference' | 'thesis' | 'review' | undefined,
        maxResults: 20,
      })
      setHits(result.hits)
      if (result.count === 0) setMsg('未检索到文献,可尝试更换关键词或放宽年份/期刊条件')
      else setMsg('检索到 ' + result.count + ' 条(多源去重后)')
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败')
    } finally {
      setSearching(false)
    }
  }

  const handleSave = async (h: LiteratureHit) => {
    try {
      await serverApi.savePaper({
        title: h.title,
        authors: h.authors ?? [],
        year: h.year,
        journal: h.journal,
        doi: h.doi,
        url: h.url,
        abstract: h.abstract,
        type: h.type,
        field: field || undefined,
        source: h.source,
      })
      setMsg('已收藏:「' + h.title.slice(0, 24) + (h.title.length > 24 ? '…' : '') + '」')
      void loadPapers()
    } catch (err) {
      setError(err instanceof Error ? err.message : '收藏失败')
    }
  }

  const handleDeletePaper = async (p: PaperRecord) => {
    try {
      await serverApi.deletePaper(p.id)
      void loadPapers()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const inputCls = 'rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500'

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="mb-2 block text-sm font-medium text-slate-600">文献检索(Crossref + Semantic Scholar 开放数据)</label>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键词 *" className={inputCls} />
          <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="作者 / 机构" className={inputCls} />
          <input value={journal} onChange={(e) => setJournal(e.target.value)} placeholder="目标期刊" className={inputCls} />
          <select value={field} onChange={(e) => setField(e.target.value)} className={inputCls}>
            {FIELDS.map((f) => <option key={f || 'all'} value={f}>{f || '学科分类:全部'}</option>)}
          </select>
          <input value={fromYear} onChange={(e) => setFromYear(e.target.value.replace(/[^0-9]/g, ''))} placeholder="起始年份" className={inputCls} />
          <input value={toYear} onChange={(e) => setToYear(e.target.value.replace(/[^0-9]/g, ''))} placeholder="结束年份" className={inputCls} />
          <select value={docType} onChange={(e) => setDocType(e.target.value)} className={inputCls}>
            <option value="">文献类型:全部</option>
            <option value="journal">期刊论文</option>
            <option value="conference">会议论文</option>
            <option value="thesis">学位论文</option>
            <option value="review">综述</option>
          </select>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-slate-400">知网需账号授权,由人工/合规流程对接;此处走开放学术接口</p>
          <button
            onClick={() => void handleSearch()}
            disabled={searching}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {searching ? '检索中...' : '检 索'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-400">{error}</div>}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</div>}

      {summary && (
        <div className="overflow-hidden rounded-xl border border-blue-200 bg-blue-50/50">
          <div className="flex items-center justify-between border-b border-blue-100 px-4 py-2">
            <span className="text-xs font-medium text-blue-600">研究背景与国内外现状综述(基于当前检索结果)</span>
            <button onClick={() => setSummary('')} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
          </div>
          <div className="prose prose-sm max-w-none px-4 py-3 text-sm leading-6 text-slate-700">
            {summary.split('\n').map((line, i) => (
              <p key={i} className={'mb-1 ' + (line.startsWith('#') ? 'font-semibold text-slate-900' : '')}>{line}</p>
            ))}
          </div>
        </div>
      )}

      {hits.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
            <span className="text-xs font-medium text-slate-500">检索结果({hits.length})</span>
            {q.trim() && (
              <button
                onClick={async () => {
                  if (summarizing) return
                  setSummarizing(true)
                  setSummary('')
                  setError('')
                  try {
                    const result = await serverApi.summarizeLiterature({ question: q.trim(), hits })
                    setSummary(result.answer)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : '综述生成失败')
                  } finally {
                    setSummarizing(false)
                  }
                }}
                disabled={summarizing}
                className={'shrink-0 rounded-lg px-3 py-1 text-xs font-medium ' + (summarizing ? 'bg-slate-100 text-slate-400' : 'bg-blue-50 text-blue-600 hover:bg-blue-100')}
              >
                {summarizing ? '生成中…' : '✦ 生成研究现状综述'}
              </button>
            )}
          </div>
          <ul className="divide-y divide-slate-100">
            {hits.map((h, i) => (
              <li key={i} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{h.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {(h.authors ?? []).slice(0, 4).join(', ') || '作者未收录'}
                    {h.journal ? ' · ' + h.journal : ''}
                    {h.year ? ' (' + h.year + ')' : ''}
                    {' · 来源:' + (h.source === 'crossref' ? 'Crossref' : 'Semantic Scholar')}
                  </p>
                  {h.abstract && (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">{h.abstract}</p>
                  )}
                  {h.doi && <p className="mt-0.5 text-xs text-slate-400">DOI:{h.doi}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    onClick={() => void handleSave(h)}
                    className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100"
                  >
                    收藏
                  </button>
                  {h.url && (
                    <a href={h.url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">原文 ↗</a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
          <span className="text-xs font-medium text-slate-500">我的收藏({papers.length})</span>
          <input
            value={paperFilter}
            onChange={(e) => setPaperFilter(e.target.value)}
            placeholder="筛选收藏..."
            className="w-48 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-800 outline-none focus:border-blue-500"
          />
        </div>
        {papers.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">暂无收藏,在上方检索后点击「收藏」</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {papers.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{p.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {p.authors.slice(0, 4).join(', ') || '作者未收录'}
                    {p.journal ? ' · ' + p.journal : ''}
                    {p.year ? ' (' + p.year + ')' : ''}
                    {' · 收藏者:' + p.collectedBy}
                  </p>
                  {p.doi && <p className="mt-0.5 text-xs text-slate-400">DOI:{p.doi}</p>}
                </div>
                <button onClick={() => void handleDeletePaper(p)} className="shrink-0 text-xs text-slate-400 hover:text-red-500">删除</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Tab 2: 基金辅助 ──
interface FundForm {
  name: string
  leader: string
  institution: string
  code: string
  year: string
  number: string
  amount: string
  category: string
  status: string
}

const EMPTY_FUND: FundForm = { name: '', leader: '', institution: '', code: '', year: '', number: '', amount: '', category: '', status: '已立项' }

function FundTab() {
  const auth = useAuthStore()
  const isAdmin = auth.user?.role === 'admin'
  const [funds, setFunds] = useState<FundProject[]>([])
  const [fq, setFq] = useState('')
  const [fyear, setFyear] = useState('')
  const [fcat, setFcat] = useState('')
  const [fstatus, setFstatus] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FundForm>(EMPTY_FUND)
  const [saving, setSaving] = useState(false)

  const [question, setQuestion] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState('')

  const load = useCallback(async () => {
    try {
      const list = await serverApi.listFunds({ q: fq || undefined, year: fyear || undefined, category: fcat || undefined })
      setFunds(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载基金数据失败')
    }
  }, [fq, fyear, fcat])

  useEffect(() => { void load() }, [load])

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
      const idxOf = (names: string[]) => {
        const i = header.findIndex((h) => names.some((n) => String(h ?? '').trim().toLowerCase() === n.toLowerCase()))
        return i >= 0 ? i : undefined
      }
      const nameIdx = idxOf(['项目名称', '项目', '名称'])
      if (nameIdx === undefined) throw new Error('表头需包含「项目名称」列')
      const cell = (row: unknown[], idx: number | undefined) => (idx === undefined ? '' : String(row[idx] ?? '').trim())
      const entries: Array<Omit<FundProject, 'id' | 'createdAt' | 'updatedAt'>> = rows.slice(1)
        .filter((row) => row[nameIdx] && String(row[nameIdx]).trim())
        .map((row) => ({
          name: cell(row, nameIdx),
          leader: cell(row, idxOf(['负责人', '主持人'])) || undefined,
          institution: cell(row, idxOf(['依托单位', '单位'])) || undefined,
          code: cell(row, idxOf(['学科代码', '代码'])) || undefined,
          year: cell(row, idxOf(['批准年度', '年度', '年份'])) || undefined,
          number: cell(row, idxOf(['批准号', '项目编号'])) || undefined,
          amount: cell(row, idxOf(['经费', '金额'])) || undefined,
          category: cell(row, idxOf(['项目类别', '类别'])) || undefined,
          status: cell(row, idxOf(['状态'])) || undefined,
        }))
      const result = await serverApi.importFunds(entries)
      setMsg('导入完成:新增 ' + result.added + ' 条,跳过重复 ' + (entries.length - result.added) + ' 条')
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FUND)
    setFormOpen(true)
  }

  const openEdit = (f: FundProject) => {
    setEditingId(f.id)
    setForm({
      name: f.name, leader: f.leader ?? '', institution: f.institution ?? '', code: f.code ?? '',
      year: f.year ?? '', number: f.number ?? '', amount: f.amount ?? '', category: f.category ?? '', status: f.status ?? '',
    })
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { setError('项目名称必填'); return }
    setSaving(true)
    setError('')
    try {
      const payload = { ...form, name: form.name.trim() }
      if (editingId) await serverApi.updateFund(editingId, payload)
      else await serverApi.createFund(payload)
      setFormOpen(false)
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (f: FundProject) => {
    if (!confirm('确定删除项目「' + f.name + '」?')) return
    try {
      await serverApi.deleteFund(f.id)
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleAnalyze = async (custom?: string) => {
    const qText = custom ?? question
    if (!qText.trim()) { setError('请输入分析问题'); return }
    setAnalyzing(true)
    setError('')
    setAnalysis('')
    try {
      const result = await serverApi.analyzeFunds(qText.trim())
      setAnalysis(result.answer)
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析失败(请确认 CodeWhale Runtime 已启动)')
    } finally {
      setAnalyzing(false)
    }
  }

  const fundField = (label: string, key: keyof FundForm, placeholder: string) => (
    <label className="block">
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
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* 基金库 */}
      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <span className="text-xs font-medium text-slate-500">国家自然科学基金项目库({funds.length})</span>
          <input value={fq} onChange={(e) => setFq(e.target.value)} placeholder="搜索名称/负责人/单位..." className="w-52 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs outline-none focus:border-blue-500" />
          <input value={fyear} onChange={(e) => setFyear(e.target.value.replace(/[^0-9]/g, ''))} placeholder="年度" className="w-20 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs outline-none focus:border-blue-500" />
          <select value={fcat} onChange={(e) => setFcat(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs outline-none focus:border-blue-500">
            <option value="">类别:全部</option>
            {FUND_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={fstatus} onChange={(e) => setFstatus(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs outline-none focus:border-blue-500">
            <option value="">状态:全部</option>
            <option value="已立项">已立项</option>
            <option value="已结题">已结题</option>
            <option value="在研">在研</option>
          </select>
          {isAdmin && (
            <div className="ml-auto flex gap-2">
              <button onClick={openCreate} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500">+ 新增项目</button>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={importing}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {importing ? '导入中...' : '⬆ 导入 Excel'}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={(e) => void handleImport(e)} className="hidden" />
            </div>
          )}
        </div>
        {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-400">{error}</div>}
        {msg && <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</div>}
        {funds.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            {isAdmin ? '还没有基金项目数据,' : '暂无项目数据,请等待管理员导入。'}可从 NSFC 公开结果整理为 Excel 上传(项目名称/负责人/依托单位/学科代码/批准年度/批准号/经费/项目类别/状态)
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-white text-left text-xs text-slate-500">
                  <th className="px-4 py-2 font-medium">项目名称</th>
                  <th className="px-4 py-2 font-medium">负责人</th>
                  <th className="px-4 py-2 font-medium">单位</th>
                  <th className="px-4 py-2 font-medium">学科代码</th>
                  <th className="px-4 py-2 font-medium">年度</th>
                  <th className="px-4 py-2 font-medium">类别</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  {isAdmin && <th className="px-4 py-2 font-medium text-right">操作</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {funds.map((f) => (
                  <tr key={f.id} className="text-slate-600 hover:bg-slate-50">
                    <td className="px-4 py-2 text-slate-800">
                      <p className="font-medium">{f.name}</p>
                      {f.number && <p className="text-xs text-slate-400">批准号:{f.number}</p>}
                    </td>
                    <td className="px-4 py-2 text-xs">{f.leader || '-'}</td>
                    <td className="px-4 py-2 text-xs">{f.institution || '-'}</td>
                    <td className="px-4 py-2 text-xs">{f.code || '-'}</td>
                    <td className="px-4 py-2 text-xs">{f.year || '-'}</td>
                    <td className="px-4 py-2 text-xs">{f.category || '-'}</td>
                    <td className="px-4 py-2 text-xs">{f.status || '-'}</td>
                    {isAdmin && (
                      <td className="px-4 py-2 text-right text-xs">
                        <button onClick={() => openEdit(f)} className="text-slate-500 hover:text-blue-600">编辑</button>
                        <button onClick={() => void handleDelete(f)} className="ml-3 text-slate-500 hover:text-red-500">删除</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI 分析 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">🤖 基金 AI 辅助分析</h3>
        <p className="mt-1 text-xs text-slate-500">
          基于上方基金库数据(共 {funds.length} 项)回答:研究热点 / 选题方向 / 标书结构 / 关键词与学科代码建议 / 资助趋势。需要 CodeWhale Runtime 在线。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_ANALYZE.map((t) => (
            <button
              key={t}
              onClick={() => void handleAnalyze(t)}
              disabled={analyzing}
              className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs text-blue-600 hover:bg-blue-100 disabled:opacity-50"
            >
              {t}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="或输入自定义问题,如:教育学方向过去三年的资助重点是什么?"
            className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
          />
          <button
            onClick={() => void handleAnalyze()}
            disabled={analyzing}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {analyzing ? '分析中...' : '分 析'}
          </button>
        </div>
        {analysis && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <Markdown text={analysis} />
          </div>
        )}
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setFormOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-base font-semibold text-slate-900">{editingId ? '编辑项目' : '新增基金项目'}</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">{fundField('项目名称 *', 'name', '如:面向多模态数据的认知计算研究')}</div>
              {fundField('负责人', 'leader', '如:张三')}
              {fundField('依托单位', 'institution', '如:华中师范大学')}
              {fundField('学科代码', 'code', '如:F06')}
              {fundField('批准年度', 'year', '如:2025')}
              {fundField('批准号', 'number', '如:62570001')}
              {fundField('经费(万)', 'amount', '如:50')}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">项目类别</span>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="">未分类</option>
                  {FUND_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">状态</span>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="已立项">已立项</option>
                  <option value="已结题">已结题</option>
                </select>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setFormOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">取消</button>
              <button onClick={() => void handleSave()} disabled={saving} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab 3: 论文推送 ──
function PushTab() {
  const [subs, setSubs] = useState<PushSubscription[]>([])
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [journal, setJournal] = useState('')
  const [period, setPeriod] = useState<PushPeriod>('weekly')
  const [email, setEmail] = useState('')

  const [digest, setDigest] = useState('')
  const [digestOpen, setDigestOpen] = useState(false)
  const [digestName, setDigestName] = useState('')
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [logs, setLogs] = useState<PushLogEntry[]>([])

  const load = useCallback(async () => {
    try {
      setSubs(await serverApi.listSubscriptions())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载订阅失败')
    }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      setLogs(await serverApi.listPushLogs())
    } catch {
      // 日志为辅助信息,加载失败不阻塞页面
    }
  }, [])

  useEffect(() => { void loadLogs() }, [loadLogs])

  useEffect(() => { void load() }, [load])

  const handleCreate = async () => {
    if (!name.trim() || !keywords.trim()) { setError('订阅名称与关键词必填'); return }
    try {
      await serverApi.createSubscription({
        name: name.trim(),
        keywords: keywords.split(/[,，;；]/).map((k) => k.trim()).filter(Boolean),
        journal: journal.trim() || undefined,
        period,
        email: email.trim() || undefined,
        enabled: true,
      })
      setFormOpen(false)
      setName(''); setKeywords(''); setJournal(''); setEmail(''); setPeriod('weekly')
      setMsg('订阅已创建')
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    }
  }

  const handleToggle = async (s: PushSubscription) => {
    try {
      await serverApi.updateSubscription(s.id, { enabled: !s.enabled })
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
    }
  }

  const handleDelete = async (s: PushSubscription) => {
    if (!confirm('确定删除订阅「' + s.name + '」?')) return
    try {
      await serverApi.deleteSubscription(s.id)
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleGenerate = async (s: PushSubscription) => {
    setGeneratingId(s.id)
    setError('')
    try {
      const result = await serverApi.researchPush(s.id)
      setDigest(result.digest)
      setDigestName('论文推送:' + result.subscription.name)
      setDigestOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setGeneratingId(null)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">论文 / 综述定期推送</h3>
          <p className="mt-1 text-xs text-slate-500">设置研究方向、关键词、期刊与周期,一键生成最新论文推送简报(每日/每周/每月);定时调度将在后续版本接入</p>
        </div>
        <button onClick={() => setFormOpen(true)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">+ 新建订阅</button>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-400">{error}</div>}
      {msg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{msg}</div>}

      {subs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-14 text-center text-sm text-slate-500">
          还没有推送订阅,点击「+ 新建订阅」创建(例如:关键词「大语言模型 教育」,期刊「Nature」,每周)
        </div>
      ) : (
        <div className="space-y-3">
          {subs.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {s.name}
                  <span className={'ml-2 rounded-full px-2 py-0.5 text-xs ' + (s.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500')}>
                    {s.enabled ? '启用' : '停用'}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  关键词:{s.keywords.join(' / ')}
                  {s.journal ? ' · 期刊:' + s.journal : ''}
                  {' · 周期:' + PERIOD_LABEL[s.period]}
                  {s.email ? ' · 邮箱:' + s.email : ''}
                  {' · 创建者:' + s.createdBy}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <button
                  onClick={() => void handleGenerate(s)}
                  disabled={generatingId === s.id}
                  className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 font-medium text-blue-600 hover:bg-blue-100 disabled:opacity-50"
                >
                  {generatingId === s.id ? '生成中...' : '📄 生成简报'}
                </button>
                <button onClick={() => void handleToggle(s)} className="text-slate-500 hover:text-blue-600">{s.enabled ? '停用' : '启用'}</button>
                <button onClick={() => void handleDelete(s)} className="text-slate-500 hover:text-red-500">删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 定时推送记录 */}
      {logs.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
            <span className="text-xs font-medium text-slate-500">推送记录(定时调度/手动)最近 {logs.length} 条</span>
            <button
              onClick={() => {
                const rows = logs.map((log) => ({
                  订阅名称: log.name,
                  周期: PERIOD_LABEL[log.period],
                  邮箱: log.email ?? '',
                  生成时间: new Date(log.generatedAt).toLocaleString('zh-CN'),
                  文献数: log.count,
                  状态: LOG_STATUS_BADGE[log.status].label,
                  说明: log.error ?? '',
                  摘要: log.digest,
                }))
                const ws = XLSX.utils.json_to_sheet(rows)
                const wb = XLSX.utils.book_new()
                XLSX.utils.book_append_sheet(wb, ws, '推送记录')
                XLSX.writeFile(wb, '论文推送记录-' + new Date().toISOString().slice(0, 10) + '.xlsx')
              }}
              className="shrink-0 text-xs text-blue-500 hover:underline"
            >
              导出 Excel
            </button>
          </div>
          <ul className="divide-y divide-slate-100">
            {logs.slice(0, 10).map((log) => (
              <li key={log.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-slate-700">
                    {log.name}
                    <span className={'ml-2 rounded-full px-2 py-0.5 text-xs ' + LOG_STATUS_BADGE[log.status].cls}>
                      {LOG_STATUS_BADGE[log.status].label}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {PERIOD_LABEL[log.period] + ' · ' + new Date(log.generatedAt).toLocaleString('zh-CN') + ' · ' + log.count + ' 条'}
                    {log.email ? ' · ' + log.email : ''}
                    {log.error ? ' · ' + log.error : ''}
                  </p>
                </div>
                <button
                  onClick={() => { setDigest(log.digest); setDigestName(log.name); setDigestOpen(true) }}
                  className="shrink-0 text-xs text-blue-500 hover:underline"
                >
                  查看
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {formOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setFormOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-base font-semibold text-slate-900">新建推送订阅</h3>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">订阅名称 *</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如:AI 教育应用" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">关键词 *</span>
                <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="逗号分隔,如:大语言模型, 教育评价" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">目标期刊(可选)</span>
                  <input value={journal} onChange={(e) => setJournal(e.target.value)} placeholder="如:Nature" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">推送周期</span>
                  <select value={period} onChange={(e) => setPeriod(e.target.value as PushPeriod)} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500">
                    <option value="daily">每日</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">接收邮箱(可选)</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="用于后续定时邮件推送" className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setFormOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">取消</button>
              <button onClick={() => void handleCreate()} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500">创建</button>
            </div>
          </div>
        </div>
      )}

      {digestOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setDigestOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-base font-semibold text-slate-900">{digestName}</h3>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <Markdown text={digest} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  const blob = new Blob([digest], { type: 'text/markdown;charset=utf-8' })
                  const a = document.createElement('a')
                  a.href = URL.createObjectURL(blob)
                  a.download = (digestName || '论文推送') + '.md'
                  a.click()
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                ⬇ 下载
              </button>
              <button onClick={() => setDigestOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
