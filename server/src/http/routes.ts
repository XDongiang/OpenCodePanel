import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from '../config.js'
import type { PersonnelService, ReportsService } from '../services/personnel.js'
import { sendReportMail } from '../services/mail.js'
import { runXhs, startQrLogin, killQrLogin } from '../services/xhs.js'
import type { SessionService } from '../services/sessions.js'
import type { UserRecord, UserService } from '../services/users.js'
import { buildAskPrompt, type KbService } from '../services/kb.js'
import { JobsService, JOB_CATEGORIES, type JobCategory, type JobStatus } from '../services/jobs.js'
import { LiteratureProvider } from '../services/literature.js'
import { FundService, PaperService, SubscriptionService, buildPushDigest } from '../services/research.js'
import { PushScheduler } from '../services/push-scheduler.js'
import { DigestScheduler, type DigestType } from '../services/digest-scheduler.js'
import { NotificationService } from '../services/notifications.js'
import { runOcr } from '../services/ocr.js'
import type { RuntimeClient } from '../services/runtime.js'
import { isAdmin, resolveUser } from './auth.js'
import { readJsonBody, sendError, sendJson } from './json.js'
import { proxyRequest } from './proxy.js'
import { serveStatic } from './static.js'

export interface RouteDeps {
  personnel: PersonnelService
  reports: ReportsService
  users: UserService
  sessions: SessionService
  kb: KbService
  jobs: JobsService
  papers: PaperService
  funds: FundService
  subscriptions: SubscriptionService
  literature: LiteratureProvider
  runOcr: typeof runOcr
  pushScheduler: PushScheduler
  digestScheduler: DigestScheduler
  notifications: NotificationService
  runtime: RuntimeClient
}

interface SegmentMatch {
  matched: boolean
  params: Record<string, string>
}

/** /api/xxx/:id 形式的参数路由匹配。 */
function matchSegments(pattern: string[], actual: string[]): SegmentMatch {
  if (pattern.length !== actual.length) return { matched: false, params: {} }
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(actual[i])
    } else if (p !== actual[i]) {
      return { matched: false, params: {} }
    }
  }
  return { matched: true, params }
}

function runtimeReachable(runtimeUrl: string): Promise<boolean> {
  return fetch(`${runtimeUrl}/health`, { signal: AbortSignal.timeout(1500) })
    .then((res) => res.ok)
    .catch(() => false)
}

function scopeOf(user: UserRecord): { role: UserRecord['role']; college?: string } {
  return { role: user.role, college: user.college }
}

function requireAdmin(res: ServerResponse, user: UserRecord): boolean {
  if (isAdmin(user)) return true
  sendError(res, 403, '越权:需要管理员权限')
  return false
}

/**
 * 统一请求入口。返回 true 表示已处理响应。
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  deps: RouteDeps
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  const segments = pathname.split('/').filter(Boolean)
  const method = req.method ?? 'GET'

  try {
    // ── 除 /api/health 与 /api/auth/login|logout 外,一律要求有效用户会话(含 /runtime-api 代理与 /api/auth/me) ──
    const needsAuth =
      (pathname.startsWith('/api/') && pathname !== '/api/health' && pathname !== '/api/auth/login' && pathname !== '/api/auth/logout') ||
      pathname === '/runtime-api' ||
      pathname.startsWith('/runtime-api/')

    const user: UserRecord | null = needsAuth
      ? await resolveUser(req, deps.sessions, deps.users)
      : null
    if (needsAuth && !user) {
      sendError(res, 401, '未登录或会话已过期')
      return true
    }

    // ── Runtime 代理(用户会话鉴权,注入服务器 Runtime 凭证) ──
    if (pathname === '/runtime-api' || pathname.startsWith('/runtime-api/')) {
      const target = pathname.replace(/^\/runtime-api/, '') || '/'
      const qs = url.search
      await proxyRequest(config.runtimeUrl, `${target}${qs}`, req, res, config.authToken)
      return true
    }

    if (!pathname.startsWith('/api/')) {
      // 静态服务(仅生产模式);API-only 模式直接 404
      if (config.staticDir) {
        return serveStatic(config.staticDir, pathname, req, res)
      }
      sendError(res, 404, 'Not Found')
      return true
    }

    // ── health(开放) ──
    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, runtime: { reachable: await runtimeReachable(config.runtimeUrl) } })
      return true
    }

    // ── 认证 ──
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req)
      const username = typeof body['username'] === 'string' ? body['username'].trim() : ''
      const password = typeof body['password'] === 'string' ? body['password'] : ''
      if (!username || !password) {
        sendError(res, 400, '用户名和密码不能为空')
        return true
      }
      const stored = deps.users.getByUsername(username)
      if (!stored || stored.disabled || !(await deps.users.verifyPassword(stored, password))) {
        sendError(res, 401, '用户名或密码错误')
        return true
      }
      const token = deps.sessions.create(stored.id)
      const { salt: _salt, hash: _hash, ...pub } = stored
      sendJson(res, 200, { ok: true, token, user: pub })
      return true
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const authHeader = req.headers['authorization']
      const token = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader.trim())?.[1] : undefined
      if (token) deps.sessions.revoke(token)
      sendJson(res, 200, { ok: true })
      return true
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      if (!user) {
        sendError(res, 401, '未登录或会话已过期')
        return true
      }
      sendJson(res, 200, { ok: true, user })
      return true
    }

    // 以下全部需要用户(已在 needsAuth 分支解析)
    if (!user) {
      sendError(res, 401, '未登录或会话已过期')
      return true
    }

    // ── 邮件(任意已登录用户) ──
    if (pathname === '/api/mail/send-report' && method === 'POST') {
      const body = await readJsonBody(req)
      const result = await sendReportMail(
        {
          to: String(body['to'] ?? ''),
          subject: String(body['subject'] ?? ''),
          body: String(body['body'] ?? ''),
          confirmationToken: typeof body['confirmationToken'] === 'string' ? body['confirmationToken'] : undefined,
        },
        config.agentlyBin
      )
      sendJson(res, 200, { ok: true, result })
      return true
    }


    // ── 消息中心(任意已登录用户;全员消息 + 本人私有消息) ──
    if (pathname === '/api/notifications' && method === 'GET') {
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
      sendJson(res, 200, deps.notifications.listFor(user.username, Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20))
      return true
    }
    if (pathname === '/api/notifications/unread-count' && method === 'GET') {
      sendJson(res, 200, { count: deps.notifications.unreadCount(user.username) })
      return true
    }
    if (pathname === '/api/notifications' && method === 'DELETE') {
      deps.notifications.clearFor(user.username)
      sendJson(res, 200, { ok: true })
      return true
    }
    const noticeById = matchSegments(['api', 'notifications', ':id', 'read'], segments)
    if (noticeById.matched && method === 'POST') {
      const marked = deps.notifications.markRead(noticeById.params['id'] ?? '', user.username)
      sendJson(res, 200, { ok: marked })
      return true
    }

    // ── 舆情/就业定期汇总配置(读/写:仅 admin) ──
    const digestsMatch = matchSegments(['api', 'digests'], segments)
    if (digestsMatch.matched) {
      if (method === 'GET') {
        if (!requireAdmin(res, user)) return true
        sendJson(res, 200, deps.digestScheduler.list())
        return true
      }
      if (method === 'POST') {
        if (!requireAdmin(res, user)) return true
        const body = await readJsonBody(req)
        const type: DigestType = body['type'] === 'job' ? 'job' : body['type'] === 'report' ? 'report' : 'report'
        const period = body['period'] === 'daily' || body['period'] === 'weekly' || body['period'] === 'monthly'
          ? (body['period'] as 'daily' | 'weekly' | 'monthly') : 'weekly'
        sendJson(res, 201, deps.digestScheduler.create({ type, period, email: typeof body['email'] === 'string' ? body['email'] : undefined, enabled: body['enabled'] !== false }, user.username))
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }
    const digestRun = matchSegments(['api', 'digests', ':id', 'run'], segments)
    if (digestRun.matched && method === 'POST') {
      if (!requireAdmin(res, user)) return true
      const config = deps.digestScheduler.list().find((c) => c.id === digestRun.params['id'])
      if (!config) {
        sendError(res, 404, '汇总配置不存在')
        return true
      }
      const result = await deps.digestScheduler.runNow(config)
      sendJson(res, result.ok ? 200 : 502, result)
      return true
    }
    const digestById = matchSegments(['api', 'digests', ':id'], segments)
    if (digestById.matched) {
      if (!requireAdmin(res, user)) return true
      const id = digestById.params['id'] ?? ''
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = deps.digestScheduler.update(id, body)
        if (!updated) {
          sendError(res, 404, '汇总配置不存在')
          return true
        }
        sendJson(res, 200, updated)
        return true
      }
      if (method === 'DELETE') {
        const removed = deps.digestScheduler.remove(id)
        if (!removed) {
          sendError(res, 404, '汇总配置不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 小红书(任意已登录用户) ──

    if (pathname === '/api/xhs/status') {
      sendJson(res, 200, runXhs(config.xhsBin, 'status --json'))
      return true
    }
    if (pathname === '/api/xhs/login') {
      sendJson(res, 200, runXhs(config.xhsBin, 'login', 30000))
      return true
    }
    if (pathname === '/api/xhs/login-qrcode') {
      const result = await startQrLogin(config.xhsBin, config.xvfbArgs)
      sendJson(res, 200, result)
      return true
    }
    if (pathname === '/api/xhs/logout') {
      killQrLogin()
      sendJson(res, 200, runXhs(config.xhsBin, 'logout'))
      return true
    }
    if (pathname === '/api/xhs/cancel') {
      // 终止正在进行的扫码登录进程(前端"取消"按钮调用)
      killQrLogin()
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── 用户管理(仅 admin) ──
    const usersMatch = matchSegments(['api', 'users'], segments)
    if (usersMatch.matched) {
      if (!requireAdmin(res, user)) return true
      if (method === 'GET') {
        sendJson(res, 200, deps.users.list())
        return true
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const created = await deps.users.create({
          username: String(body['username'] ?? ''),
          password: String(body['password'] ?? ''),
          role: String(body['role'] ?? ''),
          college: body['college'] !== undefined ? String(body['college']) : undefined,
        })
        sendJson(res, 201, created)
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const userById = matchSegments(['api', 'users', ':id'], segments)
    if (userById.matched) {
      if (!requireAdmin(res, user)) return true
      const id = userById.params['id'] ?? ''
      if (id === user.id) {
        sendError(res, 400, '不能操作当前登录账号')
        return true
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = await deps.users.update(id, {
          role: body['role'] !== undefined ? String(body['role']) : undefined,
          college: body['college'] !== undefined ? String(body['college']) : undefined,
          password: body['password'] !== undefined ? String(body['password']) : undefined,
          disabled: body['disabled'] !== undefined ? Boolean(body['disabled']) : undefined,
        })
        if (!updated) {
          sendError(res, 404, '用户不存在')
          return true
        }
        sendJson(res, 200, updated)
        return true
      }
      if (method === 'DELETE') {
        const username = deps.users.remove(id)
        if (username === null) {
          sendError(res, 404, '用户不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 人员名单(读:按角色过滤;写:仅 admin) ──
    const personnelMatch = matchSegments(['api', 'personnel'], segments)
    if (personnelMatch.matched) {
      if (method === 'GET') {
        sendJson(res, 200, deps.personnel.listScoped(scopeOf(user)))
        return true
      }
      if (!requireAdmin(res, user)) return true
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const entry = deps.personnel.create(body)
        if (!entry) {
          sendError(res, 400, '人员姓名不能为空')
          return true
        }
        sendJson(res, 201, entry)
        return true
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req)
        const entries = Array.isArray(body['entries']) ? (body['entries'] as unknown[]) : []
        sendJson(res, 200, deps.personnel.replace(entries))
        return true
      }
      if (method === 'DELETE') {
        deps.personnel.clear()
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const bulkMatch = matchSegments(['api', 'personnel', 'bulk'], segments)
    if (bulkMatch.matched && method === 'POST') {
      if (!requireAdmin(res, user)) return true
      const body = await readJsonBody(req)
      const rawEntries = Array.isArray(body['entries']) ? (body['entries'] as unknown[]) : []
      const result = deps.personnel.bulkAdd(rawEntries)
      sendJson(res, 200, { ok: true, added: result.added, entries: result.entries })
      return true
    }

    const personnelById = matchSegments(['api', 'personnel', ':id'], segments)
    if (personnelById.matched) {
      if (!requireAdmin(res, user)) return true
      const id = personnelById.params['id'] ?? ''
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = deps.personnel.update(id, body)
        if (!updated) {
          sendError(res, 404, '人员不存在')
          return true
        }
        sendJson(res, 200, updated)
        return true
      }
      if (method === 'DELETE') {
        const removed = deps.personnel.remove(id)
        if (!removed) {
          sendError(res, 404, '人员不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 舆情报告(读:按角色过滤;写:报告创建/删除按范围,整表替换仅 admin) ──
    const reportsMatch = matchSegments(['api', 'reports'], segments)
    if (reportsMatch.matched) {
      if (method === 'GET') {
        sendJson(res, 200, deps.reports.listScoped(scopeOf(user)))
        return true
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const risk = body['riskLevel']
        if (risk !== undefined && risk !== null && !['low', 'medium', 'high'].includes(String(risk))) {
          sendError(res, 400, '风险等级仅支持 low/medium/high')
          return true
        }
        const report = deps.reports.createScoped(body, scopeOf(user))
        if (!report) {
          sendError(res, 400, '报告内容不能为空')
          return true
        }
        sendJson(res, 201, report)
        return true
      }
      if (method === 'PUT') {
        if (!requireAdmin(res, user)) return true
        const body = await readJsonBody(req)
        const reports = Array.isArray(body['reports']) ? (body['reports'] as unknown[]) : []
        sendJson(res, 200, deps.reports.replace(reports))
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 舆情概览统计(趋势/风险预警面板;须在 /reports/:id 之前匹配) ──
    if (pathname === '/api/reports/summary' && method === 'GET') {
      sendJson(res, 200, deps.reports.summary(scopeOf(user)))
      return true
    }

    const reportById = matchSegments(['api', 'reports', ':id'], segments)
    if (reportById.matched && method === 'DELETE') {
      const removed = deps.reports.removeScoped(reportById.params['id'] ?? '', scopeOf(user))
      if (!removed) {
        sendError(res, 404, '报告不存在')
        return true
      }
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── 就业指导:招聘岗位(读:所有登录用户;写:仅 admin) ──
    const jobsMatch = matchSegments(['api', 'jobs'], segments)
    if (jobsMatch.matched) {
      if (method === 'GET') {
        const q = url.searchParams.get('q') ?? undefined
        const degree = url.searchParams.get('degree') ?? undefined
        const location = url.searchParams.get('location') ?? undefined
        const status = url.searchParams.get('status') as JobStatus | null
        const college = url.searchParams.get('college') ?? undefined
        const category = url.searchParams.get('category') ?? undefined
        sendJson(res, 200, deps.jobs.list({
          q,
          degree,
          location,
          status: status === 'active' || status === 'expired' ? status : undefined,
          college,
          category: (JOB_CATEGORIES as readonly string[]).includes(category ?? '') ? (category as JobCategory) : undefined,
        }))
        return true
      }
      if (!requireAdmin(res, user)) return true
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const entry = deps.jobs.create(body)
        if (!entry) {
          sendError(res, 400, '单位名称与招聘岗位不能为空')
          return true
        }
        sendJson(res, 201, entry)
        return true
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req)
        const entries = Array.isArray(body['entries']) ? (body['entries'] as unknown[]) : []
        sendJson(res, 200, deps.jobs.replace(entries))
        return true
      }
      if (method === 'DELETE') {
        deps.jobs.clear()
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const jobsBulk = matchSegments(['api', 'jobs', 'bulk'], segments)
    if (jobsBulk.matched && method === 'POST') {
      if (!requireAdmin(res, user)) return true
      const body = await readJsonBody(req)
      const rawEntries = Array.isArray(body['entries']) ? (body['entries'] as unknown[]) : []
      const result = deps.jobs.bulkAdd(rawEntries)
      sendJson(res, 200, { ok: true, added: result.added, entries: result.entries })
      return true
    }

    const jobById = matchSegments(['api', 'jobs', ':id'], segments)
    if (jobById.matched) {
      if (!requireAdmin(res, user)) return true
      const id = jobById.params['id'] ?? ''
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = deps.jobs.update(id, body)
        if (!updated) {
          sendError(res, 404, '岗位不存在')
          return true
        }
        sendJson(res, 200, updated)
        return true
      }
      if (method === 'DELETE') {
        const removed = deps.jobs.remove(id)
        if (!removed) {
          sendError(res, 404, '岗位不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 科研助理:文献检索(provider 检索,不持久化) ──
    if (pathname === '/api/research/search' && method === 'POST') {
      const body = await readJsonBody(req)
      const q = String(body['q'] ?? '').trim()
      if (!q) {
        sendError(res, 400, '检索关键词不能为空')
        return true
      }
      const fromYear = typeof body['fromYear'] === 'string' ? body['fromYear'] : undefined
      const toYear = typeof body['toYear'] === 'string' ? body['toYear'] : undefined
      const author = typeof body['author'] === 'string' ? body['author'] : undefined
      const journal = typeof body['journal'] === 'string' ? body['journal'] : undefined
      const type = body['type'] === 'journal' || body['type'] === 'conference' || body['type'] === 'thesis' || body['type'] === 'review'
        ? (body['type'] as 'journal' | 'conference' | 'thesis' | 'review')
        : undefined
      const maxResults = Number.isFinite(Number(body['maxResults'])) ? Number(body['maxResults']) : 20
      try {
        const hits = await deps.literature.search({ q, author, journal, fromYear, toYear, type, maxResults })
        sendJson(res, 200, { ok: true, hits, count: hits.length })
      } catch (err) {
        const message = err instanceof Error ? err.message : '检索服务不可用'
        sendError(res, 502, '文献检索暂时不可用:' + message)
      }
      return true
    }

    // ── 科研助理:基于检索文献生成研究背景/现状综述(对标 PDF 模块三「研究背景与国内外现状整理」) ──
    if (pathname === '/api/research/summarize-literature' && method === 'POST') {
      const body = await readJsonBody(req)
      const question = String(body['question'] ?? '').trim()
      const rawHits = Array.isArray(body['hits']) ? (body['hits'] as unknown[]) : []
      if (!question) {
        sendError(res, 400, '问题/主题不能为空')
        return true
      }
      const hits = rawHits.slice(0, 20).map((h) => {
        const hit = h as Record<string, unknown>
        return {
          title: String(hit['title'] ?? ''),
          authors: Array.isArray(hit['authors']) ? (hit['authors'] as string[]).join(', ') : '',
          year: hit['year'] !== undefined ? String(hit['year']) : '',
          journal: hit['journal'] !== undefined ? String(hit['journal']) : '',
          abstract: typeof hit['abstract'] === 'string' ? hit['abstract'].slice(0, 220) : '',
        }
      })
      const litLines = hits.map((h, i) => {
        const meta = [h.title, h.journal, h.year, h.authors].filter(Boolean).join(' | ')
        return (i + 1) + '. ' + meta + (h.abstract ? ' — 摘要:' + h.abstract : '')
      })
      const prompt = [
        '你是科研写作助理。请基于以下检索到的 ' + hits.length + ' 篇文献,围绕主题「' + question + '」撰写一份「研究背景与国内外现状」综述(Markdown)。',
        '',
        '要求:',
        '1. 先概述该主题的研究背景与意义(2-3 段)',
        '2. 分 2-4 个子方向梳理国内外研究现状,引用下面的文献(按序号标注,如 [1][3]),说明研究脉络与已有结论',
        '3. 指出当前研究的不足/空白(1 段)',
        '4. 给出可进一步探讨的研究问题(2-3 条)',
        '5. 条理清晰,学术化表达,不要编造文献中未出现的信息',
        '',
        '检索到的文献:',
        ...(litLines.length > 0 ? litLines : ['(未提供文献,请基于常识给出该主题的研究背景框架)']),
      ].join('\n')
      try {
        const result = await deps.runtime.ask(prompt, config.kbModel)
        sendJson(res, 200, { ok: true, answer: result.answer, threadId: result.threadId, cited: hits.length })
      } catch (err) {
        const message = err instanceof Error ? err.message : '问答服务不可用'
        sendError(res, 502, '综述生成暂不可用:' + message + '。请确认 CodeWhale Runtime 已启动。')
      }
      return true
    }

    // ── 科研助理:文献收藏(读:全部;写:本人,admin 可删任意) ──
    const papersMatch = matchSegments(['api', 'research', 'papers'], segments)
    if (papersMatch.matched) {
      if (method === 'GET') {
        const q = url.searchParams.get('q') ?? undefined
        const field = url.searchParams.get('field') ?? undefined
        const type = url.searchParams.get('type') ?? undefined
        const year = url.searchParams.get('year') ?? undefined
        const journal = url.searchParams.get('journal') ?? undefined
        sendJson(res, 200, deps.papers.list({ q, field, type, year, journal }))
        return true
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const entry = deps.papers.add(body, user.username)
        if (!entry) {
          sendError(res, 400, '文献标题不能为空或已在收藏中')
          return true
        }
        sendJson(res, 201, entry)
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const papersImport = matchSegments(['api', 'research', 'papers', 'import'], segments)
    if (papersImport.matched && method === 'POST') {
      const body = await readJsonBody(req)
      const rawEntries = Array.isArray(body['entries']) ? (body['entries'] as unknown[]) : []
      let added = 0
      const imported: unknown[] = []
      for (const raw of rawEntries) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = deps.papers.add(raw as Record<string, unknown>, user.username)
        if (entry) {
          added += 1
          imported.push(entry)
        }
      }
      sendJson(res, 200, { ok: true, added, entries: imported })
      return true
    }

    const paperById = matchSegments(['api', 'research', 'papers', ':id'], segments)
    if (paperById.matched && method === 'DELETE') {
      const removed = deps.papers.remove(paperById.params['id'] ?? '', user.username, isAdmin(user))
      if (!removed) {
        sendError(res, 404, '文献不存在或无权删除')
        return true
      }
      sendJson(res, 200, { ok: true })
      return true
    }

    // ── 科研助理:基金项目库(读:全部;写:仅 admin) ──
    const fundsMatch = matchSegments(['api', 'research', 'funds'], segments)
    if (fundsMatch.matched) {
      if (method === 'GET') {
        const q = url.searchParams.get('q') ?? undefined
        const year = url.searchParams.get('year') ?? undefined
        const category = url.searchParams.get('category') ?? undefined
        const status = url.searchParams.get('status') ?? undefined
        sendJson(res, 200, deps.funds.list({ q, year, category, status }))
        return true
      }
      if (!requireAdmin(res, user)) return true
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const entry = deps.funds.create(body)
        if (!entry) {
          sendError(res, 400, '项目名称不能为空')
          return true
        }
        sendJson(res, 201, entry)
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const fundsImport = matchSegments(['api', 'research', 'funds', 'import'], segments)
    if (fundsImport.matched && method === 'POST') {
      if (!requireAdmin(res, user)) return true
      const body = await readJsonBody(req)
      const rawEntries = Array.isArray(body['entries']) ? (body['entries'] as unknown[]) : []
      const result = deps.funds.bulkAdd(rawEntries)
      sendJson(res, 200, { ok: true, added: result.added, entries: result.entries })
      return true
    }

    // ── 科研助理:基金 AI 辅助分析(研究热点/选题/标书/学科代码建议) ──
    if (pathname === '/api/research/funds/analyze' && method === 'POST') {
      const body = await readJsonBody(req)
      const question = String(body['question'] ?? '').trim()
      if (!question) {
        sendError(res, 400, '分析问题不能为空')
        return true
      }
      const projects = deps.funds.summarizeForAnalysis()
      const prompt = [
        '你是国家自然科学基金申报辅导专家。以下是系统中已导入的基金项目数据(已立项/已结题),共 ' + projects.length + ' 项:',
        '',
        ...projects,
        '',
        '用户问题:' + question,
        '',
        '要求:基于以上数据回答,涉及具体项目时标注项目名称;数据不足以回答时明确说明,再结合学科常识给出建议。可包括:研究热点分析 / 选题方向建议 / 标书结构 / 关键词与学科代码建议 / 历年资助趋势。',
      ].join('\n')
      try {
        const result = await deps.runtime.ask(prompt, config.kbModel)
        sendJson(res, 200, { ok: true, answer: result.answer, threadId: result.threadId, projectCount: projects.length })
      } catch (err) {
        const message = err instanceof Error ? err.message : '问答服务不可用'
        sendError(res, 502, '分析服务暂不可用:' + message + '。请确认 CodeWhale Runtime 已启动。')
      }
      return true
    }

    const fundById = matchSegments(['api', 'research', 'funds', ':id'], segments)
    if (fundById.matched) {
      if (!requireAdmin(res, user)) return true
      const id = fundById.params['id'] ?? ''
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = deps.funds.update(id, body)
        if (!updated) {
          sendError(res, 404, '项目不存在')
          return true
        }
        sendJson(res, 200, updated)
        return true
      }
      if (method === 'DELETE') {
        const removed = deps.funds.remove(id)
        if (!removed) {
          sendError(res, 404, '项目不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 科研助理:推送订阅 ──
    const subsMatch = matchSegments(['api', 'research', 'subscriptions'], segments)
    if (subsMatch.matched) {
      if (method === 'GET') {
        sendJson(res, 200, deps.subscriptions.list())
        return true
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const entry = deps.subscriptions.create(body, user.username)
        if (!entry) {
          sendError(res, 400, '订阅名称与至少一个关键词为必填')
          return true
        }
        sendJson(res, 201, entry)
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const subById = matchSegments(['api', 'research', 'subscriptions', ':id'], segments)
    if (subById.matched) {
      const id = subById.params['id'] ?? ''
      const ownerSub = deps.subscriptions.get(id)
      if (ownerSub && !isAdmin(user) && ownerSub.createdBy !== user.username) {
        sendError(res, 403, '不能修改他人的推送订阅')
        return true
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = deps.subscriptions.update(id, body)
        if (!updated) {
          sendError(res, 404, '订阅不存在')
          return true
        }
        sendJson(res, 200, updated)
        return true
      }
      if (method === 'DELETE') {
        const removed = deps.subscriptions.remove(id)
        if (!removed) {
          sendError(res, 404, '订阅不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    // ── 科研助理:立即生成推送简报 ──
    if (pathname === '/api/research/push' && method === 'POST') {
      const body = await readJsonBody(req)
      const subId = String(body['subscriptionId'] ?? '').trim()
      const sub = deps.subscriptions.get(subId)
      if (!sub || !sub.enabled) {
        sendError(res, 404, '订阅不存在或已停用')
        return true
      }
      try {
        const hits = await deps.literature.search({
          q: sub.keywords.join(' '),
          journal: sub.journal,
          maxResults: 10,
        })
        sendJson(res, 200, { ok: true, digest: buildPushDigest(sub, hits), count: hits.length, subscription: sub })
      } catch (err) {
        const message = err instanceof Error ? err.message : '检索服务不可用'
        sendError(res, 502, '推送生成失败:' + message)
      }
      return true
    }

    // ── 科研助理:定时推送日志(调度器产生,最近 20 条) ──
    if (pathname === '/api/research/push-logs' && method === 'GET') {
      sendJson(res, 200, deps.pushScheduler.listLogs(20))
      return true
    }

    // ── 文件知识库 ──

    // 扫描版 PDF OCR(admin;依赖部署机 poppler-utils + tesseract-ocr + chi_sim)
    if (pathname === '/api/kb/ocr' && method === 'POST') {
      if (!requireAdmin(res, user)) return true
      const body = await readJsonBody(req)
      const filename = String(body['filename'] ?? 'scan.pdf')
      const lang = typeof body['lang'] === 'string' && body['lang'].trim() !== '' ? body['lang'] : 'chi_sim+eng'
      const dataBase64 = typeof body['dataBase64'] === 'string' ? body['dataBase64'] : ''
      if (!dataBase64) {
        sendError(res, 400, '缺少文件内容')
        return true
      }
      if (dataBase64.length > 60 * 1024 * 1024) {
        sendError(res, 413, '文件过大(上限约 45MB)')
        return true
      }
      try {
        const pdf = Buffer.from(dataBase64, 'base64')
        if (pdf.length === 0) {
          sendError(res, 400, '文件内容为空')
          return true
        }
        const result = await deps.runOcr(pdf, lang)
        if (!result.ok) {
          sendError(res, result.reason === 'missing-tools' ? 501 : 502, result.message)
          return true
        }
        sendJson(res, 200, { ok: true, filename, text: result.text, pages: result.pages })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'OCR 失败'
        sendError(res, 500, 'OCR 执行失败:' + message)
      }
      return true
    }

    // 制度审查:基于知识库制度文件逐项检查并输出审查报告(admin 触发)
    if (pathname === '/api/kb/review' && method === 'POST') {
      if (!requireAdmin(res, user)) return true
      const body = await readJsonBody(req)
      const scope = body['scope'] === 'college' ? 'college' : body['scope'] === 'school' ? 'school' : undefined
      const college = typeof body['college'] === 'string' && body['college'].trim() !== '' ? body['college'].trim() : undefined
      const materials = deps.kb.reviewMaterials(scope ? { scope, college } : undefined)
      if (materials.length === 0) {
        sendError(res, 400, '没有可审查的制度文件(请先上传文件)')
        return true
      }
      const docLines = materials.map((m, i) => {
        const truncated = m.preview.length < m.charCount ? '(仅节选,全文见知识库)' : ''
        return '【文件 ' + (i + 1) + '】' + m.filename + ' [' + m.scope + (m.college ? '/' + m.college : '') + ',共 ' + m.charCount + ' 字]' + truncated + '\n' + m.preview
      })
      const prompt = [
        '你是高校制度文件审查专家。请对下列制度/管理办法进行合规审查,输出 Markdown 审查报告。',
        '',
        '审查要点(逐项检查并在报告中合并为表格列出):',
        '1. 格式规范:标题、文号、发布/修订日期、生效日期是否齐全',
        '2. 条款完整性:是否缺少适用范围、职责分工、程序步骤、监督与问责等关键章节',
        '3. 表述歧义:是否存在易产生多种理解、执行不一致的表述,并给出修改建议',
        '4. 前后矛盾:同一文件内部条款之间是否存在矛盾',
        '5. 制度间冲突:不同文件之间对同一事项的规定是否冲突(重点)',
        '6. 上位一致性:是否与上级制度(国家/部委/省/学校)精神冲突或明显违反上位规定',
        '7. 废止与时效:是否包含已过期/已废止条款,引用其他文件时是否注明有效版本',
        '8. 责任与流程:是否明确责任部门、办理时限、异议与申诉渠道',
        '9. 关键字段:时间、金额、人数、人员范围等是否明确且合理',
        '',
        '输出结构:## 审查结论(总体评价) / ## 问题清单(表格:文件 | 问题类型 | 具体问题 | 修改建议) / ## 跨文件冲突(如有) / ## 整改优先级。',
        '',
        ...docLines,
      ].join('\n')
      try {
        const result = await deps.runtime.ask(prompt, config.kbModel)
        sendJson(res, 200, {
          ok: true,
          answer: result.answer,
          threadId: result.threadId,
          docCount: materials.length,
          docs: materials.map((m) => ({ filename: m.filename, scope: m.scope, college: m.college })),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : '问答服务不可用'
        sendError(res, 502, '审查服务暂不可用:' + message + '。请确认 CodeWhale Runtime 已启动。')
      }
      return true
    }

    const kbDocs = matchSegments(['api', 'kb', 'documents'], segments)
    if (kbDocs.matched) {
      if (method === 'GET') {
        sendJson(res, 200, deps.kb.listMeta(scopeOf(user)))
        return true
      }
      if (!requireAdmin(res, user)) return true
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const doc = deps.kb.add({
          filename: String(body['filename'] ?? ''),
          college: body['college'] !== undefined ? String(body['college']) : undefined,
          scope: body['scope'] === 'college' ? 'college' : 'school',
          text: String(body['text'] ?? ''),
          uploadedBy: user.username,
        })
        sendJson(res, 201, doc)
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    const kbDocById = matchSegments(['api', 'kb', 'documents', ':id'], segments)
    if (kbDocById.matched) {
      const id = kbDocById.params['id'] ?? ''
      if (method === 'GET') {
        // 下载:按角色可见性返回全文(含页码标记);不可见/不存在统一 404
        const doc = deps.kb.getScoped(id, scopeOf(user))
        if (!doc) {
          sendError(res, 404, '文件不存在或无权下载')
          return true
        }
        sendJson(res, 200, {
          id: doc.id,
          filename: doc.filename,
          college: doc.college ?? null,
          scope: doc.scope,
          uploadedBy: doc.uploadedBy,
          uploadedAt: doc.uploadedAt,
          charCount: doc.charCount,
          content: doc.chunks.join(''),
        })
        return true
      }
      if (method === 'DELETE') {
        if (!requireAdmin(res, user)) return true
        const removed = deps.kb.remove(id)
        if (!removed) {
          sendError(res, 404, '文件不存在')
          return true
        }
        sendJson(res, 200, { ok: true })
        return true
      }
      sendError(res, 405, 'Method Not Allowed')
      return true
    }

    if (pathname === '/api/kb/search' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const topK = Number.parseInt(url.searchParams.get('top_k') ?? '6', 10)
      sendJson(res, 200, { results: deps.kb.search(q, scopeOf(user), Number.isFinite(topK) ? topK : 6) })
      return true
    }

    if (pathname === '/api/kb/ask' && method === 'POST') {
      const body = await readJsonBody(req)
      const question = String(body['question'] ?? '').trim()
      if (!question) {
        sendError(res, 400, '问题不能为空')
        return true
      }
      const hits = deps.kb.search(question, scopeOf(user))
      const prompt = buildAskPrompt(question, hits)
      try {
        const result = await deps.runtime.ask(prompt, config.kbModel)
        sendJson(res, 200, {
          ok: true,
          answer: result.answer,
          threadId: result.threadId,
          sources: hits.map((h) => ({ filename: h.doc.filename, college: h.doc.college ?? null, scope: h.doc.scope, chunks: h.chunks.length })),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : '问答服务不可用'
        sendError(res, 502, `问答服务暂不可用:${message}。请确认 CodeWhale Runtime 已启动。`)
      }
      return true
    }

    sendError(res, 404, 'Not Found')
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : '服务器内部错误'
    console.error(`[${method} ${pathname}]`, err)
    if (!res.headersSent) {
      sendError(res, 400, message)
    } else {
      res.end()
    }
    return true
  }
}
