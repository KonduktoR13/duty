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
      const shiftId = `${date}:${mark.kind}:${index}`
      const onsite12 = dateMarks.some(item => item.kind === 'hours' && item.hours === 12)
      const startHour = mark.kind === 'home' ? (onsite12 && mark.hours <= 4 ? 20 : 0) : 8
      const startMinute = 0
      const duration = Math.round(mark.hours * 60)
      const title = mark.kind === 'home'
        ? `Koduvalve · ${mark.raw}`
        : mark.hours === 24 ? 'Рабочая смена · 24 ч' : `Работа · ${String(mark.hours).replace('.', ',')} ч`
      const start = { dateTime: localDateTime(date, startHour, startMinute), timeZone: CALENDAR_TIME_ZONE }
      const end = { dateTime: addWallMinutes(date, startHour, startMinute, duration), timeZone: CALENDAR_TIME_ZONE }
      const base: CalendarEventDraft = {
        key: shiftId,
        shiftId,
        part: '1/1',
        date,
        kind: mark.kind,
        raw: mark.raw,
        hours: mark.hours,
        summary: title,
        description: `Создано PWA «Мои смены» из локального PDF. ${deltaNumber} · код ${mark.raw}.`,
        start,
        end,
      }
      if (start.dateTime.slice(0, 10) === end.dateTime.slice(0, 10) || start.dateTime.endsWith('T00:00:00')) {
        drafts.push(base)
      } else {
        const midnight = { dateTime: `${end.dateTime.slice(0, 10)}T00:00:00`, timeZone: CALENDAR_TIME_ZONE }
        drafts.push(
          { ...base, key: `${shiftId}:part1`, part: '1/2', summary: `${title} (1/2)`, end: midnight },
          { ...base, key: `${shiftId}:part2`, part: '2/2', summary: `${title} (2/2)`, start: midnight },
        )
      }
    }
  }
  return drafts.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime) || a.key.localeCompare(b.key))
}

export function draftSignature(draft: CalendarEventDraft) {
  return JSON.stringify({ shiftId: logicalShiftId(draft), part: draft.part || '1/1', summary: draft.summary, description: draft.description, start: draft.start, end: draft.end, raw: draft.raw, hours: draft.hours, kind: draft.kind })
}

export function logicalShiftId(draft: CalendarEventDraft) {
  return draft.shiftId || draft.key
}

function groupDrafts(drafts: CalendarEventDraft[]) {
  const groups = new Map<string, CalendarEventDraft[]>()
  for (const draft of drafts) groups.set(logicalShiftId(draft), [...(groups.get(logicalShiftId(draft)) || []), draft])
  return groups
}

function groupSynced(events: SyncedCalendarEvent[]) {
  const groups = new Map<string, SyncedCalendarEvent[]>()
  for (const event of events) groups.set(logicalShiftId(event.draft), [...(groups.get(logicalShiftId(event.draft)) || []), event])
  return groups
}

function groupSignature(drafts: CalendarEventDraft[]) {
  return drafts.map(draftSignature).sort().join('|')
}

export function planCalendarSync(desired: CalendarEventDraft[], previous?: CalendarMonthSync): SyncPlan {
  const wanted = groupDrafts(desired)
  const old = groupSynced(Object.values(previous?.events || {}))
  const added: CalendarEventDraft[] = []
  const changed: Array<{ before: SyncedCalendarEvent; after: CalendarEventDraft }> = []
  const unchanged: SyncedCalendarEvent[] = []
  const removed: SyncedCalendarEvent[] = []
  for (const [shiftId, drafts] of wanted) {
    const before = old.get(shiftId)
    if (!before) added.push(drafts[0])
    else if (groupSignature(before.map(event => event.draft)) !== groupSignature(drafts)) changed.push({ before: before[0], after: drafts[0] })
    else unchanged.push(before[0])
  }
  for (const [shiftId, events] of old) if (!wanted.has(shiftId)) removed.push(events[0])
  return { added, changed, removed, unchanged }
}

export function privateProperties(month: string, deltaNumber: string, key: string, shiftId = key, part = '1/1') {
  return { dutyPwa: CALENDAR_MARKER, month, deltaNumber, syncKey: key, shiftId, part }
}

export function privatePropertiesForDraft(month: string, deltaNumber: string, draft: CalendarEventDraft) {
  // Old persisted events predate segmented shifts and must remain safely
  // auditable by their original four ownership properties during migration.
  if (!draft.shiftId) return { dutyPwa: CALENDAR_MARKER, month, deltaNumber, syncKey: draft.key }
  return privateProperties(month, deltaNumber, draft.key, draft.shiftId, draft.part || '1/1')
}

export function auditRemoteEvent(sync: CalendarMonthSync, event: SyncedCalendarEvent, remote: RemoteCalendarEvent | null): RemoteAudit {
  if (!remote) return { key: event.draft.key, status: 'missing' }
  const expected = privatePropertiesForDraft(sync.month, sync.deltaNumber, event.draft)
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
  const changedShiftIds = new Set(plan.changed.map(item => logicalShiftId(item.after)))
  const desiredGroups = groupDrafts(desired)
  const oldGroups = groupSynced(Object.values(previous?.events || {}))
  const next: Record<string, SyncedCalendarEvent> = {}
  for (const [shiftId, drafts] of desiredGroups) {
    const oldEvents = oldGroups.get(shiftId) || []
    const groupAudits = oldEvents.map(event => auditByKey.get(event.draft.key))
    const refreshWholeShift = changedShiftIds.has(shiftId) || groupAudits.some(audit => audit && audit.status !== 'ok')
    if (oldEvents.length && !refreshWholeShift) {
      for (const event of oldEvents) next[event.draft.key] = event
      continue
    }

    const unclaimed = [...oldEvents]
    for (const draft of drafts) {
      let oldIndex = unclaimed.findIndex(event => (event.draft.part || '1/1') === (draft.part || '1/1'))
      // A pre-segmentation 24-hour event has no part. Reuse it as part 1 so
      // migration patches that owned event instead of leaving a duplicate.
      if (oldIndex < 0 && unclaimed.length) oldIndex = 0
      const old = oldIndex >= 0 ? unclaimed.splice(oldIndex, 1)[0] : undefined
      const audit = old ? auditByKey.get(old.draft.key) : undefined
      const properties = privatePropertiesForDraft(month, deltaNumber, draft)
      let remote: RemoteCalendarEvent
      if (!old) {
        remote = await gateway.insert(await eventId(draft.key), draft, properties)
      } else if (audit?.status === 'missing') {
        remote = await gateway.insert(await eventId(`${draft.key}|missing:${old.eventId}`, true), draft, properties)
      } else if (audit?.status === 'unsafe') {
        remote = await gateway.insert(await eventId(`${draft.key}|unsafe:${old.eventId}`, true), draft, properties)
      } else {
        remote = await gateway.patch(old.eventId, draft, properties, audit?.remote?.etag)
      }
      next[draft.key] = { eventId: remote.id, draft, etag: remote.etag, updated: remote.updated }
    }
    for (const old of unclaimed) {
      const audit = auditByKey.get(old.draft.key)
      if (audit?.status === 'ok' || audit?.status === 'changed') await gateway.remove(old.eventId, audit.remote?.etag)
    }
  }
  for (const [shiftId, oldEvents] of oldGroups) {
    if (desiredGroups.has(shiftId)) continue
    for (const old of oldEvents) {
      const audit = auditByKey.get(old.draft.key)
      if (audit?.status === 'ok' || audit?.status === 'changed') await gateway.remove(old.eventId, audit.remote?.etag)
    }
  }
  return { id: `${month}|${deltaNumber}`, month, deltaNumber, syncedAt: options.now || Date.now(), events: next }
}

export function syncSummary(plan: SyncPlan) {
  return `${plan.changed.length} изменено · ${plan.added.length} добавлено · ${plan.removed.length} удалено`
}
