import { describe, expect, it } from 'vitest'
import { monthlyWorkNorm, salaryForecast } from '../src/salary-calculation'
import { analyzeMonth } from '../src/month-analysis'
import type { Candidate, DayMark, MonthRecord } from '../src/types'

function record(id: string, marks: DayMark[]): MonthRecord {
  const candidate: Candidate = {
    number: 'D12', values: [], marks, shifts: [], leaveDates: [], leaveCodes: {}, confidence: 'high',
  }
  return { id, fileName: `${id}.pdf`, importedAt: 1, hash: id, shifts: [], deltaNumber: 'D12', status: 'local', candidates: [candidate] }
}

describe('salary forecast', () => {
  it('uses Estonian monthly work norms from the supplied July and August palgateatis', () => {
    expect(monthlyWorkNorm('2026-07')).toEqual({ days: 23, hours: 184 })
    expect(monthlyWorkNorm('2026-08')).toEqual({ days: 20, hours: 160 })
  })

  it('reproduces both palgateatis night premiums by rounding the hourly premium first', () => {
    expect(salaryForecast('2026-07', 24, { baseSalary: 2170 })).toMatchObject({
      hourlyRate: 2170 / 184, nightHourlyPremium: 2.95, nightPremium: 70.80,
    })
    expect(salaryForecast('2026-08', 64, { baseSalary: 2170 })).toMatchObject({
      hourlyRate: 2170 / 160, nightHourlyPremium: 3.39, nightPremium: 216.96,
    })
  })

  it('derives night hours from each real graph interval, not a shift-count constant', () => {
    const analysis = analyzeMonth([record('2026-08', [
      { date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 },
      { date: '2026-08-06', kind: 'hours', raw: '12', hours: 12 },
      { date: '2026-08-10', kind: 'hours', raw: '8', hours: 8 },
    ])], '2026-08', 'D12')
    expect(analysis.nightHours).toBe(8)
    expect(salaryForecast('2026-08', analysis.nightHours)).toMatchObject({ nightPremium: 27.12 })
  })

  it('assigns night hours to the calendar month in which they occurred', () => {
    const august = record('2026-08', [
      { date: '2026-08-31', kind: 'hours', raw: '24', hours: 24 },
    ])
    const september = record('2026-09', [])
    expect(analyzeMonth([august, september], '2026-08', 'D12').calendarNightHours).toBe(2)
    expect(analyzeMonth([august, september], '2026-09', 'D12').calendarNightHours).toBe(6)
  })

  it('keeps replacement allowance absent unless explicitly enabled', () => {
    expect(salaryForecast('2026-08', 64).replacementAllowance).toBeUndefined()
    expect(salaryForecast('2026-08', 64, {
      baseSalary: 2170, replacementEnabled: true, replacementPercent: 16.0184,
    }).replacementAllowance).toBe(347.60)
  })

  it('reproduces the August gross pay and net bank transfer including V and replacement pay', () => {
    const result = salaryForecast('2026-08', 64, {
      baseSalary: 2170, replacementEnabled: true, replacementPercent: 16.0184,
    }, { homeDutyHours: 1 })
    expect(result).toMatchObject({
      nightPremium: 216.96,
      homeDutyHourlyPremium: 1.63,
      homeDutyPremium: 1.63,
      replacementAllowance: 347.60,
      gross: 2736.19,
      unemployment: 43.78,
      fundedPension: 54.72,
      taxableIncome: 1937.69,
      incomeTax: 426.29,
      net: 2211.40,
    })
  })

  it('reproduces confirmed V and public-holiday hourly premiums', () => {
    expect(salaryForecast('2026-03', 30, null, { homeDutyHours: 24 })).toMatchObject({
      homeDutyHourlyPremium: 1.48, homeDutyPremium: 35.52,
    })
    expect(salaryForecast('2026-05', 32, null, { publicHolidayHours: 12 })).toMatchObject({
      publicHolidayHourlyPremium: 13.56, publicHolidayPremium: 162.72,
    })
  })

  it('uses the verified July vacation daily rate while keeping base reduction approximate', () => {
    const result = salaryForecast('2026-07', 24, {
      replacementEnabled: true, replacementPercent: 16.0184, vacationDailyRate: 98.46,
    }, { vacationDays: 14 })
    expect(result).toMatchObject({ basePay: 1190, vacationPay: 1378.44, nightPremium: 70.80 })
  })

  it('accounts for three-hour shortened working days in the monthly norm', () => {
    expect(monthlyWorkNorm('2026-12')).toEqual({ days: 21, hours: 162 })
  })
})
