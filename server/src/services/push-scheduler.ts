import type { Storage } from './storage.js'
import type { LiteratureHit } from './literature.js'
import { buildPushDigest, type PushSubscription } from './research.js'

/**
 * 论文定时推送调度(闭环:采集 → 生成 → 推送)。
 *
 * - 周期:daily 24h / weekly 7d / monthly 30d,以最近一次运行为准;无运行记录则立即可调度
 * - 仅处理 enabled 且配置了 email 的订阅;无邮箱的订阅由页面手动生成简报
 * - 生成结果写入 push-logs(上限 50),sendMail 由部署方注入(agently-cli)
 * - app.ts 以 setInterval(默认 15 分钟)调用 checkDue;测试直接构造并调用 checkDue
 *
 * storage 文档:
 *   push-logs  PushLogEntry[]  (newest first, cap 50)
 *   push-runs  Record<subscriptionId, ISO lastRunAt>
 */

const PUSH_RUNS_DOC = 'push-runs'
const PUSH_LOGS_DOC = 'push-logs'
const MAX_LOGS = 50

const PERIOD_MS: Record<PushSubscription['period'], number> = {
  daily: 24 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
  monthly: 30 * 24 * 3600 * 1000,
}

export const PERIOD_LABEL: Record<PushSubscription['period'], string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

export interface PushLogEntry {
  id: string
  subscriptionId: string
  name: string
  email?: string
  period: PushSubscription['period']
  generatedAt: string
  count: number
  digest: string
  status: 'generated' | 'sent' | 'failed'
  error?: string
}

export interface PushSchedulerDeps {
  listSubscriptions: () => PushSubscription[]
  search: (q: string, journal: string | undefined, maxResults: number) => Promise<LiteratureHit[]>
  sendMail?: (to: string, subject: string, body: string) => Promise<{ ok: boolean; error?: string }>
  notify?: (input: { type: 'push' | 'digest' | 'system'; title: string; body?: string; link?: string; username?: string }) => void
  now?: () => Date
}

function now(): string {
  return new Date().toISOString()
}

function genId(): string {
  return 'push-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

export class PushScheduler {
  constructor(
    private readonly storage: Storage,
    private readonly deps: PushSchedulerDeps
  ) {}

  private readLogs(): PushLogEntry[] {
    return this.storage.readDoc<PushLogEntry[]>(PUSH_LOGS_DOC, [])
  }

  private saveLogs(entries: PushLogEntry[]): void {
    this.storage.writeDoc(PUSH_LOGS_DOC, entries.slice(0, MAX_LOGS))
  }

  private readRuns(): Record<string, string> {
    return this.storage.readDoc<Record<string, string>>(PUSH_RUNS_DOC, {})
  }

  private markRun(subscriptionId: string, when: Date): void {
    const runs = this.readRuns()
    runs[subscriptionId] = when.toISOString()
    this.storage.writeDoc(PUSH_RUNS_DOC, runs)
  }

  /** 是否到期:无运行记录(首次)或距上次运行超过周期。 */
  isDue(sub: PushSubscription, at: Date): boolean {
    const runs = this.readRuns()
    const last = runs[sub.id]
    if (!last) return true
    const lastMs = new Date(last).getTime()
    if (!Number.isFinite(lastMs)) return true
    return at.getTime() - lastMs >= PERIOD_MS[sub.period]
  }

  /** 最近推送日志(新→旧)。 */
  listLogs(limit = 20): PushLogEntry[] {
    return this.readLogs().slice(0, Math.min(Math.max(limit, 1), 50))
  }

  /** 执行一轮:遍历启用的带邮箱订阅,到期则生成简报并记录;sendMail 配置后自动发送。 */
  async checkDue(): Promise<{ checked: number; generated: number; sent: number; failed: number; skipped: number }> {
    const at = this.deps.now?.() ?? new Date()
    const subs = this.deps.listSubscriptions().filter((s) => s.enabled && !!s.email)
    let generated = 0
    let sent = 0
    let failed = 0
    let skipped = 0

    for (const sub of subs) {
      if (!this.isDue(sub, at)) continue
      let hits: LiteratureHit[]
      try {
        hits = await this.deps.search(sub.keywords.join(' '), sub.journal, 10)
      } catch {
        skipped += 1 // 检索失败:不标记运行,下轮重试
        continue
      }

      const digest = buildPushDigest(sub, hits)
      this.deps.notify?.({
        type: 'push',
        title: '论文推送已生成:' + sub.name,
        body: '共 ' + hits.length + ' 条文献' + (sub.email ? ' · ' + sub.email : ''),
        link: '/research',
        username: sub.createdBy,
      })
      const entry: PushLogEntry = {
        id: genId(),
        subscriptionId: sub.id,
        name: sub.name,
        email: sub.email,
        period: sub.period,
        generatedAt: at.toISOString(),
        count: hits.length,
        digest,
        status: 'generated',
      }

      if (this.deps.sendMail && sub.email) {
        try {
          const result = await this.deps.sendMail(sub.email, '【论文推送】' + sub.name + ' · ' + PERIOD_LABEL[sub.period], digest)
          if (result.ok) {
            entry.status = 'sent'
            sent += 1
            this.deps.notify?.({
              type: 'push',
              title: '论文推送已发送:' + sub.name,
              body: '简报已发送至 ' + sub.email,
              link: '/research',
              username: sub.createdBy,
            })
          } else {
            entry.status = 'failed'
            entry.error = result.error
            failed += 1
            this.deps.notify?.({
              type: 'push',
              title: '论文推送邮件发送失败:' + sub.name,
              body: result.error ?? '未知错误',
              link: '/research',
              username: sub.createdBy,
            })
          }
        } catch (err) {
          entry.status = 'failed'
          entry.error = err instanceof Error ? err.message : '邮件发送异常'
          failed += 1
          this.deps.notify?.({
            type: 'push',
            title: '论文推送邮件发送失败:' + sub.name,
            body: entry.error,
            link: '/research',
            username: sub.createdBy,
          })
        }
      } else {
        generated += 1
      }

      this.saveLogs([entry, ...this.readLogs()])
      this.markRun(sub.id, at)
    }

    return { checked: subs.length, generated, sent, failed, skipped }
  }
}
