import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApp, type App } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'

let app: App
let base: string

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-route-'))
  const config: ServerConfig = {
    port: 0,
    authToken: 'runtime-token',
    runtimeUrl: 'http://127.0.0.1:59999', // 必然不可达,验证代理错误路径
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
  base = `http://127.0.0.1:${addr.port}`
  // 显式创建初始管理员(等价于 bootstrap 引导)
  await app.deps.users.bootstrapAdmin('admin-pass-123')
})

afterAll(async () => {
  await app.close()
})

async function api(pathname: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
  const res = await fetch(`${base}${pathname}`, {
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
  const { status, json } = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  expect(status).toBe(200)
  return (json as { token: string }).token
}

describe('认证', () => {
  it('health 开放访问', async () => {
    const { status } = await api('/api/health')
    expect(status).toBe(200)
  })

  it('未登录访问受保护接口返回 401', async () => {
    for (const p of ['/api/personnel', '/api/reports', '/api/users', '/runtime-api/v1/threads']) {
      const { status } = await api(p)
      expect(status).toBe(401)
    }
  })

  it('登录成功返回 token 与用户信息,错误密码 401', async () => {
    const { status, json } = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin-pass-123' },
    })
    expect(status).toBe(200)
    const body = json as { token: string; user: { username: string; role: string } }
    expect(body.token).toBeTruthy()
    expect(body.user.username).toBe('admin')
    expect(body.user.role).toBe('admin')

    const bad = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })
    expect(bad.status).toBe(401)
  })

  it('me 返回当前用户;登出后 token 失效', async () => {
    const token = await login('admin', 'admin-pass-123')
    const me = await api('/api/auth/me', { token })
    expect(me.status).toBe(200)
    expect((me.json as { user: { username: string } }).user.username).toBe('admin')

    await api('/api/auth/logout', { method: 'POST', token })
    const after = await api('/api/auth/me', { token })
    expect(after.status).toBe(401)
  })
})

describe('RBAC:人员名单', () => {
  let adminToken: string
  let collegeToken: string

  beforeAll(async () => {
    adminToken = await login('admin', 'admin-pass-123')
    await api('/api/personnel', {
      method: 'PUT',
      token: adminToken,
      body: {
        entries: [
          { id: 'stu-1', name: '张三', level: 'college' as const, category: '院领导', college: '文学院' },
          { id: 'stu-2', name: '李四', level: 'individual' as const, category: '个人', college: '物理学院' },
          { id: 'stu-3', name: '校长', level: 'school' as const, category: '校领导' },
          { id: 'stu-4', name: '王五', level: 'college' as const, category: '院领导', college: '文学院' },
        ],
      },
    })
    // 建院级账号并登录
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'wenyuan', password: 'pass-12345', role: 'college', college: '文学院' },
    })
    collegeToken = await login('wenyuan', 'pass-12345')
  })

  it('admin 看到全部', async () => {
    const { json } = await api('/api/personnel', { token: adminToken })
    expect((json as { entries: unknown[] }).entries).toHaveLength(4)
  })

  it('院级只看到本学院条目', async () => {
    const { json } = await api('/api/personnel', { token: collegeToken })
    const entries = (json as { entries: Array<{ name: string }> }).entries
    expect(entries.map((e) => e.name)).toEqual(['张三', '王五'])
  })

  it('院级不能写名单', async () => {
    for (const opts of [
      { method: 'POST', body: { name: 'x', level: 'college' } },
      { method: 'PUT', body: { entries: [] } },
      { method: 'DELETE' },
    ]) {
      const { status } = await api('/api/personnel', { token: collegeToken, ...opts })
      expect(status).toBe(403)
    }
  })

  it('bulk 批量导入(回归:bulk 路由不能被 :id 遮蔽)', async () => {
    const result = await api('/api/personnel/bulk', {
      method: 'POST',
      token: adminToken,
      body: { entries: [{ name: '批量甲' }, { name: '批量乙' }] },
    })
    expect(result.status).toBe(200)
    const body = result.json as { added: number }
    expect(body.added).toBe(2)
  })
})

describe('RBAC:报告', () => {
  let adminToken: string
  let collegeToken: string

  beforeAll(async () => {
    adminToken = await login('admin', 'admin-pass-123')
    collegeToken = await login('wenyuan', 'pass-12345')
    await api('/api/reports', {
      method: 'PUT',
      token: adminToken,
      body: {
        reports: [
          { id: 'r-1', dept: '文学院', level: 'college' as const, content: '文学院报告' },
          { id: 'r-2', dept: '物理学院', level: 'college' as const, content: '物理学院报告' },
          { id: 'r-3', dept: '校长', level: 'individual' as const, content: '个人报告' },
        ],
      },
    })
  })

  it('admin 看到全部,院级只看到本院学院级报告', async () => {
    const all = (await api('/api/reports', { token: adminToken })).json as Array<{ id: string }>
    expect(all.map((r) => r.id)).toEqual(['r-1', 'r-2', 'r-3'])

    const scoped = (await api('/api/reports', { token: collegeToken })).json as Array<{ id: string }>
    expect(scoped.map((r) => r.id)).toEqual(['r-1'])
  })

  it('概览统计:风险等级计数与院级范围隔离', async () => {
    const adminSum = (await api('/api/reports/summary', { token: adminToken })).json as {
      total: number; byRisk: { low: number; medium: number; high: number }; last7: { date: string; count: number }[]
    }
    expect(adminSum.total).toBe(3)
    // riskLevel 缺省记为中风险
    expect(adminSum.byRisk.medium).toBe(3)
    expect(adminSum.byRisk.high).toBe(0)
    // 近 7 天包含今天,且今天的报告数是 0(报告创建于 beforeAll 的当天之外无法断言;仅验证结构)
    expect(adminSum.last7.length).toBe(7)
    expect(adminSum.last7[6].date).toBe(new Date().toISOString().slice(0, 10))

    // 院级只统计本院报告(r-1 一条)
    const collegeSum = (await api('/api/reports/summary', { token: collegeToken })).json as { total: number }
    expect(collegeSum.total).toBe(1)
  })

  it('院级只能创建本学院报告,跨学院被拒', async () => {
    const ok = await api('/api/reports', { method: 'POST', token: collegeToken, body: { dept: '文学院', level: 'college', content: '本院新报告' } })
    expect(ok.status).toBe(201)

    const bad = await api('/api/reports', { method: 'POST', token: collegeToken, body: { dept: '物理学院', level: 'college', content: '越权' } })
    expect(bad.status).toBe(400)

    const personal = await api('/api/reports', { method: 'POST', token: collegeToken, body: { dept: '张三', level: 'individual', content: '个人' } })
    expect(personal.status).toBe(400)
  })

  it('院级不能删除他人报告,不能整表替换', async () => {
    const del = await api('/api/reports/r-2', { method: 'DELETE', token: collegeToken })
    expect(del.status).toBe(400)

    const put = await api('/api/reports', { method: 'PUT', token: collegeToken, body: { reports: [] } })
    expect(put.status).toBe(403)
  })
})

describe('RBAC:用户管理', () => {
  let adminToken: string
  let collegeToken: string

  beforeAll(async () => {
    adminToken = await login('admin', 'admin-pass-123')
    collegeToken = await login('wenyuan', 'pass-12345')
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'school1', password: 'pass-12345', role: 'school' },
    })
  })

  it('非 admin 不能访问用户管理', async () => {
    const { status } = await api('/api/users', { token: collegeToken })
    expect(status).toBe(403)
  })

  it('admin 列出/创建/改密/禁用用户', async () => {
    const list = (await api('/api/users', { token: adminToken })).json as Array<{ username: string }>
    expect(list.map((u) => u.username)).toContain('school1')

    const created = (await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'school2', password: 'pass-12345', role: 'school' },
    })).json as { id: string }

    const patched = await api(`/api/users/${created.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { disabled: true },
    })
    expect(patched.status).toBe(200)
    expect((patched.json as { disabled: boolean }).disabled).toBe(true)
  })

  it('不能操作自身', async () => {
    const admin = (await api('/api/auth/me', { token: adminToken })).json as { user: { id: string } }
    const { status } = await api(`/api/users/${admin.user.id}`, { method: 'DELETE', token: adminToken })
    expect(status).toBe(400)
  })
})


describe('RBAC:知识库', () => {
  let adminToken: string
  let schoolToken: string
  let collegeToken: string
  let wenyuanToken: string

  beforeAll(async () => {
    adminToken = await login('admin', 'admin-pass-123')
    schoolToken = await login('school1', 'pass-12345')
    wenyuanToken = await login('wenyuan', 'pass-12345')
    // 建一个物院账号(wenyuan 已是文学院)
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'wuyuan', password: 'pass-12345', role: 'college', college: '物理学院' },
    })
    collegeToken = await login('wuyuan', 'pass-12345')
  })

  it('admin 上传全校/学院级文件', async () => {
    const r1 = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '差旅管理办法.txt', scope: 'school', text: '差旅费报销办法。出差人员需凭发票报销差旅费。' },
    })
    expect(r1.status).toBe(201)
    const r2 = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '文学院考勤细则.txt', scope: 'college', college: '文学院', text: '文学院考勤管理细则。考勤迟到扣分。' },
    })
    expect(r2.status).toBe(201)
    const r3 = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '物理学院考勤细则.txt', scope: 'college', college: '物理学院', text: '物理学院考勤管理细则。考勤迟到扣分。' },
    })
    expect(r3.status).toBe(201)
  })

  it('空内容文件被拒', async () => {
    const r = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '空.txt', scope: 'school', text: '   ' },
    })
    expect(r.status).toBe(400)
  })

  it('列表按角色过滤:校级全部,院级仅全校+本院', async () => {
    const schoolDocs = (await api('/api/kb/documents', { token: schoolToken })).json as Array<{ filename: string }>
    expect(schoolDocs.map((d) => d.filename).sort()).toEqual(['文学院考勤细则.txt', '差旅管理办法.txt', '物理学院考勤细则.txt'].sort())

    const wenDocs = (await api('/api/kb/documents', { token: wenyuanToken })).json as Array<{ filename: string }>
    expect(wenDocs.map((d) => d.filename).sort()).toEqual(['文学院考勤细则.txt', '差旅管理办法.txt'].sort())

    const wuDocs = (await api('/api/kb/documents', { token: collegeToken })).json as Array<{ filename: string }>
    expect(wuDocs.map((d) => d.filename).sort()).toEqual(['物理学院考勤细则.txt', '差旅管理办法.txt'].sort())
  })

  it('search 按角色过滤且命中', async () => {
    const all = (await api('/api/kb/search?q=' + encodeURIComponent('差旅费'), { token: schoolToken })).json as { results: Array<{ doc: { filename: string } }> }
    expect(all.results.map((r) => r.doc.filename)).toEqual(['差旅管理办法.txt'])

    const wen = (await api('/api/kb/search?q=' + encodeURIComponent('考勤'), { token: wenyuanToken })).json as { results: Array<{ doc: { filename: string } }> }
    expect(wen.results.map((r) => r.doc.filename)).toContain('文学院考勤细则.txt')
    expect(wen.results.map((r) => r.doc.filename)).not.toContain('物理学院考勤细则.txt')
  })

  it('非 admin 不能上传/删除文件', async () => {
    const post = await api('/api/kb/documents', {
      method: 'POST', token: schoolToken,
      body: { filename: 'x.txt', scope: 'school', text: '内容' },
    })
    expect(post.status).toBe(403)

    const first = ((await api('/api/kb/documents', { token: schoolToken })).json as Array<{ id: string }>)[0]
    const del = await api(`/api/kb/documents/${first.id}`, { method: 'DELETE', token: wenyuanToken })
    expect(del.status).toBe(403)
  })

  it('ask 在 Runtime 不可达时给出明确错误', async () => {
    const r = await api('/api/kb/ask', {
      method: 'POST', token: schoolToken,
      body: { question: '差旅费怎么报销?' },
    })
    expect(r.status).toBe(502)
    expect((r.json as { error: string }).error).toMatch(/Runtime/)
  })
})

describe('代理与路由兜底', () => {
  it('runtime 代理要求登录且不可达时返回 502', async () => {
    const token = await login('admin', 'admin-pass-123')
    const res = await api('/runtime-api/v1/threads', { token })
    expect(res.status).toBe(502)
    expect((res.json as { error: string }).error).toMatch(/Runtime/)
  })

  it('未知 API 返回 404', async () => {
    const token = await login('admin', 'admin-pass-123')
    const { status } = await api('/api/nope', { token })
    expect(status).toBe(404)
  })
})
