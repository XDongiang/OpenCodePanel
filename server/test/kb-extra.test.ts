import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { KbService } from '../src/services/kb.js'
import { JsonStore } from '../src/services/storage.js'

describe('KbService.reviewMaterials', () => {
  it('按 scope/college 过滤并节选前文', () => {
    const kb = new KbService(new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-kbr-'))))
    kb.add({ filename: '学校章程.txt', scope: 'school', text: '第一章 总则。'.repeat(60), uploadedBy: 'admin' })
    kb.add({ filename: '文学院细则.txt', scope: 'college', college: '文学院', text: '第一条 本细则适用于文学院。', uploadedBy: 'admin' })
    kb.add({ filename: '历史学院细则.txt', scope: 'college', college: '历史学院', text: '第一条 本细则适用于历史学院。', uploadedBy: 'admin' })

    const all = kb.reviewMaterials()
    expect(all).toHaveLength(3)
    expect(all[0].preview.length).toBeGreaterThan(0)

    const collegeOnly = kb.reviewMaterials({ scope: 'college', college: '文学院' })
    expect(collegeOnly).toHaveLength(1)
    expect(collegeOnly[0].filename).toBe('文学院细则.txt')

    const schoolOnly = kb.reviewMaterials({ scope: 'school' })
    expect(schoolOnly).toHaveLength(1)
  })
})

describe('知识库增强 API 路由(OCR + 制度审查)', () => {
  let app: App
  let base: string

  beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnu-kbr-route-'))
    const config: ServerConfig = {
      port: 0,
      authToken: 'runtime-token',
      runtimeUrl: 'http://127.0.0.1:59999', // 必然不可达:验证审查降级路径
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

  let adminToken = ''

  beforeAll(async () => {
    const { status, json } = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } })
    expect(status).toBe(200)
    adminToken = (json as { token: string }).token
  })

  it('OCR:未登录 401 / 空内容 400 / 注入的 OCR 结果 200', async () => {
    const anon = await api('/api/kb/ocr', { method: 'POST', body: { dataBase64: 'eA==' } })
    expect(anon.status).toBe(401)

    const empty = await api('/api/kb/ocr', { method: 'POST', token: adminToken, body: { filename: 'scan.pdf' } })
    expect(empty.status).toBe(400)

    ;(app.deps.runOcr as unknown as (b: Buffer) => Promise<{ ok: true; text: string; pages: number }>) = async () => ({
      ok: true,
      text: '〔第 1 页〕 识别到的正文内容。',
      pages: 1,
    })
    const ok = await api('/api/kb/ocr', { method: 'POST', token: adminToken, body: { filename: 'scan.pdf', dataBase64: Buffer.from('%PDF-1.4 fake').toString('base64') } })
    expect(ok.status).toBe(200)
    const okBody = ok.json as { ok: boolean; text: string; pages: number }
    expect(okBody.text).toContain('〔第 1 页〕')
    expect(okBody.pages).toBe(1)
  })

  it('制度审查:无文件 400 / 未登录 401 / runtime 不可达 502', async () => {
    const anon = await api('/api/kb/review', { method: 'POST', body: {} })
    expect(anon.status).toBe(401)

    // 空知识库 → 400
    const noDocs = await api('/api/kb/review', { method: 'POST', token: adminToken, body: {} })
    expect(noDocs.status).toBe(400)

    // 先塞入一份文档
    const upload = await api('/api/kb/documents', {
      method: 'POST',
      token: adminToken,
      body: { filename: '实验管理办法.txt', scope: 'school', text: '第一条 本办法适用于本校所有实验室。' },
    })
    expect(upload.status).toBe(201)

    // runtime 不可达 → 502(降级提示)
    const review = await api('/api/kb/review', { method: 'POST', token: adminToken, body: { scope: 'school' } })
    expect(review.status).toBe(502)

    // college 过滤无匹配 → 400(知识库只有 school 文件)
    const miss = await api('/api/kb/review', { method: 'POST', token: adminToken, body: { scope: 'college', college: '文学院' } })
    expect(miss.status).toBe(400)
  })

  it('文件下载:scope/college 可见性(校文件全员;本院文件本院可见;跨院 404)', async () => {
    // 未登录 401
    const anon = await api('/api/kb/documents/x')
    expect(anon.status).toBe(401)

    // 不存在 404
    const missing = await api('/api/kb/documents/nope', { token: adminToken })
    expect(missing.status).toBe(404)

    // 上传学校级 + 文学院级 + 历史学院级
    const school = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '学校章程.txt', scope: 'school', text: '第一章 总则。' },
    })
    const wen = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '文学院制度.txt', scope: 'college', college: '文学院', text: '第一条 文学院细则。' },
    })
    const his = await api('/api/kb/documents', {
      method: 'POST', token: adminToken,
      body: { filename: '历史学院制度.txt', scope: 'college', college: '历史学院', text: '第一条 历史学院细则。' },
    })
    expect(school.status).toBe(201)
    const schoolId = (school.json as { id: string }).id
    const wenId = (wen.json as { id: string }).id
    const hisId = (his.json as { id: string }).id

    // 建院级账号
    await api('/api/users', {
      method: 'POST', token: adminToken,
      body: { username: 'wendoc', password: 'pass-12345', role: 'college', college: '文学院' },
    })
    const { json } = await api('/api/auth/login', { method: 'POST', body: { username: 'wendoc', password: 'pass-12345' } })
    const collegeToken = (json as { token: string }).token

    // 校文件:任何人可下
    const schoolDoc = await api('/api/kb/documents/' + schoolId, { token: collegeToken })
    expect(schoolDoc.status).toBe(200)
    expect((schoolDoc.json as { content: string }).content).toContain('第一章')

    // 本院文件:可下且含全文
    const wenDoc = await api('/api/kb/documents/' + wenId, { token: collegeToken })
    expect(wenDoc.status).toBe(200)
    expect((wenDoc.json as { content: string }).content).toContain('第一条')

    // 跨院文件:404(不下发内容)
    const hisDoc = await api('/api/kb/documents/' + hisId, { token: collegeToken })
    expect(hisDoc.status).toBe(404)
  })
})
