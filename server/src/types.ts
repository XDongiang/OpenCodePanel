/**
 * 领域类型 — 与前端 web-workbench/src/types/index.ts 保持结构一致。
 */

export type PersonnelLevel =
  | 'school'
  | 'college'
  | 'department'
  | 'class'
  | 'course'
  | 'individual'

export type ReportLevel =
  | 'school'
  | 'college'
  | 'department'
  | 'class'
  | 'course'
  | 'individual'

export const PERSONNEL_LEVELS: readonly PersonnelLevel[] = [
  'school',
  'college',
  'department',
  'class',
  'course',
  'individual',
]

export const REPORT_LEVELS: readonly ReportLevel[] = [
  'school',
  'college',
  'department',
  'class',
  'course',
  'individual',
]

/** 报告综合风险等级:预警分类与处置优先级依据。 */
export type ReportRiskLevel = 'low' | 'medium' | 'high'

export const RISK_LEVELS: readonly ReportRiskLevel[] = ['low', 'medium', 'high']

/** 舆情概览统计(趋势与预警面板)。 */
export interface ReportSummary {
  total: number
  byRisk: Record<ReportRiskLevel, number>
  byLevel: Record<ReportLevel, number>
  last7: { date: string; count: number }[]
  byDept: { dept: string; count: number; highestRisk: ReportRiskLevel | undefined }[]
}

export interface PersonEntry {
  id: string
  name: string
  level: PersonnelLevel
  category: string
  college?: string
  department?: string
  role?: string
  tags?: string[]
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface PersonnelDB {
  version: number
  updatedAt: string
  entries: PersonEntry[]
}

export interface SavedReport {
  id: string
  dept: string
  timeRange: string
  content: string
  createdAt: string
  threadId?: string
  level: ReportLevel
  personName?: string
  riskLevel?: ReportRiskLevel
}
