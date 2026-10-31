/**
 * 文献检索 provider:Crossref(期刊/会议,开放 API)+ Semantic Scholar(补充)。
 *
 * - 多源并行检索,统一输出 LiteratureHit,按标题归一化去重
 * - 单源失败不影响整体(各自 catch 返回空)
 * - 知网/万方等需账号授权的平台不做自动抓取,由人工/合规流程对接
 */

/** 文献类型(启发式归类,用于检索过滤):期刊/会议/学位/综述。 */
export type LiteratureType = 'journal' | 'conference' | 'thesis' | 'review'

export interface LiteratureSearchParams {
  q: string
  author?: string
  journal?: string
  fromYear?: string
  toYear?: string
  type?: LiteratureType
  maxResults?: number
}

export interface LiteratureHit {
  title: string
  authors: string[]
  year?: string
  journal?: string
  doi?: string
  url?: string
  abstract?: string
  source: string
  type?: string
}

interface CrossrefItem {
  title?: unknown
  author?: Array<{ given?: string; family?: string; name?: string }>
  issued?: { 'date-parts'?: number[][] }
  'container-title'?: unknown
  DOI?: unknown
  URL?: unknown
  abstract?: unknown
  type?: unknown
}

interface S2Item {
  title?: unknown
  authors?: Array<{ name?: string }>
  year?: unknown
  venue?: unknown
  externalIds?: Record<string, unknown>
  url?: unknown
  abstract?: unknown
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim()
}

function dedupe(hits: Array<{ title: string }>): LiteratureHit[] {
  const seen = new Set<string>()
  const out: LiteratureHit[] = []
  for (const h of hits) {
    const key = normalizeTitle(h.title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(h as LiteratureHit)
  }
  return out
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

/** 按文献类型过滤(启发式:标题/摘要关键词 + 来源类型 + 期刊名)。 */
export function filterHitsByType(hits: LiteratureHit[], type?: LiteratureType): LiteratureHit[] {
  if (!type) return hits
  const REVIEW_RE = /\b(review|survey|meta-?analysis)\b|综述/i
  const CONF_RE = /\b(proceedings|conference)\b|会议论文集?|[Cc]onf\./i
  const THESIS_RE = /\b(thesis|dissertation)\b|学位论文/i
  return hits.filter((h) => {
    const title = h.title
    const abs = h.abstract ?? ''
    const venue = h.journal ?? ''
    const srcType = (h.type ?? '').toLowerCase()
    switch (type) {
      case 'review':
        return REVIEW_RE.test(title) || REVIEW_RE.test(abs)
      case 'thesis':
        return THESIS_RE.test(title) || srcType.includes('dissert') || srcType.includes('thesis')
      case 'conference':
        return CONF_RE.test(title) || srcType.includes('proceeding') || CONF_RE.test(venue)
      case 'journal':
        // 期刊:排除会议/学位/综述,优先有期刊名与 journal-article
        return !!venue && !srcType.includes('proceeding') && !CONF_RE.test(venue) && !CONF_RE.test(title) && !THESIS_RE.test(title) && !REVIEW_RE.test(title)
      default:
        return true
    }
  })
}

export class LiteratureProvider {
  constructor(
    private readonly crossrefBase = 'https://api.crossref.org',
    private readonly s2Base = 'https://api.semanticscholar.org/graph/v1',
    private readonly timeoutMs = 12000
  ) {}

  /** 多源检索并去重并过滤类型,返回前 maxResults 条。检索失败返回空数组(不抛错)。 */
  async search(params: LiteratureSearchParams): Promise<LiteratureHit[]> {
    const q = params.q.trim()
    if (!q) return []
    const maxResults = Math.min(Math.max(params.maxResults ?? 20, 1), 50)
    const [crossref, s2] = await Promise.all([
      this.searchCrossref(params, maxResults).catch(() => [] as LiteratureHit[]),
      this.searchSemanticScholar(params, maxResults).catch(() => [] as LiteratureHit[]),
    ])
    return filterHitsByType(dedupe([...crossref, ...s2]), params.type).slice(0, maxResults)
  }

  private async searchCrossref(params: LiteratureSearchParams, maxResults: number): Promise<LiteratureHit[]> {
    const url = new URL('/works', this.crossrefBase)
    url.searchParams.set('query.bibliographic', params.q)
    if (params.author) url.searchParams.set('query.author', params.author)
    if (params.journal) url.searchParams.set('container-title', params.journal)
    const filters: string[] = []
    if (params.fromYear) filters.push('from-pub-date:' + params.fromYear + '-01-01')
    if (params.toYear) filters.push('until-pub-date:' + params.toYear + '-12-31')
    if (filters.length > 0) url.searchParams.set('filter', filters.join(','))
    url.searchParams.set('rows', String(maxResults))

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'User-Agent': 'ccnu-ai-server/0.1 (mailto:research@ccnu.edu.cn)' },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { message?: { items?: CrossrefItem[] } }
    const items = data.message?.items ?? []

    return items
      .map((it): LiteratureHit | null => {
        const title = str(Array.isArray(it.title) ? it.title[0] : it.title)
        if (!title) return null
        const authors = Array.isArray(it.author)
          ? it.author
              .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' '))
              .filter((n): n is string => Boolean(n))
          : []
        const yearParts = it.issued?.['date-parts']?.[0]
        const year = yearParts?.[0] ? String(yearParts[0]) : undefined
        const journal = Array.isArray(it['container-title']) ? str(it['container-title'][0]) : undefined
        return {
          title,
          authors,
          year,
          journal,
          doi: str(it.DOI),
          url: str(it.URL),
          abstract: str(it.abstract) ? stripTags(String(it.abstract)) : undefined,
          source: 'crossref',
          type: str(it.type),
        }
      })
      .filter((h): h is LiteratureHit => h !== null)
  }

  private async searchSemanticScholar(params: LiteratureSearchParams, maxResults: number): Promise<LiteratureHit[]> {
    const url = new URL('/paper/search', this.s2Base)
    url.searchParams.set('query', params.q)
    url.searchParams.set('fields', 'title,authors,year,venue,externalIds,url,abstract')
    url.searchParams.set('limit', String(Math.min(maxResults * 2, 100)))

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: S2Item[] }
    const items = data.data ?? []

    return items
      .filter((it) => {
        if (params.journal && typeof it.venue === 'string' && !it.venue.toLowerCase().includes(params.journal.toLowerCase())) return false
        if (params.fromYear && typeof it.year === 'number' && it.year < Number(params.fromYear)) return false
        if (params.toYear && typeof it.year === 'number' && it.year > Number(params.toYear)) return false
        return true
      })
      .map((it): LiteratureHit | null => {
        const title = str(it.title)
        if (!title) return null
        const authors = Array.isArray(it.authors)
          ? it.authors.map((a) => a.name ?? '').filter(Boolean)
          : []
        return {
          title,
          authors,
          year: typeof it.year === 'number' ? String(it.year) : undefined,
          journal: str(it.venue),
          doi: str(it.externalIds?.['DOI']),
          url: str(it.url),
          abstract: str(it.abstract),
          source: 'semantic-scholar',
          type: 'paper',
        }
      })
      .filter((h): h is LiteratureHit => h !== null)
  }
}
