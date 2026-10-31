import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonStore } from '../src/services/storage.js'
import { NotificationService } from '../src/services/notifications.js'
import { DigestScheduler, buildReportDigest, buildJobDigest, type DigestConfig } from '../src/services/digest-scheduler.js'
import type { SavedReport } from '../src/types.js'
import type { JobPosting } from '../src/services/jobs.js'

function makeNotify() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-notice-'))
  return new NotificationService(new JsonStore(dir))
}

describe('NotificationService', () => {
  it('add/listFor:全员消息人人可见,私有消息仅本人', () => {
    const n = makeNotify()
    n.add({ type: 'system', title: '系统维护', username: undefined })
    n.add({ type: 'push', title: '你的推送', username: 'alice' })
    expect(n.listFor('alice')).toHaveLength(2)
    expect(n.listFor('bob')).toHaveLength(1)
    expect(n.listFor('bob')[0].title).toBe('系统维护')
  })

  it('unreadCount/markRead/clearFor', () => {
    const n = makeNotify()
    n.add({ type: 'system', title: 'A' })
    n.add({ type: 'system', title: 'B' })
    expect(n.unreadCount('alice')).toBe(2)
    const first = n.listFor('alice')[0]
    expect(n.markRead(first.id, 'alice')).toBe(true)
    expect(n.unreadCount('alice')).toBe(1)
    // bob 视角未读不受影响
    expect(n.unreadCount('bob')).toBe(2)
    n.clearFor('alice')
    expect(n.unreadCount('alice')).toBe(0)
    expect(n.unreadCount('bob')).toBe(2)
    // 标记不存在消息
    expect(n.markRead('nope', 'alice')).toBe(false)
  })
})

function makeConfig(): DigestConfig {
  return { id: 'digest-1', type: 'report', period: 'daily', enabled: true, createdBy: 'admin', createdAt: '', updatedAt: '' }
}

function sampleReport(over: Partial<SavedReport> = {}): SavedReport {
  return {
    id: 'r-1', dept: '文学院', timeRange: '今天', content: '学生反映课程难度较高。',
    createdAt: new Date().toISOString(), level: 'college', riskLevel: 'high',
    ...over,
  }
}

function sampleJob(over: Partial<JobPosting> = {}): JobPosting {
  return {
    id: 'j-1', company: '字节跳动', position: '算法工程师', degree: '硕士', location: '深圳',
    deadline: '2026-12-31', source: '官网', status: 'active', createdAt: '', updatedAt: '',
    ...over,
  }
}

describe('DigestScheduler', () => {
  it('buildReportDigest/buildJobDigest 内容与周期过滤', () => {
    const cfg = makeConfig()
    const now = new Date('2026-09-08T00:00:00Z')
    const old = new Date('2026-09-01T00:00:00Z')
    const digest = buildReportDigest(cfg, [sampleReport(), sampleReport({ id: 'r-old', createdAt: old.toISOString(), riskLevel: 'low' })], now)
    expect(digest).toContain('近 1 天')
    expect(digest).toContain('高风险')
    expect(digest).not.toContain('r-old')

    const jobDigest = buildJobDigest({ ...cfg, type: 'job' }, [sampleJob(), sampleJob({ id: 'j-exp', status: 'expired' })], now)
    expect(jobDigest).toContain('字节跳动')
    expect(jobDigest).toContain('在招岗位 1 条')
  })

  it('首次即调度;周期内不重复;注入邮件与通知', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-digest-'))
    const storage = new JsonStore(dir)
    const sent: string[] = []
    const notified: string[] = []
    let clock = new Date('2026-09-08T00:00:00Z')
    const s = new DigestScheduler(storage, {
      listReports: () => [sampleReport()],
      listJobs: () => [sampleJob()],
      sendMail: async (to, _subj) => { sent.push(to); return { ok: true } },
      notify: (input) => notified.push(input.title),
      now: () => clock,
    })
    const cfg = s.create({ type: 'report', period: 'daily', email: 'a@ccnu.edu.cn' }, 'admin')

    const first = await s.checkDue()
    expect(first).toEqual({ checked: 1, generated: 1, sent: 1, failed: 0 })
    expect(sent).toEqual(['a@ccnu.edu.cn'])
    expect(notified[0]).toContain('舆情')

    // 周期内不重复
    clock = new Date('2026-09-08T12:00:00Z')
    const again = await s.checkDue()
    expect(again.generated).toBe(0)

    // 超过 24h 再次触发
    clock = new Date('2026-09-09T01:00:00Z')
    const third = await s.checkDue()
    expect(third.generated).toBe(1)
  })

  it('runNow:无邮件仅生成;邮件失败标记 failed 并写运行记录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-digest2-'))
    const storage = new JsonStore(dir)
    let clock = new Date('2026-09-08T00:00:00Z')
    const s = new DigestScheduler(storage, {
      listReports: () => [],
      listJobs: () => [],
      now: () => clock,
    })
    const cfg = s.create({ type: 'job', period: 'weekly' }, 'admin')
    const res = await s.runNow(cfg)
    expect(res.ok).toBe(true)
    expect(res.digest).toContain('就业信息定期汇总')

    // 失败邮件:注入失败 sendMail
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-digest3-'))
    const s2 = new DigestScheduler(new JsonStore(dir2), {
      listReports: () => [],
      listJobs: () => [],
      sendMail: async () => ({ ok: false, error: 'SMTP down' }),
      notify: () => undefined,
      now: () => clock,
    })
    const cfg2 = s2.create({ type: 'report', period: 'daily', email: 'x@ccnu.edu.cn' }, 'admin')
    const res2 = await s2.runNow(cfg2)
    expect(res2.mail).toBe('failed')
    expect(res2.error).toBe('SMTP down')
  })
})

describe('消息中心与定期汇总路由', () => {
  let app: App
  let base: string

  beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-ntf-route-'))
    const config: ServerConfig = {
      port: 0,
      authToken: 'runtime-token',
      runtimeUrl: 'http://127.0.0.1:59999',
      xhsBin: 'xhs-not-exists',
      agentlyBin: 'agently-not-exists',
      dataDir,
      staticDir: null,
      xvfbArgs: ['-a'],
      adminPassword: 'admin-pass-123',
      sessionTtlMs: 60_000,
      kbModel: 'deepseek-v4-pro',
    }
    app = createApp(config)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const addr = app.server.address() as import('node:net').AddressInfo
    base = 'http://127.0.0.1:' + addr.port
    await app.deps.users.bootstrapAdmin('admin-pass-123')
  })

  afterAll(async () => {
    await app.close()
  })

  async function api(pathname: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token
    const res = await fetch(base + pathname, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = text }
    return { status: res.status, json }
  }

  let admin: string
  let college: string

  beforeAll(async () => {
    const { json } = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } })
    admin = (json as { token: string }).token
    await api('/api/users', { method: 'POST', token: admin, body: { username: 'ntfcollege', password: 'pass-12345', role: 'college', college: '文学院' } })
    const { json: j2 } = await api('/api/auth/login', { method: 'POST', body: { username: 'ntfcollege', password: 'pass-12345' } })
    college = (j2 as { token: string }).token
  })

  it('消息:401 / 全员可见 / 未读计数 / 标记已读 / 清空', async () => {
    const anon = await api('/api/notifications')
    expect(anon.status).toBe(401)

    app.deps.notifications.add({ type: 'system', title: '例行公告' })
    app.deps.notifications.add({ type: 'push', title: '管理员专属', username: 'admin' })

    const adminList = (await api('/api/notifications', { token: admin })).json as Array<{ id: string; title: string }>
    expect(adminList.map((x) => x.title)).toEqual(['管理员专属', '例行公告'])
    const collegeList = (await api('/api/notifications', { token: college })).json as Array<{ id: string; title: string }>
    expect(collegeList.map((x) => x.title)).toEqual(['例行公告'])

    const unread = (await api('/api/notifications/unread-count', { token: college })).json as { count: number }
    expect(unread.count).toBe(1)

    const noticeId = collegeList[0].id
    const read = await api('/api/notifications/' + noticeId + '/read', { method: 'POST', token: college })
    expect(read.status).toBe(200)
    const unread2 = (await api('/api/notifications/unread-count', { token: college })).json as { count: number }
    expect(unread2.count).toBe(0)
    // admin 视角两条仍未读
    const unreadAdmin = (await api('/api/notifications/unread-count', { token: admin })).json as { count: number }
    expect(unreadAdmin.count).toBe(2)

    const clear = await api('/api/notifications', { method: 'DELETE', token: college })
    expect(clear.status).toBe(200)
    const unread3 = (await api('/api/notifications/unread-count', { token: college })).json as { count: number }
    expect(unread3.count).toBe(0)
  })

  it('定期汇总配置:仅 admin;创建/运行(实时汇总)/停用/删除', async () => {
    const forbidden = await api('/api/digests', { token: college })
    expect(forbidden.status).toBe(403)

    const created = await api('/api/digests', {
      method: 'POST', token: admin,
      body: { type: 'job', period: 'weekly', email: 'jobs@ccnu.edu.cn' },
    })
    expect(created.status).toBe(201)
    const id = (created.json as { id: string }).id
    expect((created.json as { period: string }).period).toBe('weekly')

    // 手动立即运行:汇总文本生成;agentlyBin 非空注入 sendMail,邮件工具不存在 → 502 但携带 digest
    const run = await api('/api/digests/' + id + '/run', { method: 'POST', token: admin })
    expect(run.status).toBe(502)
    const runBody = run.json as { digest: string; mail?: string }
    expect(runBody.digest).toContain('就业信息定期汇总')
    expect(runBody.mail).toBe('failed')

    // 停用后可更新
    const patched = await api('/api/digests/' + id, { method: 'PATCH', token: admin, body: { enabled: false, period: 'daily' } })
    expect(patched.status).toBe(200)
    expect((patched.json as { enabled: boolean }).enabled).toBe(false)

    const list = (await api('/api/digests', { token: admin })).json as Array<{ id: string }>
    expect(list).toHaveLength(1)

    const del = await api('/api/digests/' + id, { method: 'DELETE', token: admin })
    expect(del.status).toBe(200)
    const list2 = (await api('/api/digests', { token: admin })).json as Array<{ id: string }>
    expect(list2).toHaveLength(0)
  })
})
