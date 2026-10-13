import { describe, expect, it } from 'vitest'
import { rankEmployeeWorkload } from '../src/employee-workload'
import { analyzeMonth } from '../src/month-analysis'
import { analysisView } from '../src/analysis-view'
import { DEFAULT_SALARY_SETTINGS } from '../src/salary-calculation'
import type { Candidate, DayMark, MonthRecord } from '../src/types'

function record(id: string, entries: Record<string, DayMark[]>): MonthRecord {
  const candidates: Candidate[] = Object.entries(entries).map(([number, marks]) => ({
    number, marks, values: [], shifts: [], leaveDates: [], leaveCodes: {}, confidence: 'high',
  }))
  return { id, candidates, fileName: `${id}.pdf`, importedAt: 1, hash: id, shifts: [], deltaNumber: candidates[0]?.number || '', status: 'local' }
}

const work = (date: string, hours: number, raw = String(hours)): DayMark => ({ date, kind: 'hours', hours, raw })

describe('employee calendar-hour ranking', () => {
  it('ranks and shares places by the selected column, using numeric D-number order for ties', () => {
    const months = [
      record('2026-07', { D12: [], D2: [work('2026-07-03', 16)], D10: [work('2026-07-03', 24)], D40: [] }),
      record('2026-08', { D12: [work('2026-08-03', 24)], D2: [work('2026-08-03', 8)], D10: [], D40: [work('2026-08-03', 8)] }),
    ]
    expect(rankEmployeeWorkload(months, '2026-08', 'month').map(row => [row.deltaNumber, row.rank])).toEqual([
      ['D12', 1], ['D2', 2], ['D40', 2], ['D10', 4],
    ])
    expect(rankEmployeeWorkload(months, '2026-08', 'total').map(row => [row.deltaNumber, row.rank, row.totalHours])).toEqual([
      ['D2', 1, 24], ['D10', 1, 24], ['D12', 1, 24], ['D40', 4, 8],
    ])
  })

  it('includes zero-hour employees, excludes employees absent from the selected PDF and uses shared places', () => {
    const months = [
      record('2026-07', { D99: [work('2026-07-03', 24)] }),
      record('2026-08', {
        D40: [work('2026-08-03', 8)], D12: [], D10: [work('2026-08-03', 24)],
        D2: [work('2026-08-03', 24)],
      }),
    ]
    expect(rankEmployeeWorkload(months, '2026-08').map(row => [row.deltaNumber, row.rank, row.monthHours])).toEqual([
      ['D2', 1, 24], ['D10', 1, 24], ['D40', 3, 8], ['D12', 4, 0],
    ])
    expect(rankEmployeeWorkload(months, '2026-09')).toEqual([])
  })

  it('normalizes the 16 + 8 boundary once and splits it between calendar months without double counting', () => {
    const months = [
      record('2026-08', { D12: [work('2026-08-31', 16)] }),
      record('2026-09', { D12: [work('2026-09-01', 8)] }),
    ]
    expect(rankEmployeeWorkload(months, '2026-08')[0]).toMatchObject({ monthHours: 16, totalHours: 24, availableMonths: 2 })
    expect(rankEmployeeWorkload(months, '2026-09')[0]).toMatchObject({ monthHours: 8, totalHours: 24 })
    for (const month of months) {
      expect(rankEmployeeWorkload(months, month.id)[0].monthHours).toBe(analyzeMonth(months, month.id, 'D12').calendarHours)
    }
  })

  it('only totals months with the employee present and never counts spillover into an unloaded month', () => {
    const months = [
      record('2026-07', { D40: [] }),
      record('2026-08', { D12: [work('2026-08-31', 24)], D40: [] }),
      record('2026-09', { D40: [work('2026-09-04', 8)] }),
    ]
    expect(rankEmployeeWorkload(months, '2026-08').find(row => row.deltaNumber === 'D12')).toMatchObject({
      monthHours: 16, totalHours: 16, availableMonths: 1,
    })
    expect(rankEmployeeWorkload(months, '2026-08').find(row => row.deltaNumber === 'D40')).toMatchObject({
      monthHours: 0, totalHours: 8, availableMonths: 3,
    })
    const html = analysisView(months[1], months, 'D12', DEFAULT_SALARY_SETTINGS)
    expect(html).toContain('1 из 3 мес.')
  })

  it('excludes home duty, tentative shifts, vacation and unknown codes; preserves fractional hours', () => {
    const month = record('2026-08', { D12: [
      work('2026-08-03', 8.25, '8,25'),
      { date: '2026-08-03', kind: 'home', raw: 'V4', hours: 4 },
      { date: '2026-08-04', kind: 'tentative', raw: '#12', hours: 12 },
      { date: '2026-08-05', kind: 'leave', raw: 'P' },
      { date: '2026-08-06', kind: 'other', raw: 'Õ' },
    ] })
    expect(rankEmployeeWorkload([month], month.id)[0]).toMatchObject({ monthHours: 8.3, totalHours: 8.3 })
  })

  it('retains unresolved boundary hours without inventing a next-month continuation', () => {
    const months = [
      record('2026-08', { D12: [work('2026-08-31', 16)], D40: [work('2026-08-31', 16)] }),
      record('2026-09', { D12: [], D40: [] }),
    ]
    expect(rankEmployeeWorkload(months, '2026-09').map(row => row.monthHours)).toEqual([0, 0])
    expect(rankEmployeeWorkload(months, '2026-08').map(row => row.totalHours)).toEqual([16, 16])
  })

  it('counts local planned hours across daylight-saving time and the year boundary', () => {
    const months = [
      record('2026-03', { D12: [work('2026-03-28', 24)] }),
      record('2026-12', { D12: [work('2026-12-31', 16)] }),
      record('2027-01', { D12: [work('2027-01-01', 8)] }),
    ]
    expect(rankEmployeeWorkload(months, '2026-03')[0]).toMatchObject({ monthHours: 24, totalHours: 48 })
    expect(rankEmployeeWorkload(months, '2027-01')[0].monthHours).toBe(8)
  })

  it('supports legacy records and explains that their roster is incomplete', () => {
    const month: MonthRecord = { id: '2026-08', fileName: 'old.pdf', importedAt: 1, hash: 'old', shifts: [
      { date: '2026-08-03', hours: 8, code: '8' },
    ], deltaNumber: 'D12', status: 'local' }
    expect(rankEmployeeWorkload([month], month.id)[0]).toMatchObject({ deltaNumber: 'D12', monthHours: 8 })
    expect(analysisView(month, [month], 'D12', DEFAULT_SALARY_SETTINGS)).toContain('доступны не все D-номера')
  })

  it('still shows the roster when the selected employee has no personal data in this PDF', () => {
    const month = record('2026-08', { D40: [work('2026-08-03', 8)] })
    const html = analysisView(month, [month], 'D12', DEFAULT_SALARY_SETTINGS)
    expect(html).toContain('Нет данных для D12')
    expect(html).toContain('Нагрузка сотрудников')
    expect(html).toContain('D40')
    expect(html).not.toContain('employee-workload-own')
  })
})
