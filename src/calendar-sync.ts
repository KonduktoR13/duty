import type { CalendarEventDraft, CalendarMonthSync, DayMark, SyncedCalendarEvent } from './types'
import { isWorkMark, type WorkMark } from './roster'

export const CALENDAR_TIME_ZONE = 'Europe/Tallinn'
export const CALENDAR_MARKER = 'duty-pwa-v1'

export type SyncPlan = {
  added: CalendarEventDraft[]
  changed: Array<{ before: SyncedCalendarEvent; after: CalendarEventDraft }>
  removed: SyncedCalendarEvent[]
  unchanged: SyncedCalendarEvent[]
}

export type RemoteCalendarEvent = {
  id: string
  etag?: string
  updated?: string
  summary?: string
  description?: string
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  extendedProperties?: { private?: Record<string, string> }
}

export type RemoteAudit = {
  key: string
  status: 'ok' | 'changed' | 'missing' | 'unsafe'
  remote?: RemoteCalendarEvent
}

export type CalendarGateway = {
  get(eventId: string): Promise<RemoteCalendarEvent | null>
  insert(eventId: string, draft: CalendarEventDraft, privateProperties: Record<string, string>): Promise<RemoteCalendarEvent>
  patch(eventId: string, draft: CalendarEventDraft, privateProperties: Record<string, string>, etag?: string): Promise<RemoteCalendarEvent>
  remove(eventId: string, etag?: string): Promise<void>
}

const pad = (value: number) => String(value).padStart(2, '0')

function addWallMinutes(date: string, hour: number, minutes: number, duration: number) {
  const value = new Date(`${date}T${pad(hour)}:${pad(minutes)}:00Z`)
  value.setUTCMinutes(value.getUTCMinutes() + duration)
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:00`
}

function localDateTime(date: string, hour: number, minutes = 0) {
  return `${date}T${pad(hour)}:${pad(minutes)}:00`
}

function isIncompleteBoundary(mark: DayMark) {
  if (mark.kind !== 'hours' || mark.hours !== 16 || mark.raw !== '16') return false
  const value = new Date(mark.date + 'T12:00:00')
  return value.getDate() === new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
}

export function buildCalendarDrafts(month: string, deltaNumber: string, marks: DayMark[]): CalendarEventDraft[] {
  const monthMarks = marks.filter((mark): mark is WorkMark => mark.date.startsWith(month + '-') && isWorkMark(mark) && !isIncompleteBoundary(mark))
  const grouped = new Map<string, typeof monthMarks>()
  for (const mark of monthMarks) grouped.set(mark.date, [...(grouped.get(mark.date) || []), mark])
  const drafts: CalendarEventDraft[] = []
  for (const [date, dateMarks] of grouped) {
    const kindCount = new Map<string, number>()
    for (const mark of dateMarks.sort((a, b) => a.kind.localeCompare(b.kind) || a.raw.localeCompare(b.raw))) {
      const index = (kindCount.get(mark.kind) || 0) + 1
      kindCount.set(mark.kind, index)
      const key = `${date}:${mark.kind}:${index}`
      const onsite12 = dateMarks.some(item => item.kind === 'hours' && item.hours === 12)
      const startHour = mark.kind === 'home' ? (onsite12 && mark.hours <= 4 ? 20 : 0) : 8
      const startMinute = 0
      const duration = Math.round(mark.hours * 60)
      const title = mark.kind === 'home'
        ? `Koduvalve · ${mark.raw}`
        : mark.hours === 24 ? 'Рабочая смена · 24 ч' : `Работа · ${String(mark.hours).replace('.', ',')} ч`
      drafts.push({
        key,
        date,
        kind: mark.kind,
        raw: mark.raw,
        hours: mark.hours,
        summary: title,
        description: `Создано PWA «Мои смены» из локального PDF. ${deltaNumber} · код ${mark.raw}.`,
        start: { dateTime: localDateTime(date, startHour, startMinute), timeZone: CALENDAR_TIME_ZONE },
        end: { dateTime: addWallMinutes(date, startHour, startMinute, duration), timeZone: CALENDAR_TIME_ZONE },
      })
    }
  }
  return drafts.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime) || a.key.localeCompare(b.key))
}

export function draftSignature(draft: CalendarEventDraft) {
  return JSON.stringify({ summary: draft.summary, description: draft.description, start: draft.start, end: draft.end, raw: draft.raw, hours: draft.hours, kind: draft.kind })
}

export function planCalendarSync(desired: CalendarEventDraft[], previous?: CalendarMonthSync): SyncPlan {
  const old = previous?.events || {}
  const wanted = new Map(desired.map(draft => [draft.key, draft]))
  const added = desired.filter(draft => !old[draft.key])
  const changed = desired.filter(draft => old[draft.key] && draftSignature(old[draft.key].draft) !== draftSignature(draft)).map(after => ({ before: old[after.key], after }))
  const unchanged = desired.filter(draft => old[draft.key] && draftSignature(old[draft.key].draft) === draftSignature(draft)).map(draft => old[draft.key])
  const removed = Object.values(old).filter(event => !wanted.has(event.draft.key))
  return { added, changed, removed, unchanged }
}

export function privateProperties(month: string, deltaNumber: string, key: string) {
  return { dutyPwa: CALENDAR_MARKER, month, deltaNumber, syncKey: key }
}

export function auditRemoteEvent(sync: CalendarMonthSync, event: SyncedCalendarEvent, remote: RemoteCalendarEvent | null): RemoteAudit {
  if (!remote) return { key: event.draft.key, status: 'missing' }
  const expected = privateProperties(sync.month, sync.deltaNumber, event.draft.key)
  const actual = remote.extendedProperties?.private || {}
  const managed = Object.entries(expected).every(([key, value]) => actual[key] === value)
  if (!managed) return { key: event.draft.key, status: 'unsafe', remote }
  if (event.etag && remote.etag && event.etag !== remote.etag) return { key: event.draft.key, status: 'changed', remote }
  return { key: event.draft.key, status: 'ok', remote }
}

export async function auditCalendarSync(sync: CalendarMonthSync, gateway: CalendarGateway): Promise<RemoteAudit[]> {
  return Promise.all(Object.values(sync.events).map(async event => auditRemoteEvent(sync, event, await gateway.get(event.eventId))))
}

export type ApplySyncOptions = {
  month: string
  deltaNumber: string
  desired: CalendarEventDraft[]
  previous?: CalendarMonthSync
  audits: RemoteAudit[]
  gateway: CalendarGateway
  eventId: (key: string, recovery?: boolean) => Promise<string>
  now?: number
}

export async function applyCalendarSync(options: ApplySyncOptions): Promise<CalendarMonthSync> {
  const { month, deltaNumber, desired, previous, audits, gateway, eventId } = options
  const plan = planCalendarSync(desired, previous)
  const auditByKey = new Map(audits.map(audit => [audit.key, audit]))
  const changedKeys = new Set(plan.changed.map(item => item.after.key))
  const next: Record<string, SyncedCalendarEvent> = {}
  for (const draft of desired) {
    const old = previous?.events[draft.key]
    const audit = old ? auditByKey.get(draft.key) : undefined
    let remote: RemoteCalendarEvent
    if (!old) {
      remote = await gateway.insert(await eventId(draft.key), draft, privateProperties(month, deltaNumber, draft.key))
    } else if (audit?.status === 'missing') {
      remote = await gateway.insert(await eventId(`${draft.key}|missing:${old.eventId}`, true), draft, privateProperties(month, deltaNumber, draft.key))
    } else if (audit?.status === 'unsafe') {
      remote = await gateway.insert(await eventId(`${draft.key}|unsafe:${old.eventId}`, true), draft, privateProperties(month, deltaNumber, draft.key))
    } else if (changedKeys.has(draft.key) || audit?.status === 'changed') {
      remote = await gateway.patch(old.eventId, draft, privateProperties(month, deltaNumber, draft.key), audit?.remote?.etag)
    } else {
      next[draft.key] = old
      continue
    }
    next[draft.key] = { eventId: remote.id, draft, etag: remote.etag, updated: remote.updated }
  }
  for (const old of plan.removed) {
    const audit = auditByKey.get(old.draft.key)
    if (audit?.status === 'ok' || audit?.status === 'changed') await gateway.remove(old.eventId, audit.remote?.etag)
  }
  return { id: `${month}|${deltaNumber}`, month, deltaNumber, syncedAt: options.now || Date.now(), events: next }
}

export function syncSummary(plan: SyncPlan) {
  return `${plan.changed.length} изменено · ${plan.added.length} добавлено · ${plan.removed.length} удалено`
}
