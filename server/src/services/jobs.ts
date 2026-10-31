import type { Storage } from './storage.js'

/**
 * 就业指导:招聘岗位结构化信息库(对齐《华师智能 ai 盒子》模块二)。
 *
 * - 字段覆盖需求 13 项采集字段:单位名称/招聘岗位/招聘专业/学历要求/工作地点/
 *   招聘人数/薪资待遇/报名时间/截止时间/招聘公告链接/联系方式/信息来源/发布时间
 * - 去重:bulk 导入按「单位 + 岗位 + 截止时间」判重,重复条目标记跳过(重复信息去除)
 * - 失效识别:截止时间早于今天的 active 岗位在读取时自动视为过期;管理员也可手动切换 status
 */

export type JobStatus = 'active' | 'expired'

/**
 * 重点岗位分类(对齐 PDF 模块二「重点岗位信息覆盖」):
 * 大型互联网企业 / 国有企业 / 事业单位 / 公务员及选调生 / 教师编制岗位 /
 * 科研院所 / 高校行政及科研岗位 / 医疗教育人工智能等重点行业岗位。
 */
export const JOB_CATEGORIES = [
  '大型互联网企业',
  '国有企业',
  '事业单位',
  '公务员及选调生',
  '教师编制岗位',
  '科研院所',
  '高校行政及科研岗位',
  '医疗教育AI等重点行业',
  '其他',
] as const

export type JobCategory = (typeof JOB_CATEGORIES)[number]

/** 按 单位+岗位+标签 启发式归类(顺序敏感:更具体的类别优先)。未命中返回「其他」。 */
export function classifyJob(input: { company?: string; position?: string; tags?: string[] }): JobCategory {
  const hay = [
    input.company ?? '',
    input.position ?? '',
    ...(input.tags ?? []),
  ].join(' ')
  if (/公务员|选调生|国考|省考|遴选|军队文职/.test(hay)) return '公务员及选调生'
  // 教师编制(基础教育:中小学/幼儿园/中职)须在「高校」之前,避免「××大学附中」误判
  if (/中小学|幼儿园|中职|职高|特岗教师|教师编制|中学教师|小学教师|附中|附属中学/.test(hay)) return '教师编制岗位'
  if (/研究院|研究所|科学院|科研院所|实验室|科研助理/.test(hay)) return '科研院所'
  if (/大学|学院|高校|专任教师|辅导员|教研岗|行政岗|教务|学工/.test(hay)) return '高校行政及科研岗位'
  if (/事业单位|事业编|人社局|教育局|卫健委|人民政府|市政府|区政府/.test(hay)) return '事业单位'
  if (/国企|央企|中建|中铁|中交|中电|电网|烟草|石油|石化|银行|证券|保险|城投|交投|水务|航空|铁路/.test(hay)) return '国有企业'
  if (/互联网|科技|网络|软件|数据|人工智能|AI|智能|字节|腾讯|阿里|百度|美团|京东|网易|拼多多|小米|华为/.test(hay)) return '大型互联网企业'
  if (/医院|医疗|医药|健康|教育|培训|新能源|芯片|半导体|制造|汽车/.test(hay)) return '医疗教育AI等重点行业'
  return '其他'
}

export interface JobPosting {
  id: string
  company: string
  position: string
  major?: string
  degree?: string
  location?: string
  headcount?: string
  salary?: string
  applyStart?: string
  deadline?: string
  url?: string
  contact?: string
  source: string
  publishedAt?: string
  status: JobStatus
  college?: string
  tags?: string[]
  category?: JobCategory
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface JobFilter {
  q?: string
  degree?: string
  location?: string
  status?: JobStatus
  college?: string
  category?: JobCategory
}

interface JobsDB {
  version: number
  updatedAt: string
  entries: JobPosting[]
}

const JOBS_DOC = 'jobs'
const SCHEMA_VERSION = 1

function genId(prefix: string): string {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

function now(): string {
  return new Date().toISOString()
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function normalizeStatus(value: unknown, fallback: JobStatus): JobStatus {
  return value === 'expired' ? 'expired' : value === 'active' ? 'active' : fallback
}

/** 截止日期字符串解析失败时返回 null;可接受 2026-09-30 / 2026/09/30 / 2026-9-30。 */
function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value.replace(/\//g, '-'))
  return Number.isNaN(d.getTime()) ? null : d
}

/** 读取时的有效状态:手动 expired 优先;active 且已过截止日视为过期。 */
function effectiveStatus(entry: JobPosting, today: Date): JobStatus {
  if (entry.status === 'expired') return 'expired'
  const deadline = parseDate(entry.deadline)
  if (!deadline) return entry.status
  const day = new Date(today)
  day.setHours(0, 0, 0, 0)
  return deadline.getTime() < day.getTime() ? 'expired' : 'active'
}

function normalizeEntry(input: Record<string, unknown>, fallback: JobStatus): JobPosting {
  const entry: JobPosting = {
    id: asString(input.id) ?? genId('job'),
    company: asString(input.company) ?? '',
    position: asString(input.position) ?? '',
    major: asString(input.major),
    degree: asString(input.degree),
    location: asString(input.location),
    headcount: asString(input.headcount),
    salary: asString(input.salary),
    applyStart: asString(input.applyStart),
    deadline: asString(input.deadline),
    url: asString(input.url),
    contact: asString(input.contact),
    source: asString(input.source) ?? '手动录入',
    publishedAt: asString(input.publishedAt),
    status: normalizeStatus(input.status, fallback),
    college: asString(input.college),
    tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : undefined,
    notes: asString(input.notes),
    createdAt: asString(input.createdAt) ?? now(),
    updatedAt: asString(input.updatedAt) ?? now(),
    category: asCategory(input.category) ?? classifyJob(input),
  }
  return entry
}

/** 输入显式分类必须是合法类别;否则返回 undefined 交由 classifyJob 推断。 */
function asCategory(value: unknown): JobCategory | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return (JOB_CATEGORIES as readonly string[]).includes(v) ? (v as JobCategory) : undefined
}

/** 去重键:单位 + 岗位 + 截止时间(截止为空时退化为 单位 + 岗位)。 */
function dedupeKey(e: JobPosting): string {
  return [e.company, e.position, e.deadline ?? ''].join('|')
}

/**
 * 岗位信息服务。数据按创建时间最新在前。
 */
export class JobsService {
  constructor(private readonly storage: Storage) {}

  private read(): JobsDB {
    return this.storage.readDoc<JobsDB>(JOBS_DOC, {
      version: SCHEMA_VERSION,
      updatedAt: now(),
      entries: [],
    })
  }

  private save(entries: JobPosting[]): JobsDB {
    const db: JobsDB = { version: SCHEMA_VERSION, updatedAt: now(), entries }
    this.storage.writeDoc(JOBS_DOC, db)
    return db
  }

  /** 按过滤条件返回岗位(读取时应用自动失效;排序最新在前)。 */
  list(filter: JobFilter = {}): JobPosting[] {
    const db = this.read()
    const q = (filter.q ?? '').trim().toLowerCase()
    const degree = (filter.degree ?? '').trim()
    const location = (filter.location ?? '').trim()
    const status = filter.status
    const college = (filter.college ?? '').trim()
    const category = filter.category ?? ('' as string)
    const today = new Date()

    return db.entries
      .map((e) => ({ ...e, status: effectiveStatus(e, today) }))
      .filter((e) => {
        if (status && e.status !== status) return false
        if (degree && e.degree !== degree) return false
        if (location && !(e.location ?? '').includes(location)) return false
        if (college && e.college !== college) return false
        if (category && e.category !== category) return false
        if (q) {
          const hay = [e.company, e.position, e.major ?? '', e.source, e.deadline ?? '']
            .join(' ')
            .toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** 新建岗位。单位名称与招聘岗位必填,否则返回 null。 */
  create(input: Record<string, unknown>): JobPosting | null {
    const raw = normalizeEntry(input, 'active')
    if (!raw.company || !raw.position) return null
    const entry: JobPosting = { ...raw, createdAt: now(), updatedAt: now() }
    const db = this.read()
    this.save([entry, ...db.entries])
    return entry
  }

  /** 批量追加(Excel 导入)。已存在相同「单位+岗位+截止」的跳过;返回新增数与全量。 */
  bulkAdd(inputEntries: unknown[]): { added: number; entries: JobPosting[] } {
    const db = this.read()
    const seen = new Set(db.entries.map(dedupeKey))
    const added: JobPosting[] = []
    for (const raw of inputEntries) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = normalizeEntry(raw as Record<string, unknown>, 'active')
      if (!entry.company || !entry.position) continue
      const key = dedupeKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      if (!entry.createdAt || !entry.updatedAt) {
        entry.createdAt = now()
        entry.updatedAt = now()
      }
      added.push(entry)
    }
    if (added.length > 0) this.save([...db.entries, ...added])
    return { added: added.length, entries: [...db.entries, ...added] }
  }

  /** 更新字段(含手动切换 active/expired)。 */
  update(id: string, patch: Record<string, unknown>): JobPosting | null {
    const db = this.read()
    const idx = db.entries.findIndex((e) => e.id === id)
    if (idx < 0) return null
    const current = db.entries[idx]
    const next: JobPosting = {
      ...current,
      company: asString(patch.company) ?? current.company,
      position: asString(patch.position) ?? current.position,
      major: patch.major !== undefined ? asString(patch.major) : current.major,
      degree: patch.degree !== undefined ? asString(patch.degree) : current.degree,
      location: patch.location !== undefined ? asString(patch.location) : current.location,
      headcount: patch.headcount !== undefined ? asString(patch.headcount) : current.headcount,
      salary: patch.salary !== undefined ? asString(patch.salary) : current.salary,
      applyStart: patch.applyStart !== undefined ? asString(patch.applyStart) : current.applyStart,
      deadline: patch.deadline !== undefined ? asString(patch.deadline) : current.deadline,
      url: patch.url !== undefined ? asString(patch.url) : current.url,
      contact: patch.contact !== undefined ? asString(patch.contact) : current.contact,
      source: asString(patch.source) ?? current.source,
      publishedAt: patch.publishedAt !== undefined ? asString(patch.publishedAt) : current.publishedAt,
      status: patch.status !== undefined ? normalizeStatus(patch.status, current.status) : current.status,
      college: patch.college !== undefined ? asString(patch.college) : current.college,
      tags: Array.isArray(patch.tags) ? patch.tags.filter((t): t is string => typeof t === 'string') : current.tags,
      notes: patch.notes !== undefined ? asString(patch.notes) : current.notes,
      updatedAt: now(),
    }
    db.entries[idx] = next
    this.save(db.entries)
    return next
  }

  remove(id: string): boolean {
    const db = this.read()
    const next = db.entries.filter((e) => e.id !== id)
    if (next.length === db.entries.length) return false
    this.save(next)
    return true
  }

  clear(): void {
    this.save([])
  }

  /** 整表替换(备份还原)。 */
  replace(inputEntries: unknown[]): JobPosting[] {
    const entries: JobPosting[] = []
    for (const raw of inputEntries) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = normalizeEntry(raw as Record<string, unknown>, 'active')
      if (!entry.company || !entry.position) continue
      if (!entry.createdAt || !entry.updatedAt) {
        entry.createdAt = now()
        entry.updatedAt = now()
      }
      entries.push(entry)
    }
    return this.save(entries).entries
  }
}
