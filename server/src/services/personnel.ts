import type { Storage } from './storage.js'
import type { UserRole } from './users.js'
import {
  PERSONNEL_LEVELS,
  REPORT_LEVELS,
  RISK_LEVELS,
  type PersonEntry,
  type PersonnelDB,
  type PersonnelLevel,
  type ReportLevel,
  type ReportRiskLevel,
  type ReportSummary,
  type SavedReport,
} from '../types.js'

const PERSONNEL_DOC = 'personnel'
const REPORTS_DOC = 'reports'
const PERSONNEL_SCHEMA_VERSION = 1
const MAX_REPORTS = 50

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function now(): string {
  return new Date().toISOString()
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function normalizeLevel(value: unknown, fallback: PersonnelLevel): PersonnelLevel {
  return typeof value === 'string' && (PERSONNEL_LEVELS as readonly string[]).includes(value)
    ? (value as PersonnelLevel)
    : fallback
}

function normalizeReportLevel(value: unknown, fallback: ReportLevel): ReportLevel {
  return typeof value === 'string' && (REPORT_LEVELS as readonly string[]).includes(value)
    ? (value as ReportLevel)
    : fallback
}

function normalizeRiskLevel(value: unknown): ReportRiskLevel | undefined {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
    ? (value as ReportRiskLevel)
    : undefined
}

/**
 * 人员名单服务。id 由服务端归一化生成,避免多端写入冲突。
 */
export class PersonnelService {
  constructor(private readonly storage: Storage) {}

  list(): PersonnelDB {
    return this.storage.readDoc<PersonnelDB>(PERSONNEL_DOC, {
      version: PERSONNEL_SCHEMA_VERSION,
      updatedAt: now(),
      entries: [],
    })
  }

  /**
   * 按角色返回名单:admin/school 全部;college 仅本学院条目。
   * 无学院归属的条目(校级名单、未归属个人)对院级用户不可见。
   */
  listScoped(scope?: { role: UserRole; college?: string }): PersonnelDB {
    const db = this.list()
    if (!scope || scope.role === 'admin' || scope.role === 'school') return db
    const college = scope.college ?? ''
    const entries = db.entries.filter((e) => e.college === college)
    return { ...db, entries }
  }

  private save(entries: PersonEntry[]): PersonnelDB {
    const db: PersonnelDB = {
      version: PERSONNEL_SCHEMA_VERSION,
      updatedAt: now(),
      entries,
    }
    this.storage.writeDoc(PERSONNEL_DOC, db)
    return db
  }

  /** 新建单条。返回带上服务端生成的 id。 */
  create(input: Record<string, unknown>): PersonEntry | null {
    const name = asString(input.name)
    if (!name) return null

    const entry: PersonEntry = {
      id: genId('person'),
      name,
      level: normalizeLevel(input.level, 'individual'),
      category: asString(input.category) ?? '其他',
      college: asString(input.college),
      department: asString(input.department),
      role: asString(input.role),
      tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : undefined,
      notes: asString(input.notes),
      createdAt: now(),
      updatedAt: now(),
    }
    const db = this.list()
    const entries = [...db.entries, entry]
    this.save(entries)
    return entry
  }

  /** 批量追加(Excel 导入 / 网页采集)。已存在的 id 跳过,缺失 id 的服务端补发。 */
  bulkAdd(inputEntries: unknown[]): { added: number; entries: PersonEntry[] } {
    const db = this.list()
    const existing = new Set(db.entries.map((e) => e.id))
    const added: PersonEntry[] = []

    for (const raw of inputEntries) {
      if (typeof raw !== 'object' || raw === null) continue
      const input = raw as Record<string, unknown>
      const name = asString(input.name)
      if (!name) continue

      // 已存在相同 id 的记录跳过,避免同一批数据重复导入
      const id = asString(input.id)
      if (id !== undefined && existing.has(id)) continue
      existing.add(id ?? genId('person'))

      added.push({
        id: id ?? genId('person'),
        name,
        level: normalizeLevel(input.level, 'individual'),
        category: asString(input.category) ?? '其他',
        college: asString(input.college),
        department: asString(input.department),
        role: asString(input.role),
        tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : undefined,
        notes: asString(input.notes),
        createdAt: asString(input.createdAt) ?? now(),
        updatedAt: asString(input.updatedAt) ?? now(),
      })
    }

    if (added.length > 0) {
      this.save([...db.entries, ...added])
    }
    return { added: added.length, entries: [...db.entries, ...added] }
  }

  update(id: string, patch: Record<string, unknown>): PersonEntry | null {
    const db = this.list()
    const idx = db.entries.findIndex((e) => e.id === id)
    if (idx < 0) return null

    const current = db.entries[idx]
    const next: PersonEntry = {
      ...current,
      name: asString(patch.name) ?? current.name,
      level: patch.level !== undefined ? normalizeLevel(patch.level, current.level) : current.level,
      category: asString(patch.category) ?? current.category,
      college: patch.college !== undefined ? asString(patch.college) : current.college,
      department: patch.department !== undefined ? asString(patch.department) : current.department,
      role: patch.role !== undefined ? asString(patch.role) : current.role,
      notes: patch.notes !== undefined ? asString(patch.notes) : current.notes,
      tags: Array.isArray(patch.tags) ? patch.tags.filter((t): t is string => typeof t === 'string') : current.tags,
      updatedAt: now(),
    }
    db.entries[idx] = next
    this.save(db.entries)
    return next
  }

  remove(id: string): boolean {
    const db = this.list()
    const next = db.entries.filter((e) => e.id !== id)
    if (next.length === db.entries.length) return false
    this.save(next)
    return true
  }

  clear(): void {
    this.save([])
  }

  /** 整表替换(备份还原)。保留传入 id,缺失或非法时服务端补发。 */
  replace(inputEntries: unknown[]): PersonnelDB {
    const normalized: PersonEntry[] = []
    for (const raw of inputEntries) {
      if (typeof raw !== 'object' || raw === null) continue
      const input = raw as Record<string, unknown>
      const name = asString(input.name)
      if (!name) continue
      normalized.push({
        id: asString(input.id) ?? genId('person'),
        name,
        level: normalizeLevel(input.level, 'individual'),
        category: asString(input.category) ?? '其他',
        college: asString(input.college),
        department: asString(input.department),
        role: asString(input.role),
        tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : undefined,
        notes: asString(input.notes),
        createdAt: asString(input.createdAt) ?? now(),
        updatedAt: asString(input.updatedAt) ?? now(),
      })
    }
    return this.save(normalized)
  }
}

/**
 * 舆情报告服务。数据为最新在前,上限 50 份(与旧前端行为一致)。
 */
export class ReportsService {
  constructor(private readonly storage: Storage) {}

  list(): SavedReport[] {
    return this.storage.readDoc<SavedReport[]>(REPORTS_DOC, [])
  }

  /**
   * 按角色返回报告:admin/school 全部(含个人报告);college 仅本院学院级报告,
   * 个人报告(level=individual)不可见。
   */
  listScoped(scope?: { role: UserRole; college?: string }): SavedReport[] {
    const all = this.list()
    if (!scope || scope.role === 'admin' || scope.role === 'school') return all
    const college = scope.college ?? ''
    return all.filter((r) => r.level === 'college' && r.dept === college)
  }

  /**
   * 创建报告。college 用户只能创建本学院的学院级报告(dept 与 level 双重校验)。
   */
  createScoped(input: Record<string, unknown>, scope?: { role: UserRole; college?: string }): SavedReport | null {
    if (scope && scope.role === 'college') {
      const dept = typeof input['dept'] === 'string' ? input['dept'].trim() : ''
      const level = typeof input['level'] === 'string' ? input['level'] : ''
      if (dept !== scope.college || level !== 'college') {
        throw new Error('越权:院级用户只能创建本学院的学院级报告')
      }
    }
    return this.create(input)
  }

  create(input: Record<string, unknown>): SavedReport | null {
    const content = asString(input.content)
    if (!content) return null

    const report: SavedReport = {
      id: asString(input.id) ?? genId('report'),
      dept: asString(input.dept) ?? '未命名报告',
      timeRange: asString(input.timeRange) ?? '',
      content,
      createdAt: asString(input.createdAt) ?? now(),
      threadId: asString(input.threadId),
      level: normalizeReportLevel(input.level, 'college'),
      personName: asString(input.personName),
      riskLevel: normalizeRiskLevel(input.riskLevel),
    }
    const next = [report, ...this.list()].slice(0, MAX_REPORTS)
    this.storage.writeDoc(REPORTS_DOC, next)
    return report
  }

  remove(id: string): boolean {
    const next = this.list().filter((r) => r.id !== id)
    if (next.length === this.list().length) return false
    this.storage.writeDoc(REPORTS_DOC, next)
    return true
  }

  /**
   * 按角色删除:admin/school 任意;college 仅限本学院学院级报告。
   */
  removeScoped(id: string, scope?: { role: UserRole; college?: string }): boolean {
    if (scope && scope.role === 'college') {
      const target = this.list().find((r) => r.id === id)
      if (!target) return false
      if (target.level !== 'college' || target.dept !== scope.college) {
        throw new Error('越权:只能删除本学院的学院级报告')
      }
    }
    return this.remove(id)
  }

  /**
   * 舆情概览统计(趋势/风险预警面板数据源):
   * - total/byRisk:风险等级计数(low/medium/high)
   * - byLevel:各层级报告计数;last7:近 7 天每日报告数
   * - byDept:报告量 Top 8 的院系(含最高风险等级),其余并入「其他」
   * 范围与 listScoped 一致(admin/school 全量,college 仅本院)。
   */
  summary(scope?: { role: UserRole; college?: string }): ReportSummary {
    const reports = this.listScoped(scope)
    const total = reports.length

    const byRisk: Record<ReportRiskLevel, number> = { low: 0, medium: 0, high: 0 }
    const byLevel: Record<ReportLevel, number> = {
      school: 0, college: 0, department: 0, class: 0, course: 0, individual: 0,
    }
    const deptCount = new Map<string, { count: number; highest: ReportRiskLevel | undefined }>()

    const today = new Date()
    const last7: { date: string; count: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      last7.push({ date: d.toISOString().slice(0, 10), count: 0 })
    }

    for (const r of reports) {
      const risk = r.riskLevel ?? 'medium'
      byRisk[risk] += 1
      byLevel[r.level] = (byLevel[r.level] ?? 0) + 1
      const dept = r.dept || '未标注'
      const cur = deptCount.get(dept) ?? { count: 0, highest: undefined }
      cur.count += 1
      if (risk === 'high') cur.highest = 'high'
      else if (risk === 'medium' && cur.highest !== 'high') cur.highest = 'medium'
      else if (cur.highest === undefined) cur.highest = 'low'
      deptCount.set(dept, cur)

      const day = r.createdAt.slice(0, 10)
      const slot = last7.find((x) => x.date === day)
      if (slot) slot.count += 1
    }

    const sorted = [...deptCount.entries()].sort((a, b) => b[1].count - a[1].count)
    const top = sorted.slice(0, 8).map(([dept, v]) => ({ dept, count: v.count, highestRisk: v.highest }))
    const rest = sorted.slice(8).reduce((acc, [, v]) => acc + v.count, 0)
    if (rest > 0) top.push({ dept: '其他', count: rest, highestRisk: undefined })

    return { total, byRisk, byLevel, last7, byDept: top }
  }

  /** 整表替换(备份还原)。非法记录丢弃,保留传入 id。 */
  replace(inputReports: unknown[]): SavedReport[] {
    const normalized: SavedReport[] = []
    for (const raw of inputReports) {
      if (typeof raw !== 'object' || raw === null) continue
      const input = raw as Record<string, unknown>
      const content = asString(input.content)
      if (!content) continue
      normalized.push({
        id: asString(input.id) ?? genId('report'),
        dept: asString(input.dept) ?? '未命名报告',
        timeRange: asString(input.timeRange) ?? '',
        content,
        createdAt: asString(input.createdAt) ?? now(),
        threadId: asString(input.threadId),
        level: normalizeReportLevel(input.level, 'college'),
        personName: asString(input.personName),
        riskLevel: normalizeRiskLevel(input.riskLevel),
      })
    }
    const next = normalized.slice(0, MAX_REPORTS)
    this.storage.writeDoc(REPORTS_DOC, next)
    return next
  }
}
