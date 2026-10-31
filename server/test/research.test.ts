import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { JsonStore } from '../src/services/storage.js'
import { PaperService, FundService, SubscriptionService } from '../src/services/research.js'
import { filterHitsByType, type LiteratureHit } from '../src/services/literature.js'
import { LiteratureProvider } from '../src/services/literature.js'

function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-res-'))
  return new JsonStore(dir)
}

describe('filterHitsByType', () => {
  const hits: LiteratureHit[] = [
    { title: 'A survey of deep learning', authors: ['x'], journal: 'CSUR', year: '2024', source: 'crossref', type: 'journal-article' },
    { title: 'Proceedings of ICML 2024', authors: ['y'], journal: 'ICML', year: '2024', source: 'crossref', type: 'proceedings-article' },
    { title: 'PH.D thesis on NLP', authors: ['z'], journal: '', year: '2023', source: 'crossref', type: 'dissertation' },
    { title: 'Regular journal paper', authors: ['w'], journal: 'Nature', year: '2025', source: 's2' },
  ]
  it('按类型过滤', () => {
    expect(filterHitsByType(hits, 'review').map((h) => h.title)).toEqual(['A survey of deep learning'])
    expect(filterHitsByType(hits, 'conference').map((h) => h.title)).toEqual(['Proceedings of ICML 2024'])
    expect(filterHitsByType(hits, 'thesis').map((h) => h.title)).toEqual(['PH.D thesis on NLP'])
    expect(filterHitsByType(hits, 'journal').map((h) => h.title)).toEqual(['Regular journal paper'])
  })
  it('无类型不过滤', () => {
    expect(filterHitsByType(hits)).toHaveLength(4)
  })
})

describe('PaperService', () => {
  it('add 保存并按 DOI/归一化标题去重', () => {
    const papers = new PaperService(makeStorage())
    expect(papers.add({ title: 'A', doi: '10.1/a', source: 'crossref' }, 'alice')).not.toBeNull()
    // DOI 重复
    expect(papers.add({ title: 'A 别名', doi: '10.1/a' }, 'alice')).toBeNull()
    // 标题重复(无 DOI)
    expect(papers.add({ title: 'B', source: 'manual' }, 'alice')).not.toBeNull()
    expect(papers.add({ title: 'B' }, 'alice')).toBeNull()
    expect(papers.list()).toHaveLength(2)
  })

  it('标题为空拒绝', () => {
    const papers = new PaperService(makeStorage())
    expect(papers.add({ title: '  ' }, 'alice')).toBeNull()
    expect(papers.add({}, 'alice')).toBeNull()
  })

  it('remove 仅本人或 admin', () => {
    const papers = new PaperService(makeStorage())
    const mine = papers.add({ title: 'M' }, 'alice')!
    const others = papers.add({ title: 'O' }, 'bob')!
    expect(papers.remove(mine.id, 'bob', false)).toBe(false)
    expect(papers.remove(mine.id, 'alice', false)).toBe(true)
    expect(papers.remove(others.id, 'bob', false)).toBe(true)
    expect(papers.remove('nope', 'alice', true)).toBe(false)
    expect(papers.list()).toHaveLength(0)
  })

  it('list 支持 q/field/year 过滤', () => {
    const papers = new PaperService(makeStorage())
    papers.add({ title: '图神经网络', field: '计算机', year: '2024', journal: 'Nature', authors: ['张三'] }, 'alice')
    papers.add({ title: '教育学评估', field: '教育学', year: '2023' }, 'alice')
    expect(papers.list({ q: '图神经' })).toHaveLength(1)
    expect(papers.list({ field: '教育学' })).toHaveLength(1)
    expect(papers.list({ year: '2024' })).toHaveLength(1)
    expect(papers.list({ journal: 'nature' })).toHaveLength(1)
  })
})

describe('FundService', () => {
  it('create 必填项目名称;list 过滤 year/category/q', () => {
    const funds = new FundService(makeStorage())
    funds.create({ name: '多模态学习', year: '2025', category: '面上项目', code: 'F06', number: '62570001' })
    funds.create({ name: '城市更新', year: '2024', category: '青年项目' })
    expect(funds.create({ name: '  ' })).toBeNull()
    expect(funds.list({ year: '2025' })).toHaveLength(1)
    expect(funds.list({ category: '青年项目' })).toHaveLength(1)
    expect(funds.list({ q: '多模态' })).toHaveLength(1)
  })

  it('bulkAdd 按批准号+名称去重', () => {
    const funds = new FundService(makeStorage())
    funds.create({ name: '现有项目', number: '6257' })
    const result = funds.bulkAdd([
      { name: '现有项目', number: '6257' }, // 重复
      { name: '新项目', number: '6258' },
      { name: '无批准号但重名', number: '' },
      { name: '无批准号但重名', number: '' },
    ])
    expect(result.added).toBe(2)
    expect(funds.list()).toHaveLength(3)
  })

  it('update/remove/clear/summarize', () => {
    const funds = new FundService(makeStorage())
    const a = funds.create({ name: 'A', year: '2024' })!
    const updated = funds.update(a.id, { status: '已结题' })!
    expect(updated.status).toBe('已结题')
    expect(funds.update('nope', {})).toBeNull()
    expect(funds.remove(a.id)).toBe(true)
    expect(funds.remove(a.id)).toBe(false)
    funds.create({ name: 'B', year: '2025' })
    expect(funds.summarizeForAnalysis(10)).toHaveLength(1)
    funds.clear()
    expect(funds.list()).toHaveLength(0)
  })
})

describe('SubscriptionService', () => {
  it('create 需要名称与至少一个关键词', () => {
    const subs = new SubscriptionService(makeStorage())
    expect(subs.create({ name: '无关键词' }, 'alice')).toBeNull()
    const ok = subs.create({ name: 'AI', keywords: ['deep learning', 'LLM'], journal: 'Nature' }, 'alice')!
    expect(ok.period).toBe('weekly')
    expect(ok.keywords).toHaveLength(2)
    expect(ok.createdBy).toBe('alice')
  })

  it('update period/enabled;remove', () => {
    const subs = new SubscriptionService(makeStorage())
    const s = subs.create({ name: 'S', keywords: ['a'] }, 'alice')!
    const updated = subs.update(s.id, { period: 'daily', enabled: false })!
    expect(updated.period).toBe('daily')
    expect(updated.enabled).toBe(false)
    expect(subs.update('nope', {})).toBeNull()
    expect(subs.get(s.id)?.name).toBe('S')
    expect(subs.remove(s.id)).toBe(true)
    expect(subs.remove(s.id)).toBe(false)
  })
})

describe('科研助理 API 路由', () => {
  let app: App
  let base: string

  beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-res-route-'))
    const config: ServerConfig = {
      port: 0,
      authToken: 'runtime-token',
      runtimeUrl: 'http://127.0.0.1:59999', // 必然不可达:验证 AI 分析降级路径
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

  async function login(username: string, password: string): Promise<string> {
    const { status, json } = await api('/api/auth/login', { method: 'POST', body: { username, password } })
    expect(status).toBe(200)
    return (json as { token: string }).token
  }

  it('未登录访问科研接口返回 401', async () => {
    for (const p of ['/api/research/papers', '/api/research/funds', '/api/research/search', '/api/research/subscriptions', '/api/research/push']) {
      const { status } = await api(p)
      expect(status).toBe(401)
    }
  })

  it('文献搜索走 provider(桩);收藏去重', async () => {
    ;(app.deps.literature as unknown as { search: (p: unknown) => Promise<unknown[]> }).search = async () => [
      { title: '假文献', authors: ['张三'], journal: 'Test', year: '2026', doi: '10.1/test', source: 'stub' },
    ]
    const admin = await login('admin', 'admin-pass-123')
    const search = await api('/api/research/search', { method: 'POST', token: admin, body: { q: '测试', maxResults: 10 } })
    expect(search.status).toBe(200)
    const searchBody = search.json as { count: number; hits: Array<{ title: string }> }
    expect(searchBody.count).toBe(1)
    expect(searchBody.hits[0].title).toBe('假文献')

    // 空关键词 400
    const bad = await api('/api/research/search', { method: 'POST', token: admin, body: { q: '  ' } })
    expect(bad.status).toBe(400)

    const save = await api('/api/research/papers', { method: 'POST', token: admin, body: { title: '收藏文献', doi: '10.1/x', source: 'manual' } })
    expect(save.status).toBe(201)
    const dup = await api('/api/research/papers', { method: 'POST', token: admin, body: { title: '收藏文献', doi: '10.1/x' } })
    expect(dup.status).toBe(400)

    const list = await api('/api/research/papers?q=' + encodeURIComponent('收藏'), { token: admin })
    expect((list.json as unknown[])).toHaveLength(1)
  })

  it('基金库 admin 写、他人只读;AI 分析在 runtime 不可达时 502', async () => {
    const admin = await login('admin', 'admin-pass-123')
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { username: 'rescollege', password: 'pass-12345', role: 'college', college: '文学院' },
    })
    const college = await login('rescollege', 'pass-12345')

    const created = await api('/api/research/funds', { method: 'POST', token: admin, body: { name: '多模态', year: '2025' } })
    expect(created.status).toBe(201)

    const deny = await api('/api/research/funds', { method: 'POST', token: college, body: { name: 'X' } })
    expect(deny.status).toBe(403)

    const read = await api('/api/research/funds', { token: college })
    expect((read.json as unknown[])).toHaveLength(1)

    const analyze = await api('/api/research/funds/analyze', { method: 'POST', token: admin, body: { question: '研究热点' } })
    expect(analyze.status).toBe(502) // runtime 不可达 → 降级提示
  })

  it('订阅 CRUD 与推送简报生成(provider 桩)', async () => {
    ;(app.deps.literature as unknown as { search: (p: unknown) => Promise<unknown[]> }).search = async () => [
      { title: '最新论文', authors: ['李四'], journal: 'Nature', year: '2026', source: 'stub' },
    ]
    const admin = await login('admin', 'admin-pass-123')
    const created = await api('/api/research/subscriptions', {
      method: 'POST',
      token: admin,
      body: { name: 'AI 方向', keywords: ['deep learning', 'LLM'], period: 'weekly', email: 'a@ccnu.edu.cn' },
    })
    expect(created.status).toBe(201)
    const id = (created.json as { id: string }).id

    const push = await api('/api/research/push', { method: 'POST', token: admin, body: { subscriptionId: id } })
    expect(push.status).toBe(200)
    const pushBody = push.json as { count: number; digest: string; subscription: { name: string } }
    expect(pushBody.count).toBe(1)
    expect(pushBody.digest).toContain('最新论文')
    expect(pushBody.subscription.name).toBe('AI 方向')

    const patched = await api('/api/research/subscriptions/' + id, { method: 'PATCH', token: admin, body: { period: 'daily', enabled: false } })
    expect(patched.status).toBe(200)
    // 停用后 push 404
    const disabled = await api('/api/research/push', { method: 'POST', token: admin, body: { subscriptionId: id } })
    expect(disabled.status).toBe(404)

    const del = await api('/api/research/subscriptions/' + id, { method: 'DELETE', token: admin })
    expect(del.status).toBe(200)
  })

  it('非本人不能修改他人推送订阅(403)', async () => {
    const admin = await login('admin', 'admin-pass-123')
    const college = await login('rescollege', 'pass-12345')

    const created = await api('/api/research/subscriptions', {
      method: 'POST',
      token: admin,
      body: { name: '文学院阅读', keywords: ['文学理论'], period: 'monthly' },
    })
    expect(created.status).toBe(201)
    const id = (created.json as { id: string }).id

    const denyPatch = await api('/api/research/subscriptions/' + id, { method: 'PATCH', token: college, body: { period: 'daily' } })
    expect(denyPatch.status).toBe(403)
    const denyDelete = await api('/api/research/subscriptions/' + id, { method: 'DELETE', token: college })
    expect(denyDelete.status).toBe(403)

    // 本人(admin)仍可操作
    const okPatch = await api('/api/research/subscriptions/' + id, { method: 'PATCH', token: admin, body: { period: 'daily' } })
    expect(okPatch.status).toBe(200)
    const okDelete = await api('/api/research/subscriptions/' + id, { method: 'DELETE', token: admin })
    expect(okDelete.status).toBe(200)
  })
})
