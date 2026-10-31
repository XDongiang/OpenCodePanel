import type { Storage } from './storage.js'

import type { LiteratureHit } from './literature.js'

/**
 * 科研助理(对齐《华师智能 ai 盒子》模块三):
 *
 * - PaperService        文献收藏库(检索结果一键收藏,DOI/标题去重)
 * - FundService         国家自然科学基金项目库(手工/Excel 导入,供 AI 辅助分析)
 * - SubscriptionService 论文推送订阅(关键词/期刊/周期/邮箱)
 * - buildPushDigest     推送简报生成(手动生成与定时调度共用)
 *
 * 文献检索本身由 services/literature.ts 的 LiteratureProvider 承担(/api/research/search),
 * 本文件只管理持久化的收藏/基金/订阅。
 */

/** 生成论文推送简报(Markdown),手动生成与定时调度共用。 */
export function buildPushDigest(sub: PushSubscription, hits: LiteratureHit[]): string {
  const lines: string[] = [
    '# 论文推送:' + sub.name,
    '',
    '关键词:' + sub.keywords.join(' / '),
    '周期:' + sub.period + (sub.journal ? ' · 期刊:' + sub.journal : ''),
    '生成时间:' + new Date().toLocaleString('zh-CN'),
    '',
    '共检索到 ' + hits.length + ' 条相关文献:',
    '',
  ]
  hits.forEach((h, i) => {
    const meta = [h.authors.slice(0, 3).join(', '), h.journal, h.year].filter(Boolean).join(' | ')
    lines.push((i + 1) + '. **' + h.title + '**' + (meta ? ' — ' + meta : ''))
    if (h.doi) lines.push('   DOI:' + h.doi)
    if (h.url) lines.push('   链接:' + h.url)
    lines.push('')
  })
  return lines.join('\n')
}

export type PushPeriod = 'daily' | 'weekly' | 'monthly'

export interface PaperRecord {
  id: string
  title: string
  authors: string[]
  year?: string
  journal?: string
  doi?: string
  url?: string
  abstract?: string
  type?: string
  field?: string
  source: string
  notes?: string
  collectedBy: string
  createdAt: string
  updatedAt: string
}

export interface FundProject {
  id: string
  name: string
  leader?: string
  institution?: string
  code?: string
  year?: string
  number?: string
  amount?: string
  category?: string
  status?: string
  abstract?: string
  createdAt: string
  updatedAt: string
}

export interface PushSubscription {
  id: string
  name: string
  keywords: string[]
  journal?: string
  period: PushPeriod
  email?: string
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

interface Doc<T> {
  version: number
  updatedAt: string
  entries: T[]
}

const SCHEMA_VERSION = 1

function now(): string {
  return new Date().toISOString()
}

function genId(prefix: string): string {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  return out.length > 0 ? out : undefined
}

function normalizePeriod(value: unknown, fallback: PushPeriod): PushPeriod {
  return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : fallback
}

/** 文献去重键:DOI 优先,退化为归一化标题。 */
function paperKey(p: { doi?: string; title: string }): string {
  const doi = (p.doi ?? '').trim().toLowerCase()
  if (doi) return 'doi:' + doi
  return 'title:' + p.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

class BaseService<T> {
  constructor(
    protected readonly storage: Storage,
    private readonly docName: string
  ) {}

  protected read(): Doc<T> {
    return this.storage.readDoc<Doc<T>>(this.docName, {
      version: SCHEMA_VERSION,
      updatedAt: now(),
      entries: [],
    })
  }

  protected save(entries: T[]): Doc<T> {
    const doc: Doc<T> = { version: SCHEMA_VERSION, updatedAt: now(), entries }
    this.storage.writeDoc(this.docName, doc)
    return doc
  }

  protected listEntries(): T[] {
    return this.read().entries
  }
}

/**
 * 文献收藏库。所有登录用户可收藏/删除自己的;admin 可删任意。
 * 保存时按 DOI/归一化标题去重,重复返回 null(由路由提示"已在收藏中")。
 */
export class PaperService extends BaseService<PaperRecord> {
  constructor(storage: Storage) {
    super(storage, 'papers')
  }

  list(filter: { q?: string; field?: string; type?: string; year?: string; journal?: string } = {}): PaperRecord[] {
    const q = (filter.q ?? '').trim().toLowerCase()
    const field = (filter.field ?? '').trim()
    const type = (filter.type ?? '').trim()
    const year = (filter.year ?? '').trim()
    const journal = (filter.journal ?? '').trim()

    return this.listEntries()
      .filter((p) => {
        if (field && p.field !== field) return false
        if (type && p.type !== type) return false
        if (year && p.year !== year) return false
        if (journal && !(p.journal ?? '').toLowerCase().includes(journal.toLowerCase())) return false
        if (q) {
          const hay = [p.title, ...p.authors, p.journal ?? '', p.abstract ?? ''].join(' ').toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  add(input: Record<string, unknown>, collectedBy: string): PaperRecord | null {
    const title = asString(input.title)
    if (!title) return null
    const entry: PaperRecord = {
      id: asString(input.id) ?? genId('paper'),
      title,
      authors: asStringArray(input.authors) ?? [],
      year: asString(input.year),
      journal: asString(input.journal),
      doi: asString(input.doi),
      url: asString(input.url),
      abstract: asString(input.abstract),
      type: asString(input.type),
      field: asString(input.field),
      source: asString(input.source) ?? 'manual',
      notes: asString(input.notes),
      collectedBy,
      createdAt: now(),
      updatedAt: now(),
    }
    const entries = this.listEntries()
    if (entries.some((e) => paperKey(e) === paperKey(entry))) return null
    this.save([entry, ...entries])
    return entry
  }

  remove(id: string, username: string, isAdmin: boolean): boolean {
    const entries = this.listEntries()
    const target = entries.find((e) => e.id === id)
    if (!target) return false
    if (!isAdmin && target.collectedBy !== username) return false
    this.save(entries.filter((e) => e.id !== id))
    return true
  }

  clear(): void {
    this.save([])
  }
}

/** 国家自然科学基金项目库。写仅 admin(与名单/岗位一致);读所有登录用户。 */
export class FundService extends BaseService<FundProject> {
  constructor(storage: Storage) {
    super(storage, 'funds')
  }

  list(filter: { q?: string; year?: string; category?: string; status?: string } = {}): FundProject[] {
    const q = (filter.q ?? '').trim().toLowerCase()
    const year = (filter.year ?? '').trim()
    const category = (filter.category ?? '').trim()
    const status = (filter.status ?? '').trim()

    return this.listEntries()
      .filter((f) => {
        if (year && f.year !== year) return false
        if (category && f.category !== category) return false
        if (status && f.status !== status) return false
        if (q) {
          const hay = [f.name, f.leader ?? '', f.institution ?? '', f.code ?? '', f.number ?? ''].join(' ').toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => (b.year ?? '').localeCompare(a.year ?? '') || b.createdAt.localeCompare(a.createdAt))
  }

  create(input: Record<string, unknown>): FundProject | null {
    const name = asString(input.name)
    if (!name) return null
    const entry: FundProject = {
      id: asString(input.id) ?? genId('fund'),
      name,
      leader: asString(input.leader),
      institution: asString(input.institution),
      code: asString(input.code),
      year: asString(input.year),
      number: asString(input.number),
      amount: asString(input.amount),
      category: asString(input.category),
      status: asString(input.status),
      abstract: asString(input.abstract),
      createdAt: now(),
      updatedAt: now(),
    }
    const entries = this.listEntries()
    this.save([entry, ...entries])
    return entry
  }

  /** 批量导入(Excel)。按「批准号 + 项目名称」去重,重复项不入库。 */
  bulkAdd(inputEntries: unknown[]): { added: number; entries: FundProject[] } {
    const existing = this.listEntries()
    const seen = new Set(existing.map((f) => [f.number ?? '', f.name].join('|')))
    const added: FundProject[] = []
    for (const raw of inputEntries) {
      if (typeof raw !== 'object' || raw === null) continue
      const input = raw as Record<string, unknown>
      const name = asString(input.name)
      if (!name) continue
      const entry: FundProject = {
        id: asString(input.id) ?? genId('fund'),
        name,
        leader: asString(input.leader),
        institution: asString(input.institution),
        code: asString(input.code),
        year: asString(input.year),
        number: asString(input.number),
        amount: asString(input.amount),
        category: asString(input.category),
        status: asString(input.status),
        abstract: asString(input.abstract),
        createdAt: asString(input.createdAt) ?? now(),
        updatedAt: asString(input.updatedAt) ?? now(),
      }
      const key = [entry.number ?? '', entry.name].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      added.push(entry)
    }
    if (added.length > 0) this.save([...existing, ...added])
    return { added: added.length, entries: [...existing, ...added] }
  }

  update(id: string, patch: Record<string, unknown>): FundProject | null {
    const entries = this.listEntries()
    const idx = entries.findIndex((f) => f.id === id)
    if (idx < 0) return null
    const cur = entries[idx]
    const next: FundProject = {
      ...cur,
      name: asString(patch.name) ?? cur.name,
      leader: patch.leader !== undefined ? asString(patch.leader) : cur.leader,
      institution: patch.institution !== undefined ? asString(patch.institution) : cur.institution,
      code: patch.code !== undefined ? asString(patch.code) : cur.code,
      year: patch.year !== undefined ? asString(patch.year) : cur.year,
      number: patch.number !== undefined ? asString(patch.number) : cur.number,
      amount: patch.amount !== undefined ? asString(patch.amount) : cur.amount,
      category: patch.category !== undefined ? asString(patch.category) : cur.category,
      status: patch.status !== undefined ? asString(patch.status) : cur.status,
      abstract: patch.abstract !== undefined ? asString(patch.abstract) : cur.abstract,
      updatedAt: now(),
    }
    entries[idx] = next
    this.save(entries)
    return next
  }

  remove(id: string): boolean {
    const entries = this.listEntries()
    if (!entries.some((f) => f.id === id)) return false
    this.save(entries.filter((f) => f.id !== id))
    return true
  }

  clear(): void {
    this.save([])
  }

  /** 分析上下文:压缩为每项目一行,避免 prompt 过长。 */
  summarizeForAnalysis(max = 400): string[] {
    return this.listEntries()
      .slice(0, max)
      .map((f) => {
        const parts = [
          f.name,
          f.leader ? '负责人:' + f.leader : '',
          f.institution ? '单位:' + f.institution : '',
          f.code ? '学科代码:' + f.code : '',
          f.year ? '年度:' + f.year : '',
          f.number ? '批准号:' + f.number : '',
          f.category ? '类别:' + f.category : '',
          f.status ?? '',
        ].filter(Boolean)
        return parts.join(' | ')
      })
  }
}

/** 论文推送订阅。个人设置,所有登录用户可见可管理(简单协作模型)。 */
export class SubscriptionService extends BaseService<PushSubscription> {
  constructor(storage: Storage) {
    super(storage, 'push-subscriptions')
  }

  list(): PushSubscription[] {
    return this.listEntries().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  create(input: Record<string, unknown>, createdBy: string): PushSubscription | null {
    const name = asString(input.name)
    const keywords = asStringArray(input.keywords)
    if (!name || !keywords || keywords.length === 0) return null
    const entry: PushSubscription = {
      id: asString(input.id) ?? genId('sub'),
      name,
      keywords,
      journal: asString(input.journal),
      period: normalizePeriod(input.period, 'weekly'),
      email: asString(input.email),
      enabled: input.enabled === false ? false : true,
      createdBy,
      createdAt: now(),
      updatedAt: now(),
    }
    const entries = this.listEntries()
    this.save([entry, ...entries])
    return entry
  }

  get(id: string): PushSubscription | null {
    return this.listEntries().find((s) => s.id === id) ?? null
  }

  update(id: string, patch: Record<string, unknown>): PushSubscription | null {
    const entries = this.listEntries()
    const idx = entries.findIndex((s) => s.id === id)
    if (idx < 0) return null
    const cur = entries[idx]
    const next: PushSubscription = {
      ...cur,
      name: asString(patch.name) ?? cur.name,
      keywords: asStringArray(patch.keywords) ?? cur.keywords,
      journal: patch.journal !== undefined ? asString(patch.journal) : cur.journal,
      period: patch.period !== undefined ? normalizePeriod(patch.period, cur.period) : cur.period,
      email: patch.email !== undefined ? asString(patch.email) : cur.email,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled,
      updatedAt: now(),
    }
    entries[idx] = next
    this.save(entries)
    return next
  }

  remove(id: string): boolean {
    const entries = this.listEntries()
    if (!entries.some((s) => s.id === id)) return false
    this.save(entries.filter((s) => s.id !== id))
    return true
  }
}
