import { describe, expect, it } from 'vitest'
import { allMarksForDelta, candidateForMonth, foreignEntriesForDate, knownDeltaNumbers } from '../src/roster'
import type { Candidate, MonthRecord } from '../src/types'

function candidate(number: string, date: string, hours: number): Candidate {
  const mark = { date, kind: 'hours' as const, raw: String(hours), hours }
  return { number, values: [], marks: [mark], shifts: [{ date, hours, code: String(hours) }], leaveDates: [], leaveCodes: {}, confidence: 'high' }
}

const month: MonthRecord = {
  id: '2026-08', fileName: 'August.pdf', importedAt: 1, hash: 'x', shifts: [], deltaNumber: 'D12', status: 'local',
  candidates: [candidate('D12', '2026-08-03', 24), candidate('D40', '2026-08-04', 8), candidate('D14', '2026-08-04', 24)],
}

describe('D-number roster selection', () => {
  it('switches the visible candidate without removing the others', () => {
    expect(candidateForMonth(month, 'D12')?.marks[0]).toMatchObject({ hours: 24 })
    expect(candidateForMonth(month, 'D40')?.marks[0]).toMatchObject({ hours: 8 })
    expect(knownDeltaNumbers([month])).toEqual(['D12', 'D14', 'D40'])
    expect(month.candidates).toHaveLength(3)
  })

  it('builds the calendar only for the selected D-number', () => {
    expect(allMarksForDelta([month], 'D12')).toHaveLength(1)
    expect(allMarksForDelta([month], 'D40')).toEqual([{ date: '2026-08-04', kind: 'hours', raw: '8', hours: 8 }])
  })

  it('returns every real colleague shift on an otherwise empty own day', () => {
    expect(foreignEntriesForDate([month], '2026-08', 'D12', '2026-08-04')).toEqual([
      { deltaNumber: 'D40', marks: [{ date: '2026-08-04', kind: 'hours', raw: '8', hours: 8 }] },
      { deltaNumber: 'D14', marks: [{ date: '2026-08-04', kind: 'hours', raw: '24', hours: 24 }] },
    ])
    expect(foreignEntriesForDate([month], '2026-08', 'D12', '2026-08-05')).toEqual([])
  })

  it('also returns colleagues when the selected D-number works that day', () => {
    const sharedDay: MonthRecord = {
      ...month,
      candidates: [candidate('D12', '2026-08-03', 24), candidate('D40', '2026-08-03', 8), candidate('D14', '2026-08-03', 24)],
    }
    expect(foreignEntriesForDate([sharedDay], '2026-08', 'D12', '2026-08-03').map(entry => entry.deltaNumber)).toEqual(['D40', 'D14'])
  })
})
