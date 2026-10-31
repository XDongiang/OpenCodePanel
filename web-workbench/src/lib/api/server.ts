import type { AppNotification, DigestConfig, FundProject, JobCategory, JobPosting, JobStatus, LiteratureHit, PaperRecord, PersonEntry, PersonnelLevel, PushPeriod, PushSubscription, ReportLevel, ReportSummary } from '../../types'

/**
 * 华师 AI Server API 客户端。
 * 所有请求走相对路径(/api/*),开发模式由 Vite 代理到 server,生产模式同源。
 * token 通过 setServerToken 注入(与 settings-store 单向关联,避免循环依赖)。
 */

let currentToken: string = ''

export function setServerToken(token: string): void {
  currentToken = token
}

/** 401 统一处理(由 App 挂载方注册:清除会话并跳转登录)。 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

export interface AuthUser {
  id: string
  username: string
  role: 'admin' | 'school' | 'college'
  college?: string
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ServerPersonnelDB {
  version: number
  updatedAt: string
  entries: PersonEntry[]
}

export interface ServerReport {
  id: string
  dept: string
  timeRange: string
  content: string
  createdAt: string
  threadId?: string
  level: ReportLevel
  personName?: string
  riskLevel?: 'low' | 'medium' | 'high'
}

export interface PushLogEntry {
  id: string
  subscriptionId: string
  name: string
  email?: string
  period: 'daily' | 'weekly' | 'monthly'
  generatedAt: string
  count: number
  digest: string
  status: 'generated' | 'sent' | 'failed'
  error?: string
}

export interface SendMailPayload {
  to: string
  subject: string
  body: string
  confirmationToken?: string
}

export interface SendMailResponse {
  ok: boolean
  result?: {
    action?: string
    attachment_count?: number
    from?: string
    subject?: string
    to?: string[]
    confirmation_required?: boolean
    confirmation_token?: string
    expires_in?: number
    data?: unknown
  }
  error?: string
}

class ServerApi {
  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`
    }
    const res = await fetch(path, { ...opts, headers: { ...headers, ...opts.headers } })
    if (!res.ok) {
      let message = `请求失败 (${res.status})`
      try {
        const body = (await res.json()) as { error?: string } | null
        if (body?.error) message = body.error
      } catch {
        // keep default message
      }
      if (res.status === 401 && !path.startsWith('/api/auth/login')) {
        onUnauthorized?.()
      }
      throw new Error(message)
    }
    return res.json() as Promise<T>
  }

  // ── Auth ──
  login(username: string, password: string): Promise<{ ok: boolean; token: string; user: AuthUser }> {
    return this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request('/api/auth/logout', { method: 'POST' })
  }

  me(): Promise<{ ok: boolean; user: AuthUser }> {
    return this.request('/api/auth/me')
  }

  listUsers(): Promise<AuthUser[]> {
    return this.request('/api/users')
  }

  createUser(input: { username: string; password: string; role: string; college?: string }): Promise<AuthUser> {
    return this.request('/api/users', { method: 'POST', body: JSON.stringify(input) })
  }

  updateUser(id: string, patch: { role?: string; college?: string; password?: string; disabled?: boolean }): Promise<AuthUser> {
    return this.request(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteUser(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // ── Health ──
  health(): Promise<{ ok: boolean; runtime: { reachable: boolean } }> {
    return this.request('/api/health')
  }

  // ── Personnel ──
  listPersonnel(): Promise<ServerPersonnelDB> {
    return this.request('/api/personnel')
  }

  createPersonnel(entry: Omit<PersonEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<PersonEntry> {
    return this.request('/api/personnel', { method: 'POST', body: JSON.stringify(entry) })
  }

  updatePersonnel(id: string, patch: Partial<PersonEntry>): Promise<PersonEntry> {
    return this.request(`/api/personnel/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  deletePersonnel(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/personnel/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  clearPersonnel(): Promise<{ ok: boolean }> {
    return this.request('/api/personnel', { method: 'DELETE' })
  }

  bulkPersonnel(entries: PersonEntry[]): Promise<{ ok: boolean; added: number; entries: PersonEntry[] }> {
    return this.request('/api/personnel/bulk', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    })
  }

  /** 整表替换(用于备份还原/一次性迁移的权威写入) */
  replacePersonnel(entries: PersonEntry[]): Promise<ServerPersonnelDB> {
    return this.request('/api/personnel', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    })
  }

  // ── Reports ──
  listReports(): Promise<ServerReport[]> {
    return this.request('/api/reports')
  }

  createReport(report: Omit<ServerReport, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<ServerReport> {
    return this.request('/api/reports', { method: 'POST', body: JSON.stringify(report) })
  }

  deleteReport(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  replaceReports(reports: ServerReport[]): Promise<ServerReport[]> {
    return this.request('/api/reports', { method: 'PUT', body: JSON.stringify({ reports }) })
  }

  listReportSummary(): Promise<ReportSummary> {
    return this.request('/api/reports/summary')
  }

  // ── Knowledge Base ──
  listKbDocuments(): Promise<KbDocumentMeta[]> {
    return this.request('/api/kb/documents')
  }

  createKbDocument(input: { filename: string; college?: string; scope: 'school' | 'college'; text: string }): Promise<KbDocumentMeta> {
    return this.request('/api/kb/documents', { method: 'POST', body: JSON.stringify(input) })
  }

  deleteKbDocument(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/kb/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  getKbDocument(id: string): Promise<KbDocumentMeta & { content: string }> {
    return this.request(`/api/kb/documents/${encodeURIComponent(id)}`)
  }

  kbSearch(q: string): Promise<KbSearchResult> {
    return this.request(`/api/kb/search?q=${encodeURIComponent(q)}`)
  }

  kbAsk(question: string): Promise<KbAskResponse> {
    return this.request('/api/kb/ask', { method: 'POST', body: JSON.stringify({ question }) })
  }

  // ── 就业指导 ──
  listJobs(params?: { q?: string; degree?: string; location?: string; status?: JobStatus; college?: string; category?: JobCategory }): Promise<JobPosting[]> {
    const qs = new URLSearchParams()
    if (params?.q) qs.set('q', params.q)
    if (params?.degree) qs.set('degree', params.degree)
    if (params?.location) qs.set('location', params.location)
    if (params?.status) qs.set('status', params.status)
    if (params?.college) qs.set('college', params.college)
    if (params?.category) qs.set('category', params.category)
    const s = qs.toString()
    return this.request('/api/jobs' + (s ? '?' + s : ''))
  }

  createJob(input: Omit<JobPosting, 'id' | 'createdAt' | 'updatedAt'>): Promise<JobPosting> {
    return this.request('/api/jobs', { method: 'POST', body: JSON.stringify(input) })
  }

  updateJob(id: string, patch: Partial<JobPosting>): Promise<JobPosting> {
    return this.request('/api/jobs/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteJob(id: string): Promise<{ ok: boolean }> {
    return this.request('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  bulkJobs(entries: JobPosting[]): Promise<{ ok: boolean; added: number; entries: JobPosting[] }> {
    return this.request('/api/jobs/bulk', { method: 'POST', body: JSON.stringify({ entries }) })
  }

  // ── 科研助理 ──
  researchSearch(input: { q: string; author?: string; journal?: string; fromYear?: string; toYear?: string; type?: 'journal' | 'conference' | 'thesis' | 'review'; maxResults?: number }): Promise<{ ok: boolean; hits: LiteratureHit[]; count: number }> {
    return this.request('/api/research/search', { method: 'POST', body: JSON.stringify(input) })
  }

  /** 基于检索命中文献生成「研究背景与国内外现状」综述(runtime AI)。 */
  summarizeLiterature(input: { question: string; hits: LiteratureHit[] }): Promise<{ ok: boolean; answer: string; threadId: string; cited: number }> {
    return this.request('/api/research/summarize-literature', { method: 'POST', body: JSON.stringify(input) })
  }

  listPapers(params?: { q?: string; field?: string; type?: string; year?: string; journal?: string }): Promise<PaperRecord[]> {
    const qs = new URLSearchParams()
    if (params?.q) qs.set('q', params.q)
    if (params?.field) qs.set('field', params.field)
    if (params?.type) qs.set('type', params.type)
    if (params?.year) qs.set('year', params.year)
    if (params?.journal) qs.set('journal', params.journal)
    const s = qs.toString()
    return this.request('/api/research/papers' + (s ? '?' + s : ''))
  }

  savePaper(input: Omit<PaperRecord, 'id' | 'createdAt' | 'updatedAt' | 'collectedBy'>): Promise<PaperRecord> {
    return this.request('/api/research/papers', { method: 'POST', body: JSON.stringify(input) })
  }

  importPapers(entries: Array<Omit<PaperRecord, 'id' | 'createdAt' | 'updatedAt' | 'collectedBy'>>): Promise<{ ok: boolean; added: number; entries: PaperRecord[] }> {
    return this.request('/api/research/papers/import', { method: 'POST', body: JSON.stringify({ entries }) })
  }

  deletePaper(id: string): Promise<{ ok: boolean }> {
    return this.request('/api/research/papers/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  listFunds(params?: { q?: string; year?: string; category?: string; status?: string }): Promise<FundProject[]> {
    const qs = new URLSearchParams()
    if (params?.q) qs.set('q', params.q)
    if (params?.year) qs.set('year', params.year)
    if (params?.category) qs.set('category', params.category)
    if (params?.status) qs.set('status', params.status)
    const s = qs.toString()
    return this.request('/api/research/funds' + (s ? '?' + s : ''))
  }

  createFund(input: Omit<FundProject, 'id' | 'createdAt' | 'updatedAt'>): Promise<FundProject> {
    return this.request('/api/research/funds', { method: 'POST', body: JSON.stringify(input) })
  }

  updateFund(id: string, patch: Partial<FundProject>): Promise<FundProject> {
    return this.request('/api/research/funds/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteFund(id: string): Promise<{ ok: boolean }> {
    return this.request('/api/research/funds/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  importFunds(entries: Array<Omit<FundProject, 'id' | 'createdAt' | 'updatedAt'>>): Promise<{ ok: boolean; added: number; entries: FundProject[] }> {
    return this.request('/api/research/funds/import', { method: 'POST', body: JSON.stringify({ entries }) })
  }

  analyzeFunds(question: string): Promise<{ ok: boolean; answer: string; threadId: string; projectCount: number }> {
    return this.request('/api/research/funds/analyze', { method: 'POST', body: JSON.stringify({ question }) })
  }

  listSubscriptions(): Promise<PushSubscription[]> {
    return this.request('/api/research/subscriptions')
  }

  createSubscription(input: Omit<PushSubscription, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>): Promise<PushSubscription> {
    return this.request('/api/research/subscriptions', { method: 'POST', body: JSON.stringify(input) })
  }

  updateSubscription(id: string, patch: Partial<PushSubscription>): Promise<PushSubscription> {
    return this.request('/api/research/subscriptions/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteSubscription(id: string): Promise<{ ok: boolean }> {
    return this.request('/api/research/subscriptions/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  researchPush(subscriptionId: string): Promise<{ ok: boolean; digest: string; count: number; subscription: PushSubscription }> {
    return this.request('/api/research/push', { method: 'POST', body: JSON.stringify({ subscriptionId }) })
  }

  // ── 知识库增强 ──
  ocrKb(dataBase64: string, filename: string, lang?: string): Promise<{ ok: boolean; filename: string; text: string; pages: number }> {
    return this.request('/api/kb/ocr', { method: 'POST', body: JSON.stringify({ dataBase64, filename, lang }) })
  }

  reviewKb(scope?: 'school' | 'college', college?: string): Promise<{ ok: boolean; answer: string; threadId: string; docCount: number; docs: Array<{ filename: string; scope: string; college?: string }> }> {
    return this.request('/api/kb/review', { method: 'POST', body: JSON.stringify({ scope, college }) })
  }

  listPushLogs(): Promise<PushLogEntry[]> {
    return this.request('/api/research/push-logs')
  }

  // ── 消息中心 ──
  listNotifications(limit = 20): Promise<AppNotification[]> {
    return this.request('/api/notifications?limit=' + limit)
  }

  notificationUnreadCount(): Promise<{ count: number }> {
    return this.request('/api/notifications/unread-count')
  }

  markNotificationRead(id: string): Promise<{ ok: boolean }> {
    return this.request('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST' })
  }

  clearNotifications(): Promise<{ ok: boolean }> {
    return this.request('/api/notifications', { method: 'DELETE' })
  }

  // ── 舆情/就业定期汇总配置(admin) ──
  listDigests(): Promise<DigestConfig[]> {
    return this.request('/api/digests')
  }

  createDigest(input: { type: 'report' | 'job'; period: PushPeriod; email?: string; enabled?: boolean }): Promise<DigestConfig> {
    return this.request('/api/digests', { method: 'POST', body: JSON.stringify(input) })
  }

  updateDigest(id: string, patch: Partial<DigestConfig>): Promise<DigestConfig> {
    return this.request('/api/digests/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteDigest(id: string): Promise<{ ok: boolean }> {
    return this.request('/api/digests/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  runDigest(id: string): Promise<{ ok: boolean; digest: string; mail?: string; error?: string }> {
    return this.request('/api/digests/' + encodeURIComponent(id) + '/run', { method: 'POST' })
  }

  // ── Mail ──
  sendReportMail(payload: SendMailPayload): Promise<SendMailResponse> {
    return this.request('/api/mail/send-report', { method: 'POST', body: JSON.stringify(payload) })
  }
}

export interface KbDocumentMeta {
  id: string
  filename: string
  college?: string
  scope: 'school' | 'college'
  uploadedBy: string
  uploadedAt: string
  charCount: number
  chunkCount: number
}

export interface KbSearchResult {
  results: Array<{
    doc: { id: string; filename: string; college?: string; scope: 'school' | 'college' }
    chunks: Array<{ idx: number; text: string }>
  }>
}

export interface KbAskResponse {
  ok: boolean
  answer: string
  threadId: string
  sources: Array<{ filename: string; college: string | null; scope: 'school' | 'college'; chunks: number }>
}


export const serverApi = new ServerApi()

export type { PersonnelLevel }
