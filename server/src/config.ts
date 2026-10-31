import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 服务端运行配置。全部来自环境变量,默认值面向本仓库开发环境。
 */
export interface ServerConfig {
  /** 监听端口。生产 :3001(与旧 Web 同源),开发 :8090 */
  port: number
  /** 服务端 → CodeWhale Runtime 凭证(与 codewhale serve --auth-token 同一值,浏览器不再持有) */
  authToken: string
  /** CodeWhale Runtime 地址 */
  runtimeUrl: string
  /** 小红书 CLI 可执行文件 */
  xhsBin: string
  /** agently-cli 可执行文件 */
  agentlyBin: string
  /** 服务端数据目录(personnel/reports/users/sessions JSON) */
  dataDir: string
  /** 前端构建产物目录;为 null 时只提供 API(开发模式由 Vite 提供页面) */
  staticDir: string | null
  /** Xvfb 参数(无头环境扫码登录用) */
  xvfbArgs: string[]
  /** 初始 admin 密码;未设置时启动随机生成并打印一次 */
  adminPassword: string | null
  /** 用户会话有效期(毫秒),默认 30 天 */
  sessionTtlMs: number
  /** 知识库问答使用的模型 */
  kbModel: string
  /** 论文定时推送检查间隔(毫秒);0 或未设置则不启用调度(测试用) */
  pushCheckIntervalMs?: number
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function envStr(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]
  return value !== undefined && value !== '' ? value : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(envStr(env, 'APP_PORT', '3001'), 10)
  const ttlDays = Number.parseInt(envStr(env, 'SESSION_TTL_DAYS', '30'), 10)

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3001,
    authToken: envStr(env, 'AUTH_TOKEN', 'dev-token'),
    runtimeUrl: envStr(env, 'RUNTIME_URL', 'http://127.0.0.1:7878'),
    xhsBin: envStr(env, 'XHS_BIN', 'xhs'),
    agentlyBin: envStr(env, 'AGENTLY_CLI_BIN', 'agently-cli'),
    dataDir: envStr(env, 'DATA_DIR', path.join(REPO_ROOT, 'server', 'data')),
    staticDir: resolveStaticDir(env, REPO_ROOT),
    xvfbArgs: ['-a', '-s', '-nolisten unix +extension RANDR'],
    adminPassword: env.ADMIN_PASSWORD && env.ADMIN_PASSWORD !== '' ? env.ADMIN_PASSWORD : null,
    sessionTtlMs: Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000,
    kbModel: envStr(env, 'KB_MODEL', 'deepseek-v4-pro'),
    pushCheckIntervalMs: Number.parseInt(envStr(env, 'PUSH_CHECK_INTERVAL_MS', '900000'), 10) || undefined,
  }
}

function resolveStaticDir(env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  const explicit = env.STATIC_DIR
  if (explicit !== undefined && explicit !== '') return explicit
  const candidate = path.join(repoRoot, 'web-workbench', 'dist')
  return fs.existsSync(candidate) ? candidate : null
}

export { REPO_ROOT }
