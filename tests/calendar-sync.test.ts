import { describe, expect, it } from 'vitest'
import { applyCalendarSync, auditRemoteEvent, buildCalendarDrafts, planCalendarSync, privateProperties, type CalendarGateway, type RemoteCalendarEvent } from '../src/calendar-sync'
import { collisionGoogleEventId, googleEventPayload } from '../src/google-calendar'
import type { CalendarMonthSync, SyncedCalendarEvent } from '../src/types'

const month = '2026-08'
const delta = 'D12'

function synced(eventId: string, draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]): SyncedCalendarEvent {
  return { eventId, draft, etag: 'old' }
}

function sync(events: Record<string, SyncedCalendarEvent>): CalendarMonthSync {
  return { id: `${month}|${delta}`, month, deltaNumber: delta, syncedAt: 1, events }
}

describe('Google Calendar sync model', () => {
  it('journals completed inserts before a later request fails, retaining pending removals', async () => {
    const desired = buildCalendarDrafts(month,delta,[{date:'2026-08-03',kind:'hours',raw:'24',hours:24},{date:'2026-08-07',kind:'hours',raw:'24',hours:24}])
    const removed = synced('old',buildCalendarDrafts(month,delta,[{date:'2026-08-01',kind:'hours',raw:'8',hours:8}])[0])
    const previous = sync({[removed.draft.key]:removed})
    const checkpoints:CalendarMonthSync[]=[]
    let count=0
    const gateway:CalendarGateway={get:async()=>null,insert:async id=>{if(count++)throw new Error('network');return{id,etag:'saved'}},patch:async()=>{throw new Error('unexpected')},remove:async()=>{throw new Error('unexpected')}}
    await expect(applyCalendarSync({month,deltaNumber:delta,desired,previous,audits:[{key:removed.draft.key,status:'ok'}],gateway,eventId:async key=>key,checkpoint:async value=>{checkpoints.push(value)}})).rejects.toThrow('network')
    expect(Object.keys(checkpoints[0].events)).toEqual([removed.draft.key,desired[0].key])
    expect(planCalendarSync(desired,checkpoints[0])).toMatchObject({added:[desired[1]],removed:[removed],changed:[]})
  })
  it('builds stable timed events and omits unconfirmed or incomplete work', () => {
    const drafts = buildCalendarDrafts(month, delta, [
      { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
      { date: '2026-08-04', kind: 'tentative', raw: '#12', hours: 12 },
      { date: '2026-08-31', kind: 'hours', raw: '16', hours: 16 },
    ])
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ key: '2026-08-03:hours:1', start: { dateTime: '2026-08-03T08:00:00' }, end: { dateTime: '2026-08-04T08:00:00' } })
    const office = buildCalendarDrafts(month, 'D40', [{ date: '2026-08-05', kind: 'hours', raw: '8', hours: 8 }])[0]
    expect(office).toMatchObject({ start: { dateTime: '2026-08-05T08:00:00' }, end: { dateTime: '2026-08-05T16:00:00' } })
  })

  it('sends shifts as confirmed busy time instead of all-day or free events', () => {
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
    const payload = googleEventPayload('event1', draft, privateProperties(month, delta, draft.key))
    expect(payload).toMatchObject({
      id: 'event1',
      status: 'confirmed',
      transparency: 'opaque',
      start: { dateTime: '2026-08-03T08:00:00', timeZone: 'Europe/Tallinn' },
      end: { dateTime: '2026-08-04T08:00:00', timeZone: 'Europe/Tallinn' },
    })
    expect(payload.start).not.toHaveProperty('date')
    expect(payload.end).not.toHaveProperty('date')
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
    const managed = { id: 'event1', etag: 'new', extendedProperties: { private: privateProperties(month, delta, event.draft.key) } }
    expect(auditRemoteEvent(previous, event, managed).status).toBe('changed')
    expect(auditRemoteEvent(previous, event, { ...managed, extendedProperties: { private: {} } }).status).toBe('unsafe')
  })

  it('migrates legacy ownership metadata but rejects another Google account profile', () => {
    const event = synced('event1')
    const previous = { ...sync({ [event.draft.key]: event }), accountProfileId: 'account-a' }
    const legacy = { id: 'event1', etag: 'old', extendedProperties: { private: privateProperties(month, delta, event.draft.key) } }
    expect(auditRemoteEvent(previous, event, legacy).status).toBe('metadata')
    const otherAccount = { ...legacy, extendedProperties: { private: privateProperties(month, delta, event.draft.key, 'account-b') } }
    expect(auditRemoteEvent(previous, event, otherAccount).status).toBe('unsafe')
  })

  it('never patches or deletes an event without the PWA ownership marker', async () => {
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
    const old = synced('foreign', draft)
    const previous = sync({ [draft.key]: old })
    const calls: string[] = []
    const remote = (id: string): RemoteCalendarEvent => ({ id, etag: 'x', extendedProperties: { private: privateProperties(month, delta, draft.key) } })
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
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
    const calls: string[] = []
    const gateway: CalendarGateway = {
      get: async id => ({ id, etag: 'e1', extendedProperties: { private: privateProperties(month, delta, draft.key) } }),
      insert: async id => { calls.push(`insert:${id}`); return { id, etag: 'e1' } },
      patch: async id => { calls.push(`patch:${id}`); return { id, etag: 'e2' } },
      remove: async id => { calls.push(`remove:${id}`) },
    }
    const first = await applyCalendarSync({ month, deltaNumber: delta, desired: [draft], audits: [], gateway, eventId: async () => 'stable', now: 2 })
    expect(calls).toEqual(['insert:stable'])
    calls.length = 0
    const audits = [{ key: draft.key, status: 'ok' as const, remote: { id: 'stable', etag: 'e1' } }]
    await applyCalendarSync({ month, deltaNumber: delta, desired: [draft], previous: first, audits, gateway, eventId: async () => 'stable', now: 3 })
    expect(calls).toEqual([])
  })

  it('restores a manually deleted event with a new deterministic id', async () => {
    const draft = buildCalendarDrafts(month, delta, [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
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
