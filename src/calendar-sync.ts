import type { CalendarEventDraft, CalendarMonthSync, CalendarReminderSettings, DayMark, SyncedCalendarEvent } from './types'
import { reminderSignature } from './calendar-reminders'
import { workIntervals } from './intervals'

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
  status?: 'confirmed' | 'tentative' | 'cancelled'
  transparency?: 'opaque' | 'transparent'
  updated?: string
  summary?: string
  description?: string
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  extendedProperties?: { private?: Record<string, string> }
}

export type RemoteAudit = {
  key: string
  status: 'ok' | 'changed' | 'missing' | 'unsafe' | 'metadata'
  remote?: RemoteCalendarEvent
}

export type CalendarGateway = {
  get(eventId: string): Promise<RemoteCalendarEvent | null>
  insert(eventId: string, draft: CalendarEventDraft, privateProperties: Record<string, string>, reminders?: CalendarReminderSettings): Promise<RemoteCalendarEvent>
  patch(eventId: string, draft: CalendarEventDraft, privateProperties: Record<string, string>, etag?: string, reminders?: CalendarReminderSettings): Promise<RemoteCalendarEvent>
  remove(eventId: string, etag?: string): Promise<void>
}

export function buildCalendarDrafts(month: string, deltaNumber: string, marks: DayMark[]): CalendarEventDraft[] {
  return workIntervals(marks).filter(item => item.date.startsWith(month + '-') && !item.incomplete).map(({ incomplete, ...item }) => ({
    ...item,
    summary: item.kind === 'home' ? `Koduvalve · ${item.raw}` : item.hours === 24 ? 'Рабочая смена · 24 ч' : `Работа · ${String(item.hours).replace('.', ',')} ч`,
    description: `Создано PWA «Мои смены» из локального PDF. ${deltaNumber} · код ${item.raw}.`,
  }))
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

export function calendarSyncId(month: string, deltaNumber: string, accountProfileId?: string) {
  return accountProfileId ? `${accountProfileId}|${month}|${deltaNumber}` : `${month}|${deltaNumber}`
}

export function syncForAccount(syncs: CalendarMonthSync[], month: string, deltaNumber: string, accountProfileId?: string) {
  return syncs.find(sync => sync.month === month && sync.deltaNumber === deltaNumber && sync.accountProfileId === accountProfileId)
}

export function privateProperties(month: string, deltaNumber: string, key: string, accountProfileId?: string) {
  return { dutyPwa: CALENDAR_MARKER, month, deltaNumber, syncKey: key, ...(accountProfileId ? { dutyAccount: accountProfileId } : {}) }
}

export function auditRemoteEvent(sync: CalendarMonthSync, event: SyncedCalendarEvent, remote: RemoteCalendarEvent | null): RemoteAudit {
  if (!remote) return { key: event.draft.key, status: 'missing' }
  const expected = privateProperties(sync.month, sync.deltaNumber, event.draft.key)
  const actual = remote.extendedProperties?.private || {}
  const managed = Object.entries(expected).every(([key, value]) => actual[key] === value)
  if (!managed) return { key: event.draft.key, status: 'unsafe', remote }
  if (sync.accountProfileId && actual.dutyAccount && actual.dutyAccount !== sync.accountProfileId) return { key: event.draft.key, status: 'unsafe', remote }
  if (sync.accountProfileId && !actual.dutyAccount) return { key: event.draft.key, status: 'metadata', remote }
  if (event.etag && remote.etag && event.etag !== remote.etag) return { key: event.draft.key, status: 'changed', remote }
  return { key: event.draft.key, status: 'ok', remote }
}

export async function auditCalendarSync(sync: CalendarMonthSync, gateway: CalendarGateway): Promise<RemoteAudit[]> {
  const events = Object.values(sync.events), result: RemoteAudit[] = []
  for (let i = 0; i < events.length; i += 4) result.push(...await Promise.all(events.slice(i, i + 4).map(async event => auditRemoteEvent(sync, event, await gateway.get(event.eventId)))))
  return result
}

export type ApplySyncOptions = {
  month: string
  deltaNumber: string
  desired: CalendarEventDraft[]
  previous?: CalendarMonthSync
  audits: RemoteAudit[]
  gateway: CalendarGateway
  eventId: (key: string, recovery?: boolean) => Promise<string>
  accountProfileId?: string
  reminders?: CalendarReminderSettings
  now?: number
  checkpoint?: (sync: CalendarMonthSync) => Promise<void>
}

export async function applyCalendarSync(options: ApplySyncOptions): Promise<CalendarMonthSync> {
  const { month, deltaNumber, desired, previous, audits, gateway, eventId, accountProfileId, reminders } = options
  const appliedReminderSignature = reminderSignature(reminders)
  const plan = planCalendarSync(desired, previous)
  const auditByKey = new Map(audits.map(audit => [audit.key, audit]))
  if (Object.values(previous?.events || {}).some(event => !auditByKey.has(event.draft.key))) throw new Error('Не все события проверены. Повторите проверку Google Calendar.')
  const changedKeys = new Set(plan.changed.map(item => item.after.key))
  const next: Record<string, SyncedCalendarEvent> = { ...previous?.events }
  const checkpoint = () => options.checkpoint?.({ id: calendarSyncId(month, deltaNumber, accountProfileId), month, deltaNumber, accountProfileId, events: { ...next }, syncedAt: previous?.syncedAt, lastError: 'api' })
  for (const draft of desired) {
    const old = previous?.events[draft.key]
    const audit = old ? auditByKey.get(draft.key) : undefined
    let remote: RemoteCalendarEvent
    if (!old) {
      remote = await gateway.insert(await eventId(draft.key), draft, privateProperties(month, deltaNumber, draft.key, accountProfileId), reminders)
    } else if (audit?.status === 'missing') {
      remote = await gateway.insert(await eventId(`${draft.key}|missing:${old.eventId}`, true), draft, privateProperties(month, deltaNumber, draft.key, accountProfileId), reminders)
    } else if (audit?.status === 'unsafe') {
      remote = await gateway.insert(await eventId(`${draft.key}|unsafe:${old.eventId}`, true), draft, privateProperties(month, deltaNumber, draft.key, accountProfileId), reminders)
    } else if (changedKeys.has(draft.key) || audit?.status === 'changed' || audit?.status === 'metadata') {
      remote = await gateway.patch(old.eventId, draft, privateProperties(month, deltaNumber, draft.key, accountProfileId), audit?.remote?.etag, reminders)
    } else {
      next[draft.key] = old
      continue
    }
    next[draft.key] = { eventId: remote.id, draft, etag: remote.etag, updated: remote.updated, reminderSignature: appliedReminderSignature }
    await checkpoint()
  }
  for (const old of plan.removed) {
    const audit = auditByKey.get(old.draft.key)
    if (audit?.status === 'ok' || audit?.status === 'changed' || audit?.status === 'metadata') await gateway.remove(old.eventId, audit.remote?.etag)
    delete next[old.draft.key]
    await checkpoint()
  }
  return { id: calendarSyncId(month, deltaNumber, accountProfileId), month, deltaNumber, accountProfileId, syncedAt: options.now || Date.now(), events: next }
}

export function syncSummary(plan: SyncPlan) {
  return `${plan.changed.length} изменено · ${plan.added.length} добавлено · ${plan.removed.length} удалено`
}
