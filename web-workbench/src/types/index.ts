// ── Thread (matches codewhale serve ThreadRecord) ──
export interface ThreadRecord {
  schema_version: number
  id: string
  title?: string // user-settable via PATCH, added v0.8.10
  created_at: string
  updated_at: string
  model: string
  workspace: string
  mode: string
  allow_shell: boolean
  trust_mode: boolean
  auto_approve: boolean
  archived: boolean
  coherence_state: string
  latest_turn_id?: string
  latest_response_bookmark?: string
  system_prompt?: string
  task_id?: string
}

// ── Turn ──
export type TurnStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'canceled'

export interface TurnRecord {
  schema_version: number
  id: string
  thread_id: string
  status: TurnStatus
  input_summary: string
  created_at: string
  started_at?: string
  ended_at?: string
  duration_ms?: number
  usage?: Record<string, unknown>
  error?: string
  item_ids: string[]
  steer_count: number
}

// ── Turn Item ──
export type TurnItemKind =
  | 'user_message'
  | 'agent_message'
  | 'agent_reasoning'
  | 'tool_call'
  | 'file_change'
  | 'command_execution'
  | 'context_compaction'
  | 'status'
  | 'error'

export type TurnItemStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'canceled'

export interface TurnItemRecord {
  schema_version: number
  id: string
  turn_id: string
  kind: TurnItemKind
  status: TurnItemStatus
  summary: string
  detail?: string
  metadata?: Record<string, unknown>
  artifact_refs?: string[]
  started_at?: string
  ended_at?: string
}

// ── Thread Detail (GET /v1/threads/{id}) ──
export interface ThreadDetail {
  thread: ThreadRecord
  turns: TurnRecord[]
  items: TurnItemRecord[]
  latest_seq: number
}

// ── API Request/Response ──
export interface CreateThreadRequest {
  model?: string
  workspace?: string
  mode?: string
  allow_shell?: boolean
  trust_mode?: boolean
  auto_approve?: boolean
  title?: string
}

export interface StartTurnRequest {
  prompt: string
  model?: string
  mode?: string
  allow_shell?: boolean
  trust_mode?: boolean
  auto_approve?: boolean
  input_summary?: string
}

export interface StartTurnResponse {
  thread: ThreadRecord
  turn: TurnRecord
}

// ── SSE Event (GET /v1/threads/{id}/events) ──
export interface RuntimeEvent {
  schema_version: number
  seq: number
  event: string
  kind: string
  thread_id: string
  turn_id?: string
  item_id?: string
  timestamp: string
  created_at?: string
  payload: RuntimeEventPayload
}

export interface RuntimeEventPayload {
  kind?: string // "agent_message" | "agent_reasoning" | "tool_call"
  delta?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  // item started/completed fields
  item?: TurnItemRecord
  turn?: TurnRecord
  thread?: ThreadRecord
  error?: string
}

// ── API Error ──
export interface ApiError {
  code: number
  message: string
}

export class ApiRequestError extends Error {
  constructor(
    public statusCode: number,
    public apiError?: ApiError
  ) {
    super(apiError?.message ?? `Request failed (${statusCode})`)
    this.name = 'ApiRequestError'
  }
}

// ── Settings ──
export interface AppSettings {
  apiUrl: string
  authToken: string
}

// ── Personnel (结构化人员库) ──
export type PersonnelLevel = 'school' | 'college' | 'department' | 'class' | 'course' | 'individual'
export type ReportLevel = 'school' | 'college' | 'department' | 'class' | 'course' | 'individual'

/** 舆情概览统计(趋势与预警面板)。 */
export interface ReportSummary {
  total: number
  byRisk: Record<'low' | 'medium' | 'high', number>
  byLevel: Record<ReportLevel, number>
  last7: { date: string; count: number }[]
  byDept: { dept: string; count: number; highestRisk: 'low' | 'medium' | 'high' | undefined }[]
}

export const PERSON_CATEGORIES = [
  '校领导',
  '职能部门负责人',
  '院领导',
  '系主任',
  '专业负责人',
  '教授',
  '副教授',
  '讲师',
  '辅导员',
  '行政人员',
  '学生',
  '课程',
  '其他',
] as const

export type PersonCategory = (typeof PERSON_CATEGORIES)[number]

export interface PersonEntry {
  id: string                      // crypto.randomUUID() or person-{ts}-{rand}
  name: string                    // 必填
  level: PersonnelLevel           // school / college / individual
  category: string                // PersonCategory or custom
  college?: string                // 所属学院
  department?: string             // 系/部门
  role?: string                   // 具体职务
  tags?: string[]
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface PersonnelDB {
  version: number
  updatedAt: string               // ISO timestamp
  entries: PersonEntry[]
}

// ── 就业指导(招聘岗位)──
export type JobStatus = 'active' | 'expired'

export const JOB_CATEGORIES = [
  '大型互联网企业',
  '国有企业',
  '事业单位',
  '公务员及选调生',
  '教师编制岗位',
  '科研院所',
  '高校行政及科研岗位',
  '医疗教育AI等重点行业',
  '其他',
] as const

export type JobCategory = (typeof JOB_CATEGORIES)[number]

export interface JobPosting {
  id: string
  company: string                 // 单位名称
  position: string                // 招聘岗位
  major?: string                  // 招聘专业
  degree?: string                 // 学历要求
  location?: string               // 工作地点
  headcount?: string              // 招聘人数
  salary?: string                 // 薪资待遇
  applyStart?: string             // 报名时间
  deadline?: string               // 截止时间
  url?: string                    // 招聘公告链接
  contact?: string                // 联系方式
  source: string                  // 信息来源
  publishedAt?: string            // 发布时间
  status: JobStatus               // active / expired(失效识别)
  college?: string                // 面向学院(可选)
  tags?: string[]
  category?: JobCategory          // 重点岗位分类(导入/新建时自动推断)
  notes?: string
  createdAt: string
  updatedAt: string
}

// ── 科研助理(模块三)──
export type PushPeriod = 'daily' | 'weekly' | 'monthly'

export interface LiteratureHit {
  title: string
  authors: string[]
  year?: string
  journal?: string
  doi?: string
  url?: string
  abstract?: string
  source: string
  type?: string
}

export interface PaperRecord {
  id: string
  title: string
  authors: string[]
  year?: string
  journal?: string
  doi?: string
  url?: string
  abstract?: string
  type?: string
  field?: string
  source: string
  notes?: string
  collectedBy: string
  createdAt: string
  updatedAt: string
}

export interface FundProject {
  id: string
  name: string
  leader?: string
  institution?: string
  code?: string
  year?: string
  number?: string
  amount?: string
  category?: string
  status?: string
  abstract?: string
  createdAt: string
  updatedAt: string
}

export interface PushSubscription {
  id: string
  name: string
  keywords: string[]
  journal?: string
  period: PushPeriod
  email?: string
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ── 消息中心 ──
export interface AppNotification {
  id: string
  type: 'push' | 'digest' | 'system'
  title: string
  body?: string
  link?: string
  username: string | null
  createdAt: string
  readBy: string[]
}

// ── 舆情/就业定期汇总配置 ──
export interface DigestConfig {
  id: string
  type: 'report' | 'job'
  period: PushPeriod
  email?: string
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}
