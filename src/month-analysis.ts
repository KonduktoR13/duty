import { workIntervals, type WorkInterval } from './intervals'
import { allMarksForDelta, candidateForMonth } from './roster'
import type { MonthRecord } from './types'
import { evaluateRules, LIMITS } from './analysis-rules'

export type AnalysisTone = 'ok' | 'attention' | 'info'
export type AnalysisCheck = {
  id: 'operational-shifts' | 'shift-rest' | 'weekly-rest' | 'average-time' | 'home-duty' | 'shortened-days'
  tone: AnalysisTone
  title: string
  value: string
  explanation: string
  findings?: string[]
}

export type MonthAnalysis = {
  month: string
  deltaNumber: string
  workHours: number
  pdfHours: number
  calendarHours: number
  calendarNightHours: number
  incompleteDays: string[]
  dayHours: number
  nightHours: number
  homeDutyHours: number
  tentativeHours: number
  operationalShiftCount: number
  workdayCount: number
  leaveDays: number
  minimumRestHours?: number
  longestRestHours?: number
  weeklyEquivalentHours: number
  checks: AnalysisCheck[]
  hasFollowingMonth: boolean
  hasPreviousMonth: boolean
}

type Interval = { start: number; end: number; draft: WorkInterval }

const MINUTES_IN_DAY = 24 * 60
const NIGHT_END = 6 * 60
const NIGHT_START = 22 * 60

function wallMinutes(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) throw new Error(`Unsupported local date-time: ${value}`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) / 60000
}

function roundHours(minutes: number) {
  return Math.round(minutes / 6) / 10
}

function hourText(hours: number) {
  return `${String(roundHours(hours * 60)).replace('.', ',')} ч`
}

function wallLabel(minutes: number) {
  const value = new Date(minutes * 60000)
  return `${String(value.getUTCDate()).padStart(2, '0')}.${String(value.getUTCMonth() + 1).padStart(2, '0')} ${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`
}

function nightMinutes(start: number, end: number) {
  let result = 0
  let cursor = start
  while (cursor < end) {
    const minuteOfDay = ((cursor % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY
    const isNight = minuteOfDay < NIGHT_END || minuteOfDay >= NIGHT_START
    const boundary = minuteOfDay < NIGHT_END
      ? cursor + NIGHT_END - minuteOfDay
      : minuteOfDay < NIGHT_START
        ? cursor + NIGHT_START - minuteOfDay
        : cursor + MINUTES_IN_DAY - minuteOfDay
    const next = Math.min(end, boundary)
    if (isNight) result += next - cursor
    cursor = next
  }
  return result
}

function monthOffset(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, value - 1 + offset, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function draftsForAllMonths(months: MonthRecord[], deltaNumber: string) {
  const marks = allMarksForDelta(months, deltaNumber)
  return workIntervals(marks)
}

function intervals(drafts: WorkInterval[]) {
  return drafts
    .map<Interval>(draft => ({ start: wallMinutes(draft.start.dateTime), end: wallMinutes(draft.end.dateTime), draft }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function mergeIntervals(values: Interval[]) {
  const merged: Array<{ start: number; end: number }> = []
  for (const value of values) {
    const previous = merged.at(-1)
    if (previous && value.start <= previous.end) previous.end = Math.max(previous.end, value.end)
    else merged.push({ start: value.start, end: value.end })
  }
  return merged
}

function restGaps(values: Array<{ start: number; end: number }>, month: string) {
  const start = wallMinutes(`${month}-01T00:00:00`)
  const end = wallMinutes(`${monthOffset(month, 1)}-01T00:00:00`)
  return values.slice(0, -1).map((value, index) => ({
    start: value.end,
    end: values[index + 1].start,
    hours: (values[index + 1].start - value.end) / 60,
  })).filter(gap => gap.end > start && gap.start < end)
}

function compensationCheck(onsite: Interval[], allOccupied: Interval[], month: string) {
  const long = onsite.filter(interval => interval.draft.date.startsWith(month + '-') && interval.draft.hours > LIMITS.compensatoryAfter && !interval.draft.incomplete)
  const failures: Array<{ end: number; next: number; actual: number; required: number }> = []
  let unknown = 0
  let minimumActual = Number.POSITIVE_INFINITY
  for (const shift of long) {
    const next = allOccupied.find(interval => interval !== shift && interval.start >= shift.end)
    if (!next) { unknown++; continue }
    const actual = (next.start - shift.end) / 60
    // PäästeTS § 20 (8) excludes the general ATS § 41 (1) daily-rest limit
    // for rescue officials. ATS § 41 (4) still grants immediate compensatory
    // rest equal to the part of a duty period that exceeded 13 hours.
    const required = shift.draft.hours - LIMITS.compensatoryAfter
    minimumActual = Math.min(minimumActual, actual)
    if (actual < required) failures.push({ end: shift.end, next: next.start, actual, required })
  }
  return { long, failures, unknown, minimumActual }
}

export function analyzeMonth(months: MonthRecord[], month: string, deltaNumber: string): MonthAnalysis {
  const marks = allMarksForDelta(months, deltaNumber)
  const allDrafts = draftsForAllMonths(months, deltaNumber)
  const selectedDrafts = allDrafts.filter(draft => draft.date.startsWith(month + '-'))
  const onsiteDrafts = selectedDrafts.filter(draft => draft.kind === 'hours')
  const homeDrafts = selectedDrafts.filter(draft => draft.kind === 'home')
  const onsiteIntervals = intervals(allDrafts.filter(draft => draft.kind === 'hours'))
  // PäästeTS § 20 (6) defines a rescue-service standby period as part of rest.
  // Actual call-outs are work, but they are not encoded in the PDF roster.
  const occupied = mergeIntervals(onsiteIntervals)
  const gaps = restGaps(occupied, month)
  const selectedNightMinutes = onsiteDrafts.reduce((sum, draft) => sum + nightMinutes(wallMinutes(draft.start.dateTime), wallMinutes(draft.end.dateTime)), 0)
  const workHours = onsiteDrafts.reduce((sum, draft) => sum + draft.hours, 0)
  const nightHours = roundHours(selectedNightMinutes)
  const dayHours = roundHours(workHours * 60 - selectedNightMinutes)
  const homeDutyHours = homeDrafts.reduce((sum, draft) => sum + draft.hours, 0)
  const tentativeHours = marks.filter((mark): mark is Extract<typeof mark, { kind: 'tentative' }> => mark.date.startsWith(month + '-') && mark.kind === 'tentative').reduce((sum, mark) => sum + mark.hours, 0)
  const leaveDays = new Set(marks.filter(mark => mark.date.startsWith(month + '-') && mark.kind === 'leave').map(mark => mark.date)).size
  const monthDays = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
  const weeklyEquivalentHours = roundHours(workHours * 7 * 60 / monthDays)
  const hasPreviousMonth = months.some(item => item.id === monthOffset(month, -1) && candidateForMonth(item, deltaNumber))
  const hasFollowingMonth = months.some(item => item.id === monthOffset(month, 1) && candidateForMonth(item, deltaNumber))
  const compensation = compensationCheck(onsiteIntervals, onsiteIntervals, month)
  const minimumRestHours = gaps.length ? Math.min(...gaps.map(gap => gap.hours)) : undefined
  const longestRestHours = gaps.length ? Math.max(...gaps.map(gap => gap.hours)) : undefined
  const weeklyRestSeen = gaps.some(gap => gap.hours >= LIMITS.weeklyRest)
  const shortenedDates = new Set([`${month.slice(0, 4)}-02-23`, `${month.slice(0, 4)}-06-22`, `${month.slice(0, 4)}-12-23`, `${month.slice(0, 4)}-12-31`])
  const shortenedShifts = onsiteDrafts.filter(draft => shortenedDates.has(draft.date))

  const checks = evaluateRules({ compensation, hasFollowingMonth, hasPreviousMonth, gaps, weeklyRestSeen, longestRestHours, weeklyEquivalentHours, homeDutyHours, shortenedShifts, roundHours, hourText, wallLabel })

  return {
    month,
    deltaNumber,
    workHours,
    pdfHours: months.filter(item => item.id === month).flatMap(item => candidateForMonth(item, deltaNumber)?.marks || []).reduce((sum, mark) => sum + (mark.kind === 'hours' ? mark.hours : 0), 0),
    calendarHours: roundHours(onsiteIntervals.reduce((sum, item) => sum + Math.max(0, Math.min(item.end, wallMinutes(`${monthOffset(month, 1)}-01T00:00:00`)) - Math.max(item.start, wallMinutes(`${month}-01T00:00:00`))), 0)),
    calendarNightHours: roundHours(onsiteIntervals.reduce((sum, item) => sum + nightMinutes(Math.max(item.start, wallMinutes(`${month}-01T00:00:00`)), Math.min(item.end, wallMinutes(`${monthOffset(month, 1)}-01T00:00:00`))), 0)),
    incompleteDays: selectedDrafts.filter(item => item.incomplete).map(item => item.date),
    dayHours,
    nightHours,
    homeDutyHours,
    tentativeHours,
    operationalShiftCount: compensation.long.length,
    workdayCount: new Set(onsiteDrafts.filter(draft => draft.hours <= 13).map(draft => draft.date)).size,
    leaveDays,
    minimumRestHours,
    longestRestHours,
    weeklyEquivalentHours,
    hasFollowingMonth,
    hasPreviousMonth,
    checks,
  }
}
