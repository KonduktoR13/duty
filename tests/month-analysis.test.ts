import { describe, expect, it } from 'vitest'
import { analyzeMonth } from '../src/month-analysis'
import type { Candidate, DayMark, MonthRecord } from '../src/types'

function record(id: string, marks: DayMark[]): MonthRecord {
  const candidate: Candidate = {
    number: 'D12', values: [], marks,
    shifts: marks.filter((mark): mark is Extract<DayMark, { kind: 'hours' | 'home' }> => mark.kind === 'hours' || mark.kind === 'home').map(mark => ({ date: mark.date, hours: mark.hours, code: mark.raw })),
    leaveDates: marks.filter(mark => mark.kind === 'leave').map(mark => mark.date), leaveCodes: {}, confidence: 'high',
  }
  return { id, fileName: `${id}.pdf`, importedAt: 1, hash: id, shifts: [], deltaNumber: 'D12', status: 'local', candidates: [candidate] }
}

describe('monthly roster analysis', () => {
  it('splits on-site work into legal night time 22:00–06:00 and daytime', () => {
    const result = analyzeMonth([
      record('2026-07', []),
      record('2026-08', [
        { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
        { date: '2026-08-10', kind: 'hours', raw: '8', hours: 8 },
      ]),
      record('2026-09', []),
    ], '2026-08', 'D12')
    expect(result).toMatchObject({ workHours: 32, dayHours: 24, nightHours: 8, operationalShiftCount: 1, workdayCount: 1 })
  })

  it('keeps home duty and tentative hours separate from confirmed on-site work', () => {
    const result = analyzeMonth([record('2026-08', [
      { date: '2026-08-03', kind: 'hours', raw: '12', hours: 12 },
      { date: '2026-08-03', kind: 'home', raw: 'V4', hours: 4 },
      { date: '2026-08-04', kind: 'home', raw: 'V8', hours: 8 },
      { date: '2026-08-05', kind: 'tentative', raw: '#12', hours: 12 },
    ])], '2026-08', 'D12')
    expect(result).toMatchObject({ workHours: 12, homeDutyHours: 12, tentativeHours: 12, operationalShiftCount: 0, workdayCount: 1 })
    expect(result.checks.find(check => check.id === 'home-duty')).toMatchObject({ tone: 'ok', value: '12 из 155 ч' })
  })

  it('requires 11 compensatory hours after a 24-hour rescue-service shift and detects a short gap', () => {
    const result = analyzeMonth([
      record('2026-07', []),
      record('2026-08', [
        { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
        { date: '2026-08-04', kind: 'hours', raw: '8', hours: 8 },
      ]),
      record('2026-09', []),
    ], '2026-08', 'D12')
    expect(result.operationalShiftCount).toBe(1)
    expect(result.checks.find(check => check.id === 'shift-rest')).toMatchObject({ tone: 'attention', value: 'Меньше 11 ч' })
  })

  it('does not treat scheduled rescue-service V standby as interrupting compensatory rest', () => {
    const result = analyzeMonth([
      record('2026-07', []),
      record('2026-08', [
        { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
        { date: '2026-08-04', kind: 'home', raw: 'V8', hours: 8 },
        { date: '2026-08-05', kind: 'hours', raw: '8', hours: 8 },
      ]),
      record('2026-09', []),
    ], '2026-08', 'D12')
    expect(result.checks.find(check => check.id === 'shift-rest')).toMatchObject({ tone: 'ok', value: 'Минимум 24 ч' })
  })

  it('does not claim a complete legal assessment without adjacent months', () => {
    const result = analyzeMonth([record('2026-08', [{ date: '2026-08-31', kind: 'hours', raw: '24', hours: 24 }])], '2026-08', 'D12')
    expect(result.hasPreviousMonth).toBe(false)
    expect(result.hasFollowingMonth).toBe(false)
    expect(result.checks.find(check => check.id === 'shift-rest')?.tone).toBe('info')
  })

  it('uses the current 36-hour weekly-rest threshold for summarized working time', () => {
    const result = analyzeMonth([
      record('2026-07', []),
      record('2026-08', [
        { date: '2026-08-03', kind: 'hours', raw: '8', hours: 8 },
        { date: '2026-08-05', kind: 'hours', raw: '8', hours: 8 },
      ]),
      record('2026-09', []),
    ], '2026-08', 'D12')
    const weekly = result.checks.find(check => check.id === 'weekly-rest')
    expect(weekly?.value).toBe('Максимум 40 ч')
    expect(weekly?.explanation).toContain('13.02.2026')
    expect(weekly?.explanation).toContain('ежедневный и еженедельный отдых')
  })

  it('treats rescue-service standby as rest and flags the 155-hour monthly limit', () => {
    const result = analyzeMonth([record('2026-08', [
      { date: '2026-08-01', kind: 'hours', raw: '8', hours: 8 },
      { date: '2026-08-02', kind: 'home', raw: 'V156', hours: 156 },
      { date: '2026-08-03', kind: 'hours', raw: '8', hours: 8 },
    ])], '2026-08', 'D12')
    expect(result.checks.find(check => check.id === 'home-duty')).toMatchObject({ tone: 'attention', value: '156 из 155 ч' })
    expect(result.minimumRestHours).toBe(40)
  })
})
