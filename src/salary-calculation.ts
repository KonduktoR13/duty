import type { SalarySettings } from './types'

export const DEFAULT_SALARY_SETTINGS: SalarySettings = {
  baseSalary: 2170,
  replacementEnabled: false,
  replacementPercent: 16.0184,
  vacationEnabled: true,
  vacationDailyRate: 98.46,
  incomeTaxPercent: 22,
  taxFreeAllowance: 700,
  unemploymentPercent: 1.6,
  fundedPensionPercent: 2,
  homeDutyPercent: 12,
}

export type SalaryForecast = {
  normDays: number
  normHours: number
  hourlyRate: number
  nightHours: number
  nightHourlyPremium: number
  nightPremium: number
  basePay: number
  homeDutyHours: number
  homeDutyHourlyPremium: number
  homeDutyPremium: number
  publicHolidayHours: number
  publicHolidayHourlyPremium: number
  publicHolidayPremium: number
  vacationDays: number
  vacationPay?: number
  replacementAllowance?: number
  gross: number
  unemployment: number
  fundedPension: number
  taxableIncome: number
  incomeTax: number
  net: number
}

function dateId(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Meeus/Jones/Butcher Gregorian Easter algorithm. Good Friday is the only
// movable Estonian public holiday that can reduce a Monday–Friday work norm.
function easterSunday(year: number) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

function publicHolidays(year: number) {
  const easter = easterSunday(year)
  const goodFriday = new Date(easter)
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2)
  return new Set([
    dateId(year, 1, 1),
    dateId(year, 2, 24),
    goodFriday.toISOString().slice(0, 10),
    easter.toISOString().slice(0, 10),
    dateId(year, 5, 1),
    new Date(easter.getTime() + 49 * 86400000).toISOString().slice(0, 10),
    dateId(year, 6, 23),
    dateId(year, 6, 24),
    dateId(year, 8, 20),
    dateId(year, 12, 24),
    dateId(year, 12, 25),
    dateId(year, 12, 26),
  ])
}

export function isEstonianPublicHoliday(date: string) {
  const year = Number(date.slice(0, 4))
  return Number.isInteger(year) && publicHolidays(year).has(date)
}

export function monthlyWorkNorm(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12)
    throw new Error(`Unsupported month: ${month}`)
  const holidays = publicHolidays(year)
  const shortened = new Set([
    dateId(year, 2, 23),
    dateId(year, 6, 22),
    dateId(year, 12, 23),
    dateId(year, 12, 31),
  ])
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  let normDays = 0
  let normHours = 0
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(Date.UTC(year, monthNumber - 1, day))
    const weekday = date.getUTCDay()
    const id = dateId(year, monthNumber, day)
    if (weekday === 0 || weekday === 6 || holidays.has(id)) continue
    normDays++
    normHours += shortened.has(id) ? 5 : 8
  }
  return { days: normDays, hours: normHours }
}

export function normalizeSalarySettings(value?: Partial<SalarySettings> | null): SalarySettings {
  const baseSalary = Number(value?.baseSalary)
  const replacementPercent = Number(value?.replacementPercent)
  const positiveOr = (candidate: unknown, fallback: number) => {
    const number = Number(candidate)
    return Number.isFinite(number) && number >= 0 ? number : fallback
  }
  return {
    baseSalary: Number.isFinite(baseSalary) && baseSalary > 0 ? baseSalary : DEFAULT_SALARY_SETTINGS.baseSalary,
    replacementEnabled: value?.replacementEnabled === true,
    replacementPercent: Number.isFinite(replacementPercent) && replacementPercent >= 0
      ? replacementPercent
      : DEFAULT_SALARY_SETTINGS.replacementPercent,
    vacationEnabled: value?.vacationEnabled !== false,
    vacationDailyRate: positiveOr(value?.vacationDailyRate, DEFAULT_SALARY_SETTINGS.vacationDailyRate),
    incomeTaxPercent: positiveOr(value?.incomeTaxPercent, DEFAULT_SALARY_SETTINGS.incomeTaxPercent),
    taxFreeAllowance: positiveOr(value?.taxFreeAllowance, DEFAULT_SALARY_SETTINGS.taxFreeAllowance),
    unemploymentPercent: positiveOr(value?.unemploymentPercent, DEFAULT_SALARY_SETTINGS.unemploymentPercent),
    fundedPensionPercent: positiveOr(value?.fundedPensionPercent, DEFAULT_SALARY_SETTINGS.fundedPensionPercent),
    homeDutyPercent: positiveOr(value?.homeDutyPercent, DEFAULT_SALARY_SETTINGS.homeDutyPercent),
  }
}

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

type SalaryInputs = {
  homeDutyHours?: number
  publicHolidayHours?: number
  vacationDays?: number
}

export function salaryForecast(month: string, nightHours: number, rawSettings?: Partial<SalarySettings> | null, inputs: SalaryInputs = {}): SalaryForecast {
  const settings = normalizeSalarySettings(rawSettings)
  const norm = monthlyWorkNorm(month)
  const hourlyRate = settings.baseSalary / norm.hours
  // The supplied palgateatis rounds the 25% hourly premium to cents first,
  // then multiplies it by the month's night hours.
  const nightHourlyPremium = roundMoney(hourlyRate * 0.25)
  const homeDutyHours = inputs.homeDutyHours || 0
  const publicHolidayHours = inputs.publicHolidayHours || 0
  const vacationDays = settings.vacationEnabled ? inputs.vacationDays || 0 : 0
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  // Põhipalk on leave months is only an estimate: the roster does not retain
  // the work-hour balance that payroll used to reduce the monthly salary.
  const basePay = roundMoney(settings.baseSalary * (daysInMonth - vacationDays) / daysInMonth)
  const homeDutyHourlyPremium = roundMoney(hourlyRate * settings.homeDutyPercent / 100)
  const publicHolidayHourlyPremium = roundMoney(hourlyRate)
  const nightPremium = roundMoney(nightHourlyPremium * nightHours)
  const homeDutyPremium = roundMoney(homeDutyHourlyPremium * homeDutyHours)
  const publicHolidayPremium = roundMoney(publicHolidayHourlyPremium * publicHolidayHours)
  const vacationPay = vacationDays ? roundMoney(settings.vacationDailyRate * vacationDays) : undefined
  const replacementAllowance = settings.replacementEnabled
    ? roundMoney(basePay * settings.replacementPercent / 100)
    : undefined
  const gross = roundMoney(basePay + nightPremium + homeDutyPremium + publicHolidayPremium + (vacationPay || 0) + (replacementAllowance || 0))
  const unemployment = roundMoney(gross * settings.unemploymentPercent / 100)
  const fundedPension = roundMoney(gross * settings.fundedPensionPercent / 100)
  const taxableIncome = Math.max(0, roundMoney(gross - unemployment - fundedPension - settings.taxFreeAllowance))
  const incomeTax = roundMoney(taxableIncome * settings.incomeTaxPercent / 100)
  return {
    normDays: norm.days,
    normHours: norm.hours,
    hourlyRate,
    nightHours,
    nightHourlyPremium,
    nightPremium,
    basePay,
    homeDutyHours,
    homeDutyHourlyPremium,
    homeDutyPremium,
    publicHolidayHours,
    publicHolidayHourlyPremium,
    publicHolidayPremium,
    vacationDays,
    vacationPay,
    replacementAllowance,
    gross,
    unemployment,
    fundedPension,
    taxableIncome,
    incomeTax,
    net: roundMoney(gross - unemployment - fundedPension - incomeTax),
  }
}
