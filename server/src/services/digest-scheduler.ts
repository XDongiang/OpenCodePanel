import type { Storage } from './storage.js'
import type { JobPosting } from './jobs.js'
import type { SavedReport } from '../types.js'
import type { PushPeriod } from './research.js'
import { PERIOD_LABEL } from './push-scheduler.js'

/**
 * 舆情/就业信息定期汇总调度(闭环:采集 → 分析 → 内容生成 → 定期推送)。
 *
 * - 配置(digest-configs):{type: 'report'|'job', period: daily|weekly|monthly, email?, enabled}
 * - 到期判断与 push-scheduler 一致:无运行记录(首次)或距上次超过周期
 * - 到期生成汇总 Markdown:舆情取近一周期报告,就业取全部在招岗位
 * - 邮件由部署方注入 sendMail(agently-cli);站内消息由 notify 写入消息中心
 * - app.ts 与论文推送共用一个 setInterval 定时调用 checkDue
 *
 * storage 文档:
 *   digest-configs  DigestConfig[] (newest first)
 *   digest-runs     Record<configId, ISO lastRunAt>
 */

const CONFIGS_DOC = 'digest-configs'
const RUNS_DOC = 'digest-runs'

export type DigestType = 'report' | 'job'

export interface DigestConfig {
  id: string
  type: DigestType
  period: PushPeriod
  email?: string
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface DigestSchedulerDeps {
  /** 舆情报告(最新在前,含权限已过滤的全量)。 */
  listReports: () => SavedReport[]
  /** 就业岗位(全量;生成时按在招过滤)。 */
  listJobs: () => JobPosting[]
  sendMail?: (to: string, subject: string, body: string) => Promise<{ ok: boolean; error?: string }>
  notify?: (input: { type: 'push' | 'digest' | 'system'; title: string; body?: string; link?: string; username?: string }) => void
  now?: () => Date
}

const PERIOD_DAYS: Record<PushPeriod, number> = { daily: 1, weekly: 7, monthly: 30 }

const PERIOD_MS: Record<PushPeriod, number> = {
  daily: 24 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
  monthly: 30 * 24 * 3600 * 1000,
}

function now(): string {
  return new Date().toISOString()
}

function genId(prefix: string): string {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

/** 舆情定期汇总:近一周期内的报告(等级/院系/风险/内容摘要)。 */
export function buildReportDigest(config: DigestConfig, reports: SavedReport[], at: Date): string {
  const days = PERIOD_DAYS[config.period]
  const cutoff = new Date(at)
  cutoff.setDate(at.getDate() - days)
  const recent = reports.filter((r) => new Date(r.createdAt).getTime() >= cutoff.getTime())
  const riskLabel: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' }

  const lines = [
    '# 舆情定期汇总(' + PERIOD_LABEL[config.period] + ')',
    '',
    '统计范围:近 ' + days + ' 天 · 报告 ' + recent.length + ' 份',
    '',
  ]
  if (recent.length === 0) {
    lines.push('近 ' + days + ' 天暂无新增舆情报告。')
  }
  recent.slice(0, 20).forEach((r, i) => {
    const risk = r.riskLevel ? ' · ' + riskLabel[r.riskLevel] : ''
    const preview = r.content.replace(/\s+/g, ' ').slice(0, 80)
    lines.push((i + 1) + '. **[' + r.level + '] ' + r.dept + ' · ' + (r.timeRange || '') + '**' + risk)
    lines.push('   ' + preview)
    lines.push('')
  })
  return lines.join('\n')
}

/** 就业信息定期汇总:全部在招岗位。 */
export function buildJobDigest(config: DigestConfig, jobs: JobPosting[], at: Date): string {
  const active = jobs.filter((j) => j.status === 'active')
  const lines = [
    '# 就业信息定期汇总(' + PERIOD_LABEL[config.period] + ')',
    '',
    '生成时间:' + at.toLocaleString('zh-CN') + ' · 在招岗位 ' + active.length + ' 条',
    '',
  ]
  if (active.length === 0) {
    lines.push('当前暂无在招岗位。')
  }
  active.forEach((j, i) => {
    const parts = [
      j.degree, j.major, j.location,
      j.salary ? '薪资:' + j.salary : '',
      j.deadline ? '截止:' + j.deadline : '',
    ].filter(Boolean)
    lines.push((i + 1) + '. **' + j.company + '** — ' + j.position + (parts.length > 0 ? ' (' + parts.join(' / ') + ')' : ''))
    if (j.url) lines.push('   公告:' + j.url)
    lines.push('')
  })
  return lines.join('\n')
}

export class DigestScheduler {
  constructor(
    private readonly storage: Storage,
    private readonly deps: DigestSchedulerDeps
  ) {}

  private readConfigs(): DigestConfig[] {
    return this.storage.readDoc<DigestConfig[]>(CONFIGS_DOC, [])
  }

  private saveConfigs(entries: DigestConfig[]): void {
    this.storage.writeDoc(CONFIGS_DOC, entries)
  }

  private readRuns(): Record<string, string> {
    return this.storage.readDoc<Record<string, string>>(RUNS_DOC, {})
  }

  private markRun(id: string, when: Date): void {
    const runs = this.readRuns()
    runs[id] = when.toISOString()
    this.storage.writeDoc(RUNS_DOC, runs)
  }

  /** 是否到期:无运行记录(首次)或距上次运行超过周期。 */
  isDue(config: DigestConfig, at: Date): boolean {
    const last = this.readRuns()[config.id]
    if (!last) return true
    const lastMs = new Date(last).getTime()
    if (!Number.isFinite(lastMs)) return true
    return at.getTime() - lastMs >= PERIOD_MS[config.period]
  }

  list(): DigestConfig[] {
    return this.readConfigs()
  }

  create(input: { type: DigestType; period: PushPeriod; email?: string; enabled?: boolean }, createdBy: string): DigestConfig {
    const config: DigestConfig = {
      id: genId('digest'),
      type: input.type === 'job' ? 'job' : 'report',
      period: input.period === 'daily' || input.period === 'weekly' || input.period === 'monthly' ? input.period : 'weekly',
      email: input.email?.trim() || undefined,
      enabled: input.enabled !== false,
      createdBy,
      createdAt: now(),
      updatedAt: now(),
    }
    this.saveConfigs([config, ...this.readConfigs()])
    return config
  }

  update(id: string, patch: Record<string, unknown>): DigestConfig | null {
    const configs = this.readConfigs()
    const idx = configs.findIndex((c) => c.id === id)
    if (idx < 0) return null
    const current = configs[idx]
    const next: DigestConfig = {
      ...current,
      type: patch['type'] === 'job' ? 'job' : patch['type'] === 'report' ? 'report' : current.type,
      period: patch['period'] === 'daily' || patch['period'] === 'weekly' || patch['period'] === 'monthly'
        ? (patch['period'] as PushPeriod) : current.period,
      email: patch['email'] !== undefined ? (typeof patch['email'] === 'string' ? patch['email'].trim() || undefined : undefined) : current.email,
      enabled: patch['enabled'] !== undefined ? patch['enabled'] !== false : current.enabled,
      updatedAt: now(),
    }
    configs[idx] = next
    this.saveConfigs(configs)
    return next
  }

  remove(id: string): boolean {
    const configs = this.readConfigs()
    const next = configs.filter((c) => c.id !== id)
    if (next.length === configs.length) return false
    this.saveConfigs(next)
    return true
  }

  /** 立即生成一份汇总(手动触发):返回文本与邮件结果,写运行记录。 */
  async runNow(config: DigestConfig): Promise<{ ok: boolean; digest: string; mail?: string; error?: string }> {
    const at = this.deps.now?.() ?? new Date()
    const digest = config.type === 'job'
      ? buildJobDigest(config, this.deps.listJobs(), at)
      : buildReportDigest(config, this.deps.listReports(), at)

    this.deps.notify?.({
      type: 'digest',
      title: (config.type === 'job' ? '就业信息' : '舆情') + '定期汇总已生成(' + PERIOD_LABEL[config.period] + ')',
      link: config.type === 'job' ? '/jobs' : '/monitor',
    })

    if (this.deps.sendMail && config.email) {
      try {
        const result = await this.deps.sendMail(config.email, '【' + (config.type === 'job' ? '就业信息' : '舆情') + '定期汇总】' + PERIOD_LABEL[config.period], digest)
        if (result.ok) {
          this.markRun(config.id, at)
          return { ok: true, digest, mail: 'sent' }
        }
        this.markRun(config.id, at)
        return { ok: false, digest, mail: 'failed', error: result.error }
      } catch (err) {
        this.markRun(config.id, at)
        return { ok: false, digest, mail: 'failed', error: err instanceof Error ? err.message : '邮件发送异常' }
      }
    }
    this.markRun(config.id, at)
    return { ok: true, digest, mail: config.email ? 'skipped' : undefined }
  }

  /** 执行一轮:遍历启用配置,到期则生成并(可选)发邮件。 */
  async checkDue(): Promise<{ checked: number; generated: number; sent: number; failed: number }> {
    const at = this.deps.now?.() ?? new Date()
    const configs = this.readConfigs().filter((c) => c.enabled)
    let generated = 0
    let sent = 0
    let failed = 0
    for (const config of configs) {
      if (!this.isDue(config, at)) continue
      const result = await this.runNow(config)
      if (result.ok) generated += 1
      else failed += 1
      if (result.mail === 'sent') sent += 1
    }
    return { checked: configs.length, generated, sent, failed }
  }
}
