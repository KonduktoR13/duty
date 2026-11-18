import { describe, expect, it } from 'vitest'
import { desiredPersonalDrafts, personalCalendarMarks } from '../src/personal'
import { eventSchema } from '../src/personal-types'
import { buildCalendarDrafts, planCalendarSync } from '../src/calendar-sync'
import { createCalendarView } from '../src/calendar-view'
import type { CalendarEventDraft, CalendarMark, CalendarMonthSync, MonthRecord } from '../src/types'

const home = eventSchema.parse({ id: 'home', kind: 'home', owner: 'D12', title: 'Private title', note: 'Private note', start: '2026-11-19', end: '2026-11-19', startTime: '09:15', endTime: '12:30', createdAt: 1, updatedAt: 1 })
const pdf: MonthRecord = { id: '2026-11', fileName: 'test.pdf', hash: 'test', importedAt: 1, deltaNumber: 'D12', status: 'local', shifts: [], marks: [{ date: '2026-11-19', kind: 'hours', raw: '8', hours: 8 }] }
const saved = (drafts: CalendarEventDraft[]): CalendarMonthSync => ({ id: 'test', month: '2026-11', deltaNumber: 'D12', events: Object.fromEntries(drafts.map(draft => [draft.key, { draft, eventId: draft.key }])) })
const desired = (events = [home], previous: CalendarEventDraft[] = []) => desiredPersonalDrafts([], 'D12', events, '2026-11', false, previous)
function page(marks: CalendarMark[]) {
  const grouped = new Map<string, CalendarMark[]>()
  for (const mark of marks) grouped.set(mark.date, [...grouped.get(mark.date) || [], mark])
  return createCalendarView({ months: [], currentDelta: 'D12', selectedDate: null, legendExpanded: false, showColleagues: false, calendarMode: 'grid', allMarks: () => marks, groupMarks: () => grouped, todayId: () => '2026-11-18', date: d => d, calendarSyncCard: () => '' }).calendarPage(pdf, grouped)
}

describe('manual calendar integration', () => {
  it('renders home and combined duty colors with exact manually entered time', () => {
    const marks = personalCalendarMarks([], 'D12', [home])
    expect(page(marks)).toContain('day home-duty')
    expect(page(marks)).toContain('09:15–12:30')
    expect(page(marks)).toContain('V3.25')
    const afterShift = { ...home, startTime: '16:00', endTime: '19:15' }
    expect(page(personalCalendarMarks([pdf], 'D12', [afterShift]))).toContain('day mixed-day-home')
    expect(personalCalendarMarks([], 'D40', [home])).toEqual([])
  })
  it('uses resolved absence intervals in calendar while keeping notes out of work export', () => {
    const absence = eventSchema.parse({ ...home, id: 'sick', kind: 'sick', startTime: undefined, endTime: undefined })
    const note = { ...absence, id: 'note', kind: 'note' as const }
    const marks = personalCalendarMarks([pdf], 'D12', [absence, note])
    expect(marks.some(m => m.kind === 'hours')).toBe(false)
    expect(marks.filter(m => m.eventId)).toHaveLength(2)
    expect(desiredPersonalDrafts([pdf], 'D12', [absence, note], '2026-11', false)).toEqual(buildCalendarDrafts('2026-11', 'D12', pdf.marks!))
    expect(desiredPersonalDrafts([pdf], 'D12', [absence, note], '2026-11', true)).toEqual([])
  })
  it('exports manual work without PDF or absence opt-in, then changes and deletes by stable key', () => {
    const first = desired()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'home', hours: 3.25, start: { dateTime: '2026-11-19T09:15:00' } })
    expect(JSON.stringify(first)).not.toContain('Private')
    expect(planCalendarSync(desired([home], first), saved(first))).toMatchObject({ added: [], changed: [], removed: [] })
    const edited = desired([{ ...home, endTime: '13:30' }], first)
    expect(edited).toHaveLength(1)
    expect(planCalendarSync(edited, saved(first)).changed).toHaveLength(1)
    expect(planCalendarSync(desired([], first), saved(first)).removed).toHaveLength(1)
    const previousPdf = buildCalendarDrafts('2026-11', 'D12', pdf.marks!)
    expect(desired([], [...previousPdf, ...first])).toEqual(previousPdf)
  })
  it('exports extra and emergency intervals and retains linked PDF keys without duplicates', () => {
    for (const kind of ['extra', 'emergency'] as const) expect(desired([{ ...home, kind }])[0].kind).toBe('hours')
    const original = buildCalendarDrafts('2026-11', 'D12', pdf.marks!)
    const linked = { ...home, kind: 'extra' as const, startTime: '08:00', endTime: '16:00', linkedKey: original[0].key, linkConfirmed: true }
    const drafts = desiredPersonalDrafts([pdf], 'D12', [linked], '2026-11', false)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].key).toBe(original[0].key)
  })
})
