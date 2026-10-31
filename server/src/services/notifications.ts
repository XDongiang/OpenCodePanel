import type { Storage } from './storage.js'

/**
 * 站内消息通知中心:
 *
 * - 任意服务可写入通知(论文推送调度结果、定期汇总、系统事件)
 * - username 为空表示全员消息(所有登录用户可见);非空为私有消息(仅本人)
 * - 已读状态按 readBy 记录,不删除历史
 */

export type NotificationType = 'push' | 'digest' | 'system'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  body?: string
  link?: string
  username: string | null // null = 全员
  createdAt: string
  readBy: string[]
}

interface NotificationsDB {
  version: number
  updatedAt: string
  entries: Notification[]
}

const NOTIFICATIONS_DOC = 'notifications'
const SCHEMA_VERSION = 1
const MAX_NOTIFICATIONS = 200

function now(): string {
  return new Date().toISOString()
}

function genId(): string {
  return 'notice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

export class NotificationService {
  constructor(private readonly storage: Storage) {}

  private read(): NotificationsDB {
    return this.storage.readDoc<NotificationsDB>(NOTIFICATIONS_DOC, {
      version: SCHEMA_VERSION,
      updatedAt: now(),
      entries: [],
    })
  }

  private save(entries: Notification[]): void {
    this.storage.writeDoc(NOTIFICATIONS_DOC, {
      version: SCHEMA_VERSION,
      updatedAt: now(),
      entries,
    })
  }

  /** 写入一条通知(最新在前,总量上限 200,超出丢弃最旧)。 */
  add(input: { type: NotificationType; title: string; body?: string; link?: string; username?: string }): Notification {
    const entry: Notification = {
      id: genId(),
      type: input.type,
      title: input.title.trim(),
      body: input.body?.trim() || undefined,
      link: input.link?.trim() || undefined,
      username: input.username?.trim() || null,
      createdAt: now(),
      readBy: [],
    }
    const next = [entry, ...this.read().entries].slice(0, MAX_NOTIFICATIONS)
    this.save(next)
    return entry
  }

  /** 当前用户可见的通知(全员消息 + 本人私有消息),最新在前。 */
  listFor(username: string, limit = 20): Notification[] {
    return this.read().entries
      .filter((n) => n.username === null || n.username === username)
      .slice(0, limit)
  }

  /** 未读数:可见且 readBy 不含当前用户。 */
  unreadCount(username: string): number {
    return this.read().entries.filter((n) => (n.username === null || n.username === username) && !n.readBy.includes(username)).length
  }

  /** 标记一条可见消息为已读(不存在返回 false)。 */
  markRead(id: string, username: string): boolean {
    const db = this.read()
    const idx = db.entries.findIndex((n) => n.id === id && (n.username === null || n.username === username))
    if (idx < 0) return false
    if (db.entries[idx].readBy.includes(username)) return true
    db.entries[idx].readBy = [...db.entries[idx].readBy, username]
    this.save(db.entries)
    return true
  }

  /** 清空当前用户可见消息(全员消息仅从本人视角移除:加入 readBy 视作已读清空)。 */
  clearFor(username: string): void {
    const db = this.read()
    const next = db.entries.map((n) =>
      n.username === null && !n.readBy.includes(username) ? { ...n, readBy: [...n.readBy, username] } : n
    )
    this.save(next)
  }
}
