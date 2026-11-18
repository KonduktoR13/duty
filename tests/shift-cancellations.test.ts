import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../src/db'
import { eventSchema, defaultPersonalSettings } from '../src/personal-types'
import { newCancellation, reconcileCancellations, shiftTargets } from '../src/shift-cancellations'
import { desiredPersonalDrafts, personalPlan, personalForecast, personalCalendarMarks } from '../src/personal'
import { DEFAULT_SALARY_SETTINGS } from '../src/salary-calculation'
import { planCalendarSync } from '../src/calendar-sync'
import { readBackup } from '../src/backup'
import { rankEmployeeWorkload } from '../src/employee-workload'
import type { DayMark, MonthRecord } from '../src/types'
const record = (marks: DayMark[], id = '2026-11', hash = Math.random().toString()): MonthRecord => ({ id, marks, deltaNumber: 'D12', shifts: [], fileName: 'fixture.pdf', hash, status: 'local', importedAt: 1 })
const work = (date = '2026-11-24', hours = 8, raw = '8P'): DayMark => ({ date, hours, raw, kind: 'hours' })
const home = eventSchema.parse({ id: 'home', kind: 'home', owner: 'D12', start: '2026-11-25', end: '2026-11-25', startTime: '16:00', endTime: '20:00', title: 'Home', createdAt: 1, updatedAt: 1 })
const cancel = (months: MonthRecord[], events = [home], index = 0) => newCancellation(shiftTargets(months, 'D12', events)[index], 'D12')
const forecast = (months: MonthRecord[], events: ReturnType<typeof eventSchema.parse>[], month = '2026-11') => personalForecast({ months, events, config: { ...defaultPersonalSettings(), owner: 'D12' }, settings: DEFAULT_SALARY_SETTINGS, records: [], today: '2026-11-18' }, month)
beforeEach(async () => storage.clear())

describe('reversible shift cancellation', () => {
  it('excludes only the selected shift from work, colors, payroll premiums, workload and sync, then restores it', () => {
    const months = [record([work(), work('2026-11-25', 24, '24')])]
    const c = cancel(months, [])
    const before = forecast(months, [])
    const after = forecast(months, [c])
    expect(after.stat.work).toBe(before.stat.work - 8)
    expect(after.base).toBe(before.base)
    expect(after.stat.night).toBe(before.stat.night)
    expect(after.plan.cancelled).toHaveLength(1)
    expect(personalCalendarMarks(months, 'D12', [c]).some(m => m.date === c.start)).toBe(false)
    const first = desiredPersonalDrafts(months, 'D12', [], '2026-11', false)
    const next = desiredPersonalDrafts(months, 'D12', [c], '2026-11', false)
    const previous = { id: 'test', month: '2026-11', deltaNumber: 'D12', events: Object.fromEntries(first.map(draft => [draft.key, { draft, eventId: draft.key }])) }
    expect(planCalendarSync(next, previous).removed).toHaveLength(1)
    expect(planCalendarSync(next, previous).added).toEqual([])
    const intervals = after.plan.work.map(i => ({ ...first.find(d => d.key === i.key)!, incomplete: false }))
    expect(rankEmployeeWorkload(months, '2026-11', 'month', { owner: 'D12', intervals })[0].monthHours).toBe(24)
    expect(desiredPersonalDrafts(months, 'D12', [], '2026-11', false)).toEqual(first)
    expect(personalPlan(months, 'D40', [c]).cancelled).toEqual([])
  })
  it('removes night and holiday premiums for cancelled work and home premium independently', () => {
    const months = [record([work('2026-11-25', 24, '24')])]
    const c = cancel(months, [])
    const after = forecast(months, [c])
    expect(after.stat.work).toBe(0)
    expect(after.stat.night).toBe(0)
    expect(after.legacy.nightPremium).toBe(0)
    const manual = cancel([], [home])
    expect(forecast([], [home, manual]).stat.home).toBe(0)
    expect(forecast([], [home, manual]).legacy.homeDutyPremium).toBe(0)
    expect(forecast([], [home]).stat.home).toBe(4)
  })
  it('keeps unchanged cancellations despite a new filename/hash or different ordinal keys', () => {
    const months = [record([work()])]
    const c = cancel(months, [])
    const changed = [record([work(), { date: '2026-11-24', kind: 'hours', hours: 4, raw: '4' }])]
    expect(reconcileCancellations(changed, [c])[0].cancellation?.state).toBe('active')
    expect(personalPlan(changed, 'D12', [c]).work.map(i => i.raw)).toEqual(['4'])
  })
  it('retires missing shifts atomically; later reappearance and revision rollback do not revive old cancellation', async () => {
    const old = record([work()], '2026-11', 'a')
    await storage.saveImport(old, new Blob(['a']))
    const c = cancel([old], [])
    await storage.putEvent(c)
    await storage.saveImport(record([], '2026-11', 'b'), new Blob(['b']))
    expect((await storage.events())[0].cancellation?.state).toBe('removed')
    await storage.restoreRevision(old.id)
    const events = await storage.events()
    expect(events[0].cancellation?.state).toBe('removed')
    expect(personalPlan(await storage.months(), 'D12', events).work).toHaveLength(1)
  })
  it('changed time, code or kind does not silently inherit a cancellation', async () => {
    const old = record([work()])
    const c = cancel([old], [])
    for (const mark of [work('2026-11-24', 12, '12'), work('2026-11-24', 8, '8'), { ...work(), kind: 'home' as const, raw: 'V8' }]) {
      const months = [record([mark])]
      const events = reconcileCancellations(months, [c])
      expect(events[0].cancellation?.state).not.toBe('active')
      expect(personalPlan(months, 'D12', events).work).toHaveLength(1)
    }
    await storage.saveEvents([home, cancel([], [home])])
    await storage.putEvent({ ...home, endTime: '21:00' })
    expect((await storage.events()).find(e => e.kind === 'cancel')?.cancellation?.state).toBe('changed')
    expect(personalPlan([], 'D12', await storage.events()).work).toHaveLength(1)
  })
  it('missing PDF/employee row preserves intent and cannot re-export a cancelled saved event', () => {
    const months = [record([work()])]
    const c = cancel(months, [])
    const drafts = desiredPersonalDrafts(months, 'D12', [], '2026-11', false)
    expect(reconcileCancellations([], [c])[0].cancellation?.state).toBe('active')
    expect(reconcileCancellations([{ ...months[0], deltaNumber: 'D40' }], [c])[0].cancellation?.state).toBe('active')
    expect(desiredPersonalDrafts([], 'D12', [c], '2026-11', false, drafts)).toEqual([])
  })
  it('cancels linked work once, retains unrelated home duty and avoids absence double reduction', () => {
    const months = [record([work('2026-11-25', 8, '8')])]
    const target = shiftTargets(months, 'D12', [])[0]
    const extra = eventSchema.parse({ ...home, id: 'extra', kind: 'extra', startTime: '08:00', endTime: '16:00', linkedKey: target.key, linkConfirmed: true })
    const c = newCancellation(target, 'D12')
    const plan = personalPlan(months, 'D12', [home, extra, c])
    expect(plan.conflicts).toEqual([])
    expect(plan.work.map(i => i.eventId)).toEqual(['home'])
    expect(plan.cancelled).toHaveLength(1)
    const sick = eventSchema.parse({ ...home, id: 'sick', kind: 'sick', startTime: undefined, endTime: undefined })
    expect(forecast(months, [c, sick]).base).toBe(forecast(months, [c]).base)
  })
  it('supports boundaries and an independently cancelled continuation-free home interval', () => {
    const months = [record([work('2026-11-30', 16, '16')]), record([work('2026-12-01', 8, '8')], '2026-12')]
    const c = cancel(months, [])
    expect((c.cancellation!.target.end - c.cancellation!.target.start) / 60).toBe(24)
    expect(personalPlan(months, 'D12', [c]).work).toEqual([])
    expect(desiredPersonalDrafts(months, 'D12', [c], '2026-11', false)).toEqual([])
  })
  it('cancels one duplicate and asks for review if its multiplicity changes', () => {
    const months = [record([work(), work()])]
    const c = cancel(months, [], 1)
    expect(personalPlan(months, 'D12', [c]).work).toHaveLength(1)
    const next = [record([work()])]
    const events = reconcileCancellations(next, [c])
    expect(events[0].cancellation?.state).toBe('changed')
    expect(personalPlan(next, 'D12', events).work).toHaveLength(1)
  })
  it('removes Christmas premiums, emergency pay and split Google parts', () => {
    const months = [record([work('2026-12-24', 24, '24')], '2026-12')]
    const c = cancel(months, [])
    expect(forecast(months, [], '2026-12').stat.festive).toBeGreaterThan(0)
    expect(forecast(months, [c], '2026-12').stat.festive).toBe(0)
    const emergency = { ...home, kind: 'emergency' as const }
    expect(forecast([], [emergency]).emergency).toBeGreaterThan(0)
    expect(forecast([], [emergency, cancel([], [emergency])]).emergency).toBe(0)
    const drafts = desiredPersonalDrafts(months, 'D12', [], '2026-12', false)
    const part = { ...drafts[0], key: drafts[0].key + ':part:2026-12-24T12:00:00', start: { ...drafts[0].start, dateTime: '2026-12-24T12:00:00' } }
    expect(desiredPersonalDrafts([], 'D12', [c], '2026-12', false, [part])).toEqual([])
  })
  it('keeps cancellation of a linked manual record when its PDF is unavailable', () => {
    const months = [record([work('2026-11-25', 8, '8')])]
    const target = shiftTargets(months, 'D12', [])[0]
    const linked = eventSchema.parse({ ...home, id: 'linked', kind: 'extra', startTime: '08:00', endTime: '16:00', linkedKey: target.key, linkConfirmed: true })
    const c = newCancellation(target, 'D12')
    expect(personalPlan([], 'D12', [linked, c]).work).toEqual([])
    expect(desiredPersonalDrafts([], 'D12', [linked, c], '2026-11', false)).toEqual([])
    expect(personalPlan([], 'D12', [linked, c]).cancelled[0].eventId).toBe(linked.id)
  })
  it('keeps cancellation of a combined boundary shift when the neighbouring PDF is unavailable', () => {
    const first = record([work('2026-11-30', 16, '16')])
    first.candidates = ['D12', 'D40'].map(number => ({ number, marks: [work('2026-11-30', 16, '16')], shifts: [], values: [], leaveDates: [], leaveCodes: {}, confidence: 'high' }))
    first.rosterComplete = true
    const next = record([work('2026-12-01', 8, '8')], '2026-12')
    const c = cancel([first, next], [])
    expect(c.cancellation!.target.raw).toBe('24')
    expect(c.cancellation!.target.boundary16).toBe(true)
    expect(reconcileCancellations([first], [c])[0].cancellation?.state).toBe('active')
    expect(personalPlan([first], 'D12', [c]).work).toEqual([])
    // An actual new next-month row without the continuation is different evidence.
    const changed = [first, record([], '2026-12')]
    expect(reconcileCancellations(changed, [c])[0].cancellation?.state).toBe('changed')
    expect(personalPlan(changed, 'D12', [c]).work).toHaveLength(1)
  })
  it('does not resurrect a linked manual record when the new PDF removes its cancelled shift', () => {
    const old = [record([work('2026-11-25', 8, '8')])]
    const target = shiftTargets(old, 'D12', [])[0]
    const linked = eventSchema.parse({ ...home, id: 'linked', kind: 'extra', startTime: '08:00', endTime: '16:00', linkedKey: target.key, linkConfirmed: true })
    const c = newCancellation(target, 'D12')
    const months = [record([])]
    const events = reconcileCancellations(months, [linked, c])
    expect(events.find(e => e.kind === 'cancel')?.cancellation?.state).toBe('removed')
    const plan = personalPlan(months, 'D12', events)
    expect(plan.work).toEqual([])
    expect(plan.conflicts).toEqual([linked.id])
    expect(desiredPersonalDrafts(months, 'D12', events, '2026-11', false)).toEqual([])
  })
  it('round trips cancellations in v3 backup and restores active state atomically', async () => {
    const months = [record([work()])], c = cancel(months, [])
    const snapshot = await readBackup(new Blob([JSON.stringify({ format: 'my-shifts-backup', version: 3, createdAt: '2026-11-18', months, events: [c], payroll: [], pdfs: [], settings: [], syncs: [], revisions: [] })]))
    await storage.restore(snapshot)
    expect((await storage.events())[0].cancellation).toEqual(c.cancellation)
    expect(personalPlan(await storage.months(), 'D12', await storage.events()).work).toEqual([])
  })
})
