import type { Storage } from './storage.js'
import type { UserRole } from './users.js'

/**
 * 文件知识库:BM25 检索 + 智能问答(RAG-lite)。
 *
 * - 切块:按段落/句号切分,块上限 700 字、重叠 80 字
 * - 分词:CJK 连续中文按二元组(bigram),拉丁词/数字按整词
 * - 检索:BM25(k1=1.5, b=0.75),按块打分,返回 Top-K 块并带上文件出处
 * - 持久化:kb.json 单个文档 {filename,college,scope,chunks,meta}
 *   (v1 为 JSON 文件;知识库数据量增大后按 Storage 换装点迁移 SQLite+FTS)
 * - 可见性:scope=school 全校可见;scope=college 仅绑定学院与上级可见
 */

export type KbScope = 'school' | 'college'

export interface KbDocumentMeta {
  id: string
  filename: string
  college?: string
  scope: KbScope
  uploadedBy: string
  uploadedAt: string
  charCount: number
  chunkCount: number
}

interface StoredKbDoc extends KbDocumentMeta {
  chunks: string[]
}

interface KbDoc {
  version: number
  updatedAt: string
  entries: StoredKbDoc[]
}

export interface KbSearchHit {
  doc: KbDocumentMeta
  chunks: Array<{ idx: number; text: string }>
}

const KB_DOC = 'kb'
const SCHEMA_VERSION = 1

const CHUNK_MAX = 700
const CHUNK_OVERLAP = 80
const BM25_K1 = 1.5
const BM25_B = 0.75
const DEFAULT_TOP_K = 6

function genId(): string {
  return `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function now(): string {
  return new Date().toISOString()
}

/** 按句/段落切块:优先在句号/换行处断;单元超过上限时硬切;相邻块保留 overlap 重叠。 */
export function chunkText(text: string, maxLen = CHUNK_MAX, overlap = CHUNK_OVERLAP): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const chunks: string[] = []
  let buffer = ''

  const flush = () => {
    const t = buffer.trim()
    if (t) chunks.push(t)
    buffer = ''
  }

  // 断块后从上一块尾部带 overlap 字继续,避免句意断裂
  // 注意:slice(-0) === slice(0) 会取整块,这里显式取尾部;overlap 夹紧到 maxLen-1 防循环
  const effOverlap = Math.max(Math.min(overlap, maxLen - 1), 0)
  const carryOverlap = () => {
    const last = chunks[chunks.length - 1]
    buffer = last ? last.slice(Math.max(last.length - effOverlap, 0)) : ''
  }

  const pushUnit = (u: string) => {
    let rest = u
    while (rest.length > 0) {
      const room = maxLen - buffer.length
      if (room <= 0) {
        flush()
        carryOverlap()
        continue
      }
      const take = Math.min(room, rest.length)
      buffer += rest.slice(0, take)
      rest = rest.slice(take)
      if (buffer.length >= maxLen) {
        flush()
        if (rest.length > 0) carryOverlap()
      }
    }
  }

  for (const unit of normalized.split(/(?<=[。！？!?；;\n])/)) {
    const u = unit.trim()
    if (!u) continue
    if (buffer.length > 0 && buffer.length + u.length > maxLen) {
      flush()
      carryOverlap()
    }
    pushUnit(u)
  }
  flush()
  return chunks
}

/** 中文按连续 CJK 二元组 + 拉丁词/数字词。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
    tokens.push(m[0].toLowerCase())
  }
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2))
      }
      if (run.length === 1) tokens.push(run)
    }
  }
  return tokens
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/** BM25 打分:df 为包含该词的块数,N 为总块数,avgdl 为平均块长。 */
export function scoreBm25(
  docTokens: string[],
  queryTokens: string[],
  dfMap: Map<string, number>,
  totalDocs: number,
  avgDocLen: number
): number {
  const tf = termFrequency(docTokens)
  const dl = docTokens.length
  let score = 0
  const seen = new Set<string>()
  for (const q of queryTokens) {
    if (seen.has(q)) continue
    seen.add(q)
    const f = tf.get(q) ?? 0
    if (f === 0) continue
    const df = dfMap.get(q) ?? 0
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(avgDocLen, 1)))
    score += idf * ((f * (BM25_K1 + 1)) / denom)
  }
  return score
}

export interface KbScopeFilter {
  role: UserRole
  college?: string
}

export class KbService {
  constructor(private readonly storage: Storage) {}

  private read(): KbDoc {
    return this.storage.readDoc<KbDoc>(KB_DOC, {
      version: SCHEMA_VERSION,
      updatedAt: now(),
      entries: [],
    })
  }

  private save(entries: StoredKbDoc[]): void {
    this.storage.writeDoc(KB_DOC, { version: SCHEMA_VERSION, updatedAt: now(), entries })
  }

  private visible(scope?: KbScopeFilter): (doc: StoredKbDoc) => boolean {
    if (!scope || scope.role === 'admin' || scope.role === 'school') return () => true
    const college = scope.college ?? ''
    return (doc) => doc.scope === 'school' || (doc.scope === 'college' && doc.college === college)
  }

  /** 元数据列表(按角色过滤,不含全文)。 */
  listMeta(scope?: KbScopeFilter): KbDocumentMeta[] {
    const visible = this.visible(scope)
    return this.read().entries
      .filter(visible)
      .map(({ chunks: _chunks, ...meta }) => meta)
  }

  getMeta(id: string): StoredKbDoc | null {
    return this.read().entries.find((d) => d.id === id) ?? null
  }

  /**
   * 按角色返回文档全文(供下载):admin/school 全量;college 仅学校级或本院学院级。
   * 不可见返回 null,文件不存在也返回 null(统一 404)。
   */
  getScoped(id: string, scope?: KbScopeFilter): StoredKbDoc | null {
    const doc = this.getMeta(id)
    if (!doc) return null
    if (doc.scope === 'school') return doc
    if (!scope || scope.role === 'admin' || scope.role === 'school') return doc
    return doc.college === (scope.college ?? '') ? doc : null
  }

  add(input: { filename: string; college?: string; scope: KbScope; text: string; uploadedBy: string }): KbDocumentMeta {
    const filename = input.filename.trim()
    const text = input.text.trim()
    if (!filename) throw new Error('文件名不能为空')
    if (!text) throw new Error('文件内容为空(扫描版 PDF 请先 OCR,或确认上传的是文本型文件)')
    const chunks = chunkText(text)
    if (chunks.length === 0) throw new Error('未能从文件中提取到有效文本')

    const entry: StoredKbDoc = {
      id: genId(),
      filename,
      college: input.scope === 'college' ? (input.college?.trim() || undefined) : undefined,
      scope: input.scope,
      uploadedBy: input.uploadedBy,
      uploadedAt: now(),
      charCount: text.length,
      chunkCount: chunks.length,
      chunks,
    }
    if (entry.scope === 'college' && !entry.college) {
      throw new Error('学院级文件必须指定所属学院')
    }
    const doc = this.read()
    this.save([...doc.entries, entry])
    const { chunks: _c, ...meta } = entry
    return meta
  }

  remove(id: string): boolean {
    const doc = this.read()
    const next = doc.entries.filter((d) => d.id !== id)
    if (next.length === doc.entries.length) return false
    this.save(next)
    return true
  }

  /** 制度审查素材:可见文档的元数据 + 每文档前若干字符(控制上下文长度)。 */
  reviewMaterials(
    filter?: { scope?: KbScope; college?: string },
    maxDocs = 30,
    maxCharsPerDoc = 1500
  ): Array<{ filename: string; scope: KbScope; college?: string; charCount: number; preview: string }> {
    return this.read().entries
      .filter((d) => {
        if (!filter) return true
        if (filter.scope && d.scope !== filter.scope) return false
        if (filter.scope === 'college' && filter.college && d.college !== filter.college) return false
        return true
      })
      .slice(0, maxDocs)
      .map((d) => ({
        filename: d.filename,
        scope: d.scope,
        college: d.college,
        charCount: d.charCount,
        preview: d.chunks.join('').slice(0, maxCharsPerDoc),
      }))
  }

  /**
   * 检索:先按角色过滤可见文档,再对可见块做 BM25 排序。
   * 返回 Top-K 块及其所属文档元数据。
   */
  search(query: string, scope?: KbScopeFilter, topK = DEFAULT_TOP_K): KbSearchHit[] {
    const q = query.trim()
    if (!q) return []
    const qTokens = tokenize(q)
    if (qTokens.length === 0) return []

    const visible = this.visible(scope)
    const docs = this.read().entries.filter(visible)
    const allChunks: Array<{ doc: StoredKbDoc; idx: number; tokens: string[] }> = []
    const dfMap = new Map<string, number>()
    let totalLen = 0

    for (const doc of docs) {
      doc.chunks.forEach((text, idx) => {
        const tokens = tokenize(text)
        allChunks.push({ doc, idx, tokens })
        totalLen += tokens.length
        const seen = new Set<string>()
        for (const t of tokens) {
          if (seen.has(t)) continue
          seen.add(t)
          dfMap.set(t, (dfMap.get(t) ?? 0) + 1)
        }
      })
    }
    if (allChunks.length === 0) return []

    const avgLen = totalLen / allChunks.length
    const scored = allChunks
      .map((c) => ({ c, score: scoreBm25(c.tokens, qTokens, dfMap, allChunks.length, avgLen) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    const byDoc = new Map<string, KbSearchHit>()
    for (const { c, score: _score } of scored) {
      const { chunks: _c, ...meta } = c.doc
      if (!byDoc.has(c.doc.id)) {
        byDoc.set(c.doc.id, { doc: meta, chunks: [] })
      }
      byDoc.get(c.doc.id)!.chunks.push({ idx: c.idx, text: c.doc.chunks[c.idx] })
    }
    return [...byDoc.values()]
  }
}

/**
 * 构造知识库问答 prompt:$kb-ask skill + 检索片段。
 * 片段带文件出处,供 skill 按"仅依据原文 + 标注出处"作答。
 */
export function buildAskPrompt(question: string, hits: KbSearchHit[]): string {
  const lines: string[] = [
    `$kb-ask 请基于下面给出的文件内容回答用户问题。`,
    ``,
    `用户问题:${question}`,
    ``,
  ]
  if (hits.length === 0) {
    lines.push(`(未检索到相关文件内容)`)
  } else {
    let n = 0
    for (const hit of hits) {
      for (const chunk of hit.chunks) {
        n += 1
        const scopeLabel = hit.doc.scope === 'college' ? `学院:${hit.doc.college ?? '-'}` : '全校'
        lines.push(
          `[${n}] 文件:${hit.doc.filename}(${scopeLabel})`,
          chunk.text,
          ''
        )
      }
    }
  }
  lines.push(
    `要求:`,
    `1. 只依据上面给出的文件内容回答,不得使用外部知识或编造`,
    `2. 每个结论或数字都要标注出处(«文件名»),并尽可能指明条款/章节`,
    `3. 检索内容无法回答时,直接说明"未在已导入文件中找到相关内容",不要臆测`,
  )
  return lines.join('\n')
}
