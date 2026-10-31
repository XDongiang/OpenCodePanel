import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JsonStore } from '../src/services/storage.js'
import { JobsService, classifyJob, JOB_CATEGORIES, type JobPosting } from '../src/services/jobs.js'

function makeJobs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-jobs-'))
  const storage = new JsonStore(dir)
  return new JobsService(storage)
}

function sample(over: Partial<JobPosting> = {}): Record<string, unknown> {
  return {
    company: '示例集团',
    position: '产品经理',
    major: '计算机',
    degree: '本科',
    location: '武汉',
    deadline: '2026-12-31',
    source: '企业官网',
    ...over,
  }
}

describe('JobsService', () => {
  it('create 生成 id 并保存,必填字段缺一拒绝', () => {
    const jobs = makeJobs()
    const entry = jobs.create(sample())
    expect(entry).not.toBeNull()
    expect(entry!.id).toMatch(/^job-\d+-/)
    expect(entry!.company).toBe('示例集团')
    expect(jobs.list()).toHaveLength(1)
    expect(jobs.create({ company: '缺岗位' })).toBeNull()
    expect(jobs.create({ position: '缺单位' })).toBeNull()
    expect(jobs.list()).toHaveLength(1)
  })

  it('list 支持关键词/学历/地点/状态/学院过滤', () => {
    const jobs = makeJobs()
    jobs.create(sample({ company: '腾讯', position: '算法工程师', degree: '硕士' }))
    jobs.create(sample({ company: '华师附中', position: '教师', degree: '本科', location: '武汉' }))
    jobs.create(sample({ company: '某研究院', position: '科研助理', degree: '博士', location: '北京', college: '文学院' }))
    expect(jobs.list({ q: '教师' })).toHaveLength(1)
    expect(jobs.list({ q: '腾讯' })[0].position).toBe('算法工程师')
    expect(jobs.list({ degree: '硕士' })).toHaveLength(1)
    expect(jobs.list({ location: '武汉' })).toHaveLength(2)
    expect(jobs.list({ college: '文学院' })).toHaveLength(1)
  })

  it('classifyJob 重点岗位八大类自动归类', () => {
    expect(classifyJob({ company: '字节跳动', position: '算法工程师' })).toBe('大型互联网企业')
    expect(classifyJob({ company: '国家电网', position: '客户经理' })).toBe('国有企业')
    expect(classifyJob({ company: '武汉大学', position: '专任教师' })).toBe('高校行政及科研岗位')
    expect(classifyJob({ company: '华中师范大学附属中学', position: '数学教师' })).toBe('教师编制岗位')
    expect(classifyJob({ company: '中国科学院武汉分院', position: '助理研究员' })).toBe('科研院所')
    expect(classifyJob({ company: '湖北省人民政府', position: '选调生' })).toBe('公务员及选调生')
    expect(classifyJob({ company: '协和医院', position: '护士' })).toBe('医疗教育AI等重点行业')
    expect(classifyJob({ company: '某勘察设计院', position: '工程师' })).toBe('其他')
    expect(classifyJob({})).toBe('其他')
    expect(JOB_CATEGORIES).toHaveLength(9)
  })

  it('create/import 自动推断 category,显式分类优先', () => {
    const jobs = makeJobs()
    const auto = jobs.create(sample({ company: '腾讯' }))
    expect(auto!.category).toBe('大型互联网企业')
    const explicit = jobs.create(sample({ company: '某外企', position: '顾问', category: '其他' }))
    expect(explicit!.category).toBe('其他')
    expect(jobs.list({ category: '大型互联网企业' })).toHaveLength(1)
    expect(jobs.list({ category: '其他' })).toHaveLength(1)
  })

  it('过期 deadline 自动失效,手动 expired 优先', () => {
    const jobs = makeJobs()
    jobs.create(sample({ deadline: '2020-01-01' }))
    jobs.create(sample({ company: 'B', deadline: '2026-12-31' }))
    jobs.create(sample({ company: 'C', deadline: '2026-12-31', status: 'expired' }))
    const active = jobs.list({ status: 'active' })
    const expired = jobs.list({ status: 'expired' })
    expect(active.map((j) => j.company)).toEqual(['B'])
    expect(expired.map((j) => j.company)).toEqual(['C', '示例集团'])
  })

  it('bulkAdd 按单位+岗位+截止去重', () => {
    const jobs = makeJobs()
    jobs.create(sample())
    const result = jobs.bulkAdd([
      sample(), // 与已存在相同,跳过
      sample({ company: '新单位' }),
      sample({ company: '新单位', position: '另一岗位' }),
    ])
    expect(result.added).toBe(2)
    expect(jobs.list()).toHaveLength(3)
  })

  it('update 改公司/状态并更新时间戳', () => {
    const jobs = makeJobs()
    const created = jobs.create(sample())!
    const updated = jobs.update(created.id, { status: 'expired', location: '上海' })!
    expect(updated.status).toBe('expired')
    expect(updated.location).toBe('上海')
    expect(jobs.update('nope', {})).toBeNull()
  })

  it('remove / clear / replace', () => {
    const jobs = makeJobs()
    const a = jobs.create(sample())!
    jobs.create(sample({ company: 'B' }))
    expect(jobs.remove(a.id)).toBe(true)
    expect(jobs.remove(a.id)).toBe(false)
    jobs.clear()
    expect(jobs.list()).toHaveLength(0)
    jobs.replace([sample({ company: 'X' }), { position: '缺单位' }])
    const list = jobs.list()
    expect(list).toHaveLength(1)
    expect(list[0].company).toBe('X')
  })
})

describe('Jobs API 路由', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let base: string

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-jobs-route-'))
    const config: ServerConfig = {
      port: 0,
      authToken: 'runtime-token',
      runtimeUrl: 'http://127.0.0.1:59999',
      xhsBin: 'xhs-not-exists',
      agentlyBin: 'agently-not-exists',
      dataDir: dir,
      staticDir: null,
      xvfbArgs: ['-a', '-s', '-nolisten unix +extension RANDR'],
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

  it('未登录访问 /api/jobs 返回 401', async () => {
    const { status } = await api('/api/jobs')
    expect(status).toBe(401)
  })

  it('admin 可增删改查与筛选;非 admin 只读', async () => {
    const admin = await login('admin', 'admin-pass-123')
    const created = await api('/api/jobs', {
      method: 'POST',
      token: admin,
      body: { company: '腾讯', position: '算法工程师', degree: '硕士', location: '深圳' },
    })
    expect(created.status).toBe(201)
    const id = (created.json as { id: string }).id

    // 缺必填字段 400
    const bad = await api('/api/jobs', { method: 'POST', token: admin, body: { company: '只有单位' } })
    expect(bad.status).toBe(400)

    // 读取与筛选
    const list = await api('/api/jobs?q=' + encodeURIComponent('腾讯'), { token: admin })
    expect((list.json as unknown[])).toHaveLength(1)

    // admin 更新/删除
    const patched = await api('/api/jobs/' + id, { method: 'PATCH', token: admin, body: { status: 'expired' } })
    expect(patched.status).toBe(200)
    expect((patched.json as { status: string }).status).toBe('expired')
    const del = await api('/api/jobs/' + id, { method: 'DELETE', token: admin })
    expect(del.status).toBe(200)
  })

  it('院级用户只能读不能写', async () => {
    const admin = await login('admin', 'admin-pass-123')
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { username: 'wenjob', password: 'pass-12345', role: 'college', college: '文学院' },
    })
    const collegeToken = await login('wenjob', 'pass-12345')
    const list = await api('/api/jobs', { token: collegeToken })
    expect(list.status).toBe(200)
    const write = await api('/api/jobs', { method: 'POST', token: collegeToken, body: { company: 'X', position: 'Y' } })
    expect(write.status).toBe(403)
    const bulk = await api('/api/jobs/bulk', {
      method: 'POST',
      token: collegeToken,
      body: { entries: [{ company: 'X', position: 'Y' }] },
    })
    expect(bulk.status).toBe(403)
  })

  it('bulk 导入按重复键跳过', async () => {
    const admin = await login('admin', 'admin-pass-123')
    const first = await api('/api/jobs', { method: 'POST', token: admin, body: { company: '华为', position: '软件工程师', deadline: '2026-12-31' } })
    expect(first.status).toBe(201)
    const bulk = await api('/api/jobs/bulk', {
      method: 'POST',
      token: admin,
      body: {
        entries: [
          { company: '华为', position: '软件工程师', deadline: '2026-12-31' }, // 与已有重复
          { company: '华为', position: '硬件工程师', deadline: '2026-12-31' },
        ],
      },
    })
    expect(bulk.status).toBe(200)
    const result = bulk.json as { added: number }
    expect(result.added).toBe(1)
  })
})
