import { useState, useRef, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { serverApi, type KbDocumentMeta } from '../lib/api/server'
import { extractTextFromFile } from '../lib/pdf'
import { useAuthStore } from '../stores/auth-store'
import { DEPARTMENTS } from '../lib/departments'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 文件知识库:问答 + 文件管理 + 制度审查。
 * 上传/删除/审查仅 admin;校级可问答全部,院级仅全校+本院文件(服务端过滤)。
 */
export function KnowledgePage() {
  const auth = useAuthStore()
  const isAdmin = auth.user?.role === 'admin'
  const [tab, setTab] = useState<'ask' | 'files' | 'review'>('ask')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">📚 文件知识库</h1>
        <div className="ml-6 flex gap-1">
          <button
            onClick={() => setTab('ask')}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'ask' ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:text-slate-600'
            }`}
          >
            智能问答
          </button>
          <button
            onClick={() => setTab('files')}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'files' ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:text-slate-600'
            }`}
          >
            文件库
          </button>
          {isAdmin && (
            <button
              onClick={() => setTab('review')}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                tab === 'review' ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:text-slate-600'
              }`}
            >
              制度审查
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'ask' ? <AskTab /> : tab === 'files' ? <FilesTab isAdmin={isAdmin} /> : <ReviewTab />}
      </div>
    </div>
  )
}

// ── 问答 ──
function AskTab() {
  const [question, setQuestion] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ answer: string; sources: Array<{ filename: string; college: string | null; scope: 'school' | 'college'; chunks: number }>; threadId: string } | null>(null)

  const handleAsk = async () => {
    const q = question.trim()
    if (!q || running) return
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const res = await serverApi.kbAsk(q)
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '问答失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="mb-2 block text-sm font-medium text-slate-600">
          向已导入的文件提问
        </label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleAsk()
          }}
          placeholder="例如:差旅费报销需要提供哪些材料?审批流程是怎样的?"
          rows={3}
          className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none transition-colors"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-slate-500">仅依据已导入文件作答,并标注出处(⌘/Ctrl+Enter 发送)</p>
          <button
            onClick={() => void handleAsk()}
            disabled={running || !question.trim()}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {running ? '问答中...' : '提问'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {running && (
        <div className="mt-6 flex items-center gap-3 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-blue-500" />
          正在检索文件并生成回答(通常 1-2 分钟)...
        </div>
      )}

      {result && !running && (
        <div className="mt-6 space-y-4">
          <div className="prose-stream rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown>
          </div>
          {result.sources.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="mb-2 text-xs font-medium text-slate-500">依据文件</p>
              <ul className="space-y-1">
                {result.sources.map((s, i) => (
                  <li key={i} className="text-xs text-slate-500">
                    «{s.filename}»{s.college ? ` · ${s.college}` : ' · 全校'}
                    <span className="ml-1 text-slate-500">({s.chunks} 段)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 文件库 ──
function FilesTab({ isAdmin }: { isAdmin: boolean }) {
  const [docs, setDocs] = useState<KbDocumentMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [scope, setScope] = useState<'school' | 'college'>('school')
  const [college, setCollege] = useState<string>(String(DEPARTMENTS[0]))

  // 扫描版 PDF OCR 流程
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrText, setOcrText] = useState('')
  const [ocrName, setOcrName] = useState('')
  const ocrFileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setDocs(await serverApi.listKbDocuments())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载文件列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    setBusy(true)
    setError('')
    setMsg('')
    let okCount = 0
    const errors: string[] = []
    for (const file of files) {
      try {
        const text = await extractTextFromFile(file)
        await serverApi.createKbDocument({
          filename: file.name,
          scope,
          college: scope === 'college' ? college : undefined,
          text,
        })
        okCount += 1
      } catch (err) {
        errors.push(file.name + ':' + (err instanceof Error ? err.message : '失败'))
      }
    }
    if (okCount > 0) setMsg('批量上传完成:成功 ' + okCount + ' 个' + (errors.length > 0 ? ',失败 ' + errors.length + ' 个' : ''))
    if (errors.length > 0) setError(errors.join('; '))
    await load()
    setBusy(false)
  }

  const handleOcrPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setOcrBusy(true)
    setError('')
    setOcrText('')
    setOcrName('')
    try {
      const dataBase64 = await fileToBase64(file)
      const result = await serverApi.ocrKb(dataBase64, file.name)
      setOcrText(result.text)
      setOcrName(file.name.replace(/\.pdf$/i, ''))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OCR 失败')
    } finally {
      setOcrBusy(false)
    }
  }

  const uploadOcrText = async () => {
    if (!ocrText.trim()) return
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await serverApi.createKbDocument({
        filename: 'OCR-' + (ocrName || '扫描件') + '.txt',
        scope,
        college: scope === 'college' ? college : undefined,
        text: ocrText,
      })
      setOcrText('')
      setOcrName('')
      setMsg('OCR 文本已入库')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string, filename: string) => {
    if (!confirm(`确定删除文件 ${filename}?问答将不再引用它。`)) return
    try {
      await serverApi.deleteKbDocument(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleDownload = async (d: KbDocumentMeta) => {
    try {
      const doc = await serverApi.getKbDocument(d.id)
      const blob = new Blob([doc.content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = d.filename.replace(/\.pdf$/i, '') + '.txt'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败')
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-400">{error}</div>
      )}
      {msg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{msg}</div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-slate-600">上传文件(文本 / PDF)</h3>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
              {(['school', 'college'] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    scope === s ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'
                  }`}>
                  {s === 'school' ? '全校文件' : '学院文件'}
                </button>
              ))}
            </div>
            {scope === 'college' && (
              <select value={college} onChange={(e) => setCollege(e.target.value)}
                className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:border-blue-500 focus:outline-none">
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            <input ref={fileRef} type="file" accept=".pdf,.txt,.md" multiple onChange={(e) => void handleUpload(e)} className="hidden" />
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
              {busy ? '解析上传中...' : '⬆ 批量选择文件'}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            支持 .pdf(文本型,抽取带页码标记)/.txt/.md,可一次选择多个;扫描版 PDF 无文字层,请用下方 OCR 识别后入库。
          </p>

          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="mb-2 text-xs text-slate-500">🖨 扫描版 PDF OCR(服务端 tesseract 识别,需 poppler-utils + tesseract-ocr + chi_sim)</p>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={ocrFileRef} type="file" accept=".pdf" onChange={(e) => void handleOcrPick(e)} className="hidden" />
              <button onClick={() => ocrFileRef.current?.click()} disabled={ocrBusy}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors">
                {ocrBusy ? 'OCR 识别中(逐页,较慢)...' : '选择扫描版 PDF'}
              </button>
              {ocrText && <span className="text-xs text-emerald-600">已识别,确认无误后上传入库</span>}
            </div>
            {ocrText && (
              <div className="mt-2 space-y-2">
                <textarea
                  value={ocrText}
                  onChange={(e) => setOcrText(e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700 outline-none focus:border-blue-500 transition-colors"
                />
                <button onClick={() => void uploadOcrText()} disabled={busy}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">
                  {busy ? '上传中...' : '上传为 OCR-… .txt'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <div className="border-b border-slate-100 bg-white px-4 py-2.5 text-xs text-slate-500">
          {loading ? '加载中...' : `共 ${docs.length} 个文件`}
        </div>
        {!loading && docs.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            还没有导入任何文件
            {isAdmin ? ',上传后即可问答' : ',请等待管理员导入'}
          </div>
        )}
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {docs.map((d) => (
              <tr key={d.id} className="text-slate-500 hover:bg-slate-100">
                <td className="px-4 py-2.5">
                  <p className="text-slate-800 font-medium">{d.filename}</p>
                  <p className="text-xs text-slate-500">
                    {d.scope === 'school' ? '全校' : d.college} · 上传者 {d.uploadedBy} ·{' '}
                    {new Date(d.uploadedAt).toLocaleString('zh-CN')} · {d.charCount} 字 · {d.chunkCount} 段
                  </p>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => void handleDownload(d)}
                    className="mr-3 text-xs text-slate-500 hover:text-blue-500 transition-colors">
                    下载
                  </button>
                  {isAdmin && (
                    <button onClick={() => void handleDelete(d.id, d.filename)}
                      className="text-xs text-slate-500 hover:text-red-400 transition-colors">
                      删除
                    </button>
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

// ── 制度审查 ──
function ReviewTab() {
  const [scope, setScope] = useState<'all' | 'school' | 'college'>('all')
  const [college, setCollege] = useState<string>(String(DEPARTMENTS[0]))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ answer: string; docCount: number; docs: Array<{ filename: string; scope: string; college?: string }> } | null>(null)

  const handleReview = async () => {
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const res = await serverApi.reviewKb(scope === 'all' ? undefined : scope, scope === 'college' ? college : undefined)
      setResult({ answer: res.answer, docCount: res.docCount, docs: res.docs })
    } catch (err) {
      setError(err instanceof Error ? err.message : '审查失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-medium text-slate-600">制度合规审查</h3>
        <p className="mb-3 text-xs text-slate-500">
          对知识库中的制度/管理办法逐项检查:格式规范、条款完整性、表述歧义、前后矛盾、制度间冲突、上位一致性、废止时效、责任与流程、关键字段;输出
          Markdown 审查报告与整改优先级(需 CodeWhale Runtime 在线)。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
            {([['all', '全部文件'], ['school', '仅全校'], ['college', '仅学院']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setScope(v)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  scope === v ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {scope === 'college' && (
            <select
              value={college}
              onChange={(e) => setCollege(e.target.value)}
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
            >
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <button
            onClick={() => void handleReview()}
            disabled={running}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {running ? '审查中(可能需数分钟)...' : '开始审查'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      {result && !running && (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            本次审查覆盖 {result.docCount} 个文件:{result.docs.map((d) => d.filename).join('、')}
          </p>
          <div className="prose-stream rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
