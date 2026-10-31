import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { JsonStore } from '../src/services/storage.js'
import { PushScheduler } from '../src/services/push-scheduler.js'
import type { PushSubscription } from '../src/services/research.js'

function makeStorage() {
  return new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-push-')))
}

function makeSub(over: Partial<PushSubscription>): PushSubscription {
  return {
    id: 'sub-1',
    name: 'AI 方向',
    keywords: ['llm', 'deep learning'],
    period: 'weekly',
    email: 'a@ccnu.edu.cn',
    enabled: true,
    createdBy: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('PushScheduler', () => {
  it('首次运行触发:生成日志、标记运行;同周期内不重复触发', async () => {
    const s = new PushScheduler(makeStorage(), {
      listSubscriptions: () => [makeSub({})],
      search: async () => [{ title: 'T', authors: ['张三'], source: 'stub' }],
    })
    const first = await s.checkDue()
    expect(first.generated).toBe(1)
    expect(first.checked).toBe(1)
    const log = s.listLogs()[0]
    expect(log.status).toBe('generated')
    expect(log.digest).toContain('AI 方向')
    expect(log.count).toBe(1)

    const again = await s.checkDue()
    expect(again.generated).toBe(0)
  })

  it('注入时钟:周期内不触发,超过周期触发', async () => {
    const base = new Date('2026-01-01T00:00:00Z')
    let clock = base
    const s = new PushScheduler(makeStorage(), {
      listSubscriptions: () => [makeSub({ period: 'daily' })],
      search: async () => [{ title: 'T', authors: [], source: 'stub' }],
      now: () => clock,
    })
    await s.checkDue()
    clock = new Date(base.getTime() + 12 * 3600 * 1000)
    const r1 = await s.checkDue()
    expect(r1.generated).toBe(0)
    clock = new Date(base.getTime() + 25 * 3600 * 1000)
    const r2 = await s.checkDue()
    expect(r2.generated).toBe(1)
  })

  it('停用/无邮箱的订阅不调度;sendMail 注入记录 sent / failed', async () => {
    const s = new PushScheduler(makeStorage(), {
      listSubscriptions: () => [
        makeSub({ id: 'a', enabled: false }),
        makeSub({ id: 'b', email: undefined }),
        makeSub({ id: 'c' }),
      ],
      search: async () => [{ title: 'T', authors: [], source: 'stub' }],
      sendMail: async () => ({ ok: true }),
    })
    const r = await s.checkDue()
    expect(r.checked).toBe(1)
    expect(r.sent).toBe(1)
    expect(s.listLogs()[0].status).toBe('sent')

    const s2 = new PushScheduler(makeStorage(), {
      listSubscriptions: () => [makeSub({ id: 'd' })],
      search: async () => [{ title: 'T', authors: [], source: 'stub' }],
      sendMail: async () => ({ ok: false, error: 'SMTP 拒绝' }),
    })
    const r2 = await s2.checkDue()
    expect(r2.failed).toBe(1)
    expect(s2.listLogs()[0].status).toBe('failed')
    expect(s2.listLogs()[0].error).toBe('SMTP 拒绝')
  })

  it('检索失败:跳过且不标记运行(下轮重试)', async () => {
    let calls = 0
    const s = new PushScheduler(makeStorage(), {
      listSubscriptions: () => [makeSub({})],
      search: async () => {
        calls += 1
        throw new Error('网络错误')
      },
    })
    await s.checkDue()
    expect(s.listLogs()).toHaveLength(0)
    await s.checkDue()
    expect(calls).toBe(2)
  })
})

describe('报告风险等级(riskLevel)路由', () => {
  let app: App
  let base: string
  let adminToken = ''

  beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-risk-route-'))
    const config: ServerConfig = {
      port: 0,
      authToken: 'runtime-token',
      runtimeUrl: 'http://127.0.0.1:59999',
      xhsBin: 'xhs-not-exists',
      agentlyBin: 'agently-not-exists',
      dataDir,
      staticDir: null,
      xvfbArgs: ['-a', '-s', '-nolisten unix +extension RANDR'],
      adminPassword: 'admin-pass-123',
      sessionTtlMs: 60_000,
      kbModel: 'deepseek-v4-pro',
    }
    app = createApp(config)
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
    const addr = app.server.address() as AddressInfo
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
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json }
  }

  it('创建报告保留 riskLevel;非法风险等级 400;push-logs 接口可用', async () => {
    const login = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } })
    adminToken = (login.json as { token: string }).token

    const bad = await api('/api/reports', {
      method: 'POST',
      token: adminToken,
      body: { dept: '文学院', timeRange: '今天', content: '内容', level: 'college', riskLevel: '爆炸' },
    })
    expect(bad.status).toBe(400)

    const created = await api('/api/reports', {
      method: 'POST',
      token: adminToken,
      body: { dept: '文学院', timeRange: '今天', content: '存在部分负面讨论', level: 'college', riskLevel: 'high' },
    })
    expect(created.status).toBe(201)
    expect((created.json as { riskLevel: string }).riskLevel).toBe('high')

    const list = await api('/api/reports', { token: adminToken })
    expect((list.json as Array<{ riskLevel?: string }>)[0].riskLevel).toBe('high')

    const logs = await api('/api/research/push-logs', { token: adminToken })
    expect(logs.status).toBe(200)
    expect(logs.json).toBeInstanceOf(Array)
  })
})
