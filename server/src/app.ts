import http from 'node:http'
import type { ServerConfig } from './config.js'
import { startServer } from './http/server.js'
import { JsonStore } from './services/storage.js'
import { PersonnelService, ReportsService } from './services/personnel.js'
import { UserService } from './services/users.js'
import { SessionService } from './services/sessions.js'
import { KbService } from './services/kb.js'
import { JobsService } from './services/jobs.js'
import { LiteratureProvider } from './services/literature.js'
import { runOcr } from './services/ocr.js'
import { FundService, PaperService, SubscriptionService } from './services/research.js'
import { sendReportMail } from './services/mail.js'
import { PushScheduler } from './services/push-scheduler.js'
import { DigestScheduler } from './services/digest-scheduler.js'
import { NotificationService } from './services/notifications.js'
import { createRuntimeClient } from './services/runtime.js'
import type { RouteDeps } from './http/routes.js'
import type { PushSchedulerDeps } from './services/push-scheduler.js'
import type { DigestSchedulerDeps } from './services/digest-scheduler.js'

type PushSchedulerDepsMail = PushSchedulerDeps['sendMail']

export interface App {
  server: http.Server
  config: ServerConfig
  deps: RouteDeps
  /** 关闭 HTTP 服务(Promise 在连接全部结束后 resolve)。 */
  close: () => Promise<void>
}

/**
 * 组装应用(不监听端口)。测试与入口共用的工厂。
 */
export function createApp(config: ServerConfig): App {
  const storage = new JsonStore(config.dataDir)
  const personnel = new PersonnelService(storage)
  const reports = new ReportsService(storage)
  const users = new UserService(storage)
  const sessions = new SessionService(storage, config.sessionTtlMs)
  sessions.pruneExpired()
  const kb = new KbService(storage)
  const jobs = new JobsService(storage)
  const papers = new PaperService(storage)
  const funds = new FundService(storage)
  const subscriptions = new SubscriptionService(storage)
  const literature = new LiteratureProvider()
  const runtime = createRuntimeClient(config.runtimeUrl, config.authToken)

  // 站内消息中心(推送调度与定期汇总共用)
  const notifications = new NotificationService(storage)

  const sendMail: PushSchedulerDepsMail = config.agentlyBin
    ? async (to, subject, body) => {
        try {
          await sendReportMail({ to, subject, body }, config.agentlyBin)
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : '邮件发送失败' }
        }
      }
    : undefined

  // 论文定时推送调度(仅当配置检查间隔时启用,测试默认不启用)
  const pushScheduler = new PushScheduler(storage, {
    listSubscriptions: () => subscriptions.list(),
    search: (q, journal, maxResults) => literature.search({ q, journal, maxResults }),
    sendMail,
    notify: (input) => void notifications.add(input),
  })

  // 舆情/就业信息定期汇总调度
  const digestScheduler = new DigestScheduler(storage, {
    listReports: () => reports.list(),
    listJobs: () => jobs.list(),
    sendMail,
    notify: (input) => void notifications.add(input),
  })

  const deps: RouteDeps = { personnel, reports, users, sessions, kb, jobs, papers, funds, subscriptions, literature, runOcr, pushScheduler, digestScheduler, notifications, runtime }
  const server = startServer(config, deps)

  let pushTimer: ReturnType<typeof setInterval> | null = null
  if (config.pushCheckIntervalMs && config.pushCheckIntervalMs > 0) {
    pushTimer = setInterval(() => {
      void pushScheduler.checkDue()
      void digestScheduler.checkDue()
    }, config.pushCheckIntervalMs)
    pushTimer.unref?.()
  }

  return {
    server,
    config,
    deps,
    close: () =>
      new Promise<void>((resolve) => {
        if (pushTimer) clearInterval(pushTimer)
        server.close(() => resolve())
      }),
  }
}
