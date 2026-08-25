import { describe, expect, it } from 'vitest'
import { applyCalendarSync, auditRemoteEvent, buildCalendarDrafts, planCalendarSync, privatePropertiesForDraft, type CalendarGateway, type RemoteCalendarEvent } from '../src/calendar-sync'
import { collisionGoogleEventId, googleEventPayload } from '../src/google-calendar'
import type { CalendarMonthSync, SyncedCalendarEvent } from '../src/types'

const month = '2026-08'
const delta = 'D12'

function synced(eventId: string, draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '8', hours: 8 }])[0]): SyncedCalendarEvent {
  return { eventId, draft, etag: 'old' }
}

function sync(events: Record<string, SyncedCalendarEvent>): CalendarMonthSync {
  return { id: `${month}|${delta}`, month, deltaNumber: delta, syncedAt: 1, events }
}

describe('Google Calendar sync model', () => {
  it('builds stable timed events and omits unconfirmed or incomplete work', () => {
    const drafts = buildCalendarDrafts(month, delta, [
      { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
      { date: '2026-08-04', kind: 'tentative', raw: '#12', hours: 12 },
      { date: '2026-08-31', kind: 'hours', raw: '16', hours: 16 },
    ])
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({ key: '2026-08-03:hours:1:part1', shiftId: '2026-08-03:hours:1', part: '1/2', summary: 'Рабочая смена · 24 ч (1/2)', start: { dateTime: '2026-08-03T08:00:00' }, end: { dateTime: '2026-08-04T00:00:00' } })
    expect(drafts[1]).toMatchObject({ key: '2026-08-03:hours:1:part2', shiftId: '2026-08-03:hours:1', part: '2/2', summary: 'Рабочая смена · 24 ч (2/2)', start: { dateTime: '2026-08-04T00:00:00' }, end: { dateTime: '2026-08-04T08:00:00' } })
    expect(privatePropertiesForDraft(month, delta, drafts[0]).shiftId).toBe(privatePropertiesForDraft(month, delta, drafts[1]).shiftId)
    const office = buildCalendarDrafts(month, 'D40', [{ date: '2026-08-05', kind: 'hours', raw: '8', hours: 8 }])[0]
    expect(office).toMatchObject({ start: { dateTime: '2026-08-05T08:00:00' }, end: { dateTime: '2026-08-05T16:00:00' } })
  })

  it('sends shifts as confirmed busy time instead of all-day or free events', () => {
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
    const payload = googleEventPayload('event1', draft, privatePropertiesForDraft(month, delta, draft))
    expect(payload).toMatchObject({
      id: 'event1',
      status: 'confirmed',
      transparency: 'opaque',
      start: { dateTime: '2026-08-03T08:00:00', timeZone: 'Europe/Tallinn' },
      end: { dateTime: '2026-08-04T00:00:00', timeZone: 'Europe/Tallinn' },
    })
    expect(payload.start).not.toHaveProperty('date')
    expect(payload.end).not.toHaveProperty('date')
    expect(payload.extendedProperties.private).toMatchObject({ shiftId: '2026-08-03:hours:1', part: '1/2' })
  })

  it('uses a new valid deterministic id after a deleted-event tombstone collision', () => {
    const original = 'd17a0123456789abcdef0123456789abcdef01234567'
    expect(collisionGoogleEventId(original, 0)).toBe(original)
    expect(collisionGoogleEventId(original, 1)).toBe(original + '1')
    expect(collisionGoogleEventId(original, 2)).toBe(original + '2')
    expect(collisionGoogleEventId(original, 1)).toMatch(/^[a-v0-9]{5,1024}$/)
  })

  it('produces an idempotent add/change/remove diff', () => {
    const before = buildCalendarDrafts(month, delta, [
      { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
      { date: '2026-08-05', kind: 'hours', raw: '24', hours: 24 },
    ])
    const previous = sync(Object.fromEntries(before.map((draft, index) => [draft.key, synced(`event${index}`, draft)])))
    expect(planCalendarSync(before, previous)).toMatchObject({ added: [], changed: [], removed: [] })
    const after = buildCalendarDrafts(month, delta, [
      { date: '2026-08-03', kind: 'hours', raw: '12', hours: 12 },
      { date: '2026-08-07', kind: 'hours', raw: '24', hours: 24 },
    ])
    const plan = planCalendarSync(after, previous)
    expect([plan.changed.length, plan.added.length, plan.removed.length]).toEqual([1, 1, 1])
  })

  it('detects manual deletion, changes and a lost ownership marker', () => {
    const event = synced('event1')
    const previous = sync({ [event.draft.key]: event })
    expect(auditRemoteEvent(previous, event, null).status).toBe('missing')
    const managed = { id: 'event1', etag: 'new', extendedProperties: { private: privatePropertiesForDraft(month, delta, event.draft) } }
    expect(auditRemoteEvent(previous, event, managed).status).toBe('changed')
    expect(auditRemoteEvent(previous, event, { ...managed, extendedProperties: { private: {} } }).status).toBe('unsafe')
  })

  it('never patches or deletes an event without the PWA ownership marker', async () => {
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '8', hours: 8 }])[0]
    const old = synced('foreign', draft)
    const previous = sync({ [draft.key]: old })
    const calls: string[] = []
    const remote = (id: string): RemoteCalendarEvent => ({ id, etag: 'x', extendedProperties: { private: privatePropertiesForDraft(month, delta, draft) } })
    const gateway: CalendarGateway = {
      get: async () => null,
      insert: async id => { calls.push(`insert:${id}`); return remote(id) },
      patch: async id => { calls.push(`patch:${id}`); return remote(id) },
      remove: async id => { calls.push(`remove:${id}`) },
    }
    await applyCalendarSync({ month, deltaNumber: delta, desired: [], previous, audits: [{ key: draft.key, status: 'unsafe', remote: { id: 'foreign' } }], gateway, eventId: async () => 'recovery', now: 2 })
    expect(calls).toEqual([])
  })

  it('does not create duplicates on an unchanged repeated sync', async () => {
    const drafts = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])
    const calls: string[] = []
    const gateway: CalendarGateway = {
      get: async id => ({ id, etag: 'e1' }),
      insert: async id => { calls.push(`insert:${id}`); return { id, etag: 'e1' } },
      patch: async id => { calls.push(`patch:${id}`); return { id, etag: 'e2' } },
      remove: async id => { calls.push(`remove:${id}`) },
    }
    const first = await applyCalendarSync({ month, deltaNumber: delta, desired: drafts, audits: [], gateway, eventId: async key => `stable-${key}`, now: 2 })
    expect(calls).toHaveLength(2)
    calls.length = 0
    const audits = Object.values(first.events).map(event => ({ key: event.draft.key, status: 'ok' as const, remote: { id: event.eventId, etag: 'e1' } }))
    await applyCalendarSync({ month, deltaNumber: delta, desired: drafts, previous: first, audits, gateway, eventId: async key => `stable-${key}`, now: 3 })
    expect(calls).toEqual([])
  })

  it('updates and deletes both midnight segments as one logical shift', async () => {
    const drafts = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])
    const previous = sync(Object.fromEntries(drafts.map((draft, index) => [draft.key, synced(`part-${index + 1}`, draft)])))
    expect(planCalendarSync(drafts, previous)).toMatchObject({ added: [], changed: [], removed: [] })
    expect(planCalendarSync([], previous).removed).toHaveLength(1)

    const calls: string[] = []
    const gateway: CalendarGateway = {
      get: async id => ({ id }),
      insert: async id => ({ id }),
      patch: async (id, _draft, properties) => { calls.push(`patch:${id}:${properties.part}`); return { id, etag: 'new' } },
      remove: async id => { calls.push(`remove:${id}`) },
    }
    const audits = drafts.map((draft, index) => ({
      key: draft.key,
      status: (index === 0 ? 'changed' : 'ok') as 'changed' | 'ok',
      remote: { id: `part-${index + 1}`, etag: index === 0 ? 'manual' : 'old' },
    }))
    await applyCalendarSync({ month, deltaNumber: delta, desired: drafts, previous, audits, gateway, eventId: async key => key, now: 2 })
    expect(calls).toEqual(['patch:part-1:1/2', 'patch:part-2:2/2'])

    calls.length = 0
    const cleanAudits = drafts.map((draft, index) => ({ key: draft.key, status: 'ok' as const, remote: { id: `part-${index + 1}`, etag: 'old' } }))
    await applyCalendarSync({ month, deltaNumber: delta, desired: [], previous, audits: cleanAudits, gateway, eventId: async key => key, now: 3 })
    expect(calls).toEqual(['remove:part-1', 'remove:part-2'])
  })

  it('migrates one legacy 24-hour event into a linked pair without leaving a duplicate', async () => {
    const drafts = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])
    const legacyDraft = {
      ...drafts[0],
      key: drafts[0].shiftId!,
      shiftId: undefined,
      part: undefined,
      summary: 'Рабочая смена · 24 ч',
      end: drafts[1].end,
    }
    const legacy = synced('legacy-event', legacyDraft)
    const previous = sync({ [legacyDraft.key]: legacy })
    expect(planCalendarSync(drafts, previous).changed).toHaveLength(1)
    const calls: string[] = []
    const properties: Array<Record<string, string>> = []
    const gateway: CalendarGateway = {
      get: async id => ({ id }),
      insert: async (id, _draft, props) => { calls.push(`insert:${id}`); properties.push(props); return { id } },
      patch: async (id, _draft, props) => { calls.push(`patch:${id}`); properties.push(props); return { id } },
      remove: async id => { calls.push(`remove:${id}`) },
    }
    const result = await applyCalendarSync({
      month,
      deltaNumber: delta,
      desired: drafts,
      previous,
      audits: [{ key: legacyDraft.key, status: 'ok', remote: { id: 'legacy-event', etag: 'old' } }],
      gateway,
      eventId: async key => `new-${key}`,
      now: 2,
    })
    expect(calls).toEqual(['patch:legacy-event', `insert:new-${drafts[1].key}`])
    expect(Object.keys(result.events)).toEqual(drafts.map(draft => draft.key))
    expect(properties.map(item => [item.shiftId, item.part])).toEqual([
      [drafts[0].shiftId, '1/2'],
      [drafts[1].shiftId, '2/2'],
    ])
  })

  it('restores a manually deleted event with a new deterministic id', async () => {
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '8', hours: 8 }])[0]
    const previous = sync({ [draft.key]: synced('deleted-id', draft) })
    const calls: string[] = []
    const gateway: CalendarGateway = {
      get: async () => null,
      insert: async id => { calls.push(id); return { id, etag: 'new' } },
      patch: async id => ({ id }),
      remove: async () => {},
    }
    const result = await applyCalendarSync({ month, deltaNumber: delta, desired: [draft], previous, audits: [{ key: draft.key, status: 'missing' }], gateway, eventId: async key => `new:${key}`, now: 2 })
    expect(calls[0]).toContain('missing:deleted-id')
    expect(result.events[draft.key].eventId).not.toBe('deleted-id')
  })
})
