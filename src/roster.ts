import { normalizeCrossMonth } from './schedule'
import type { Candidate, DayMark, MonthRecord, Shift } from './types'

export type WorkMark = Extract<DayMark, { kind: 'hours' | 'home' }>
export type ForeignDayEntry = { deltaNumber: string; marks: DayMark[] }

export const isWorkMark = (mark: DayMark): mark is WorkMark => mark.kind === 'hours' || mark.kind === 'home'
export const isScheduledMark = (mark: DayMark) => isWorkMark(mark) || mark.kind === 'tentative'

export function migrateMark(mark: DayMark): DayMark {
  if (mark.kind !== 'other') return mark
  const tentative = mark.raw.match(/^#(\d+)$/)
  const hours = Number(tentative?.[1])
  return tentative && hours > 0 && hours <= 48
    ? { date: mark.date, kind: 'tentative', raw: mark.raw, hours }
    : mark
}

function legacyMarks(month: MonthRecord): DayMark[] {
  const work: DayMark[] = month.shifts.map(shift => ({
    date: shift.date,
    kind: /^V\d/i.test(shift.code) ? 'home' : 'hours',
    raw: shift.code,
    hours: shift.hours,
  }))
  const leave: DayMark[] = (month.leaveDates || []).map(date => ({
    date,
    kind: 'leave',
    raw: month.leaveCodes?.[date] || 'P',
  }))
  return [...work, ...leave].map(migrateMark)
}

export function legacyCandidate(month: MonthRecord): Candidate | undefined {
  if (!month.deltaNumber) return undefined
  const marks = (month.marks || legacyMarks(month)).map(migrateMark)
  return {
    number: month.deltaNumber,
    values: [],
    marks,
    shifts: marks.filter(isWorkMark).map(mark => ({ date: mark.date, hours: mark.hours, code: mark.raw })),
    leaveDates: marks.filter(mark => mark.kind === 'leave').map(mark => mark.date),
    leaveCodes: Object.fromEntries(marks.filter((mark): mark is Extract<DayMark, { kind: 'leave' }> => mark.kind === 'leave').map(mark => [mark.date, mark.raw])),
    confidence: marks.length ? 'high' : 'review',
  }
}

export function candidatesForMonth(month: MonthRecord): Candidate[] {
  if (month.candidates?.length) return month.candidates.map(candidate => ({ ...candidate, marks: candidate.marks.map(migrateMark) }))
  const fallback = legacyCandidate(month)
  return fallback ? [fallback] : []
}

export function candidateForMonth(month: MonthRecord, deltaNumber: string): Candidate | undefined {
  return candidatesForMonth(month).find(candidate => candidate.number === deltaNumber)
}

export function knownDeltaNumbers(months: MonthRecord[]): string[] {
  return [...new Set(months.flatMap(month => candidatesForMonth(month).map(candidate => candidate.number)))]
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')) || a.localeCompare(b))
}

export function allMarksForDelta(months: MonthRecord[], deltaNumber: string): DayMark[] {
  const raw = months.flatMap(month => candidateForMonth(month, deltaNumber)?.marks.map(migrateMark) || [])
  const normalizedWork = normalizeCrossMonth(raw.filter(isWorkMark).map<Shift>(mark => ({ date: mark.date, hours: mark.hours, code: mark.raw })))
    .map<WorkMark>(shift => ({ date: shift.date, kind: /^V\d/i.test(shift.code) ? 'home' : 'hours', raw: shift.code, hours: shift.hours }))
  return [...normalizedWork, ...raw.filter(mark => !isWorkMark(mark))]
}

export function marksForDate(months: MonthRecord[], deltaNumber: string, date: string): DayMark[] {
  return allMarksForDelta(months, deltaNumber).filter(mark => mark.date === date)
}

export function foreignEntriesForDate(months: MonthRecord[], monthId: string, ownDelta: string, date: string): ForeignDayEntry[] {
  return foreignEntriesByDate(months, monthId, ownDelta).get(date) || []
}

export function foreignEntriesByDate(months: MonthRecord[], monthId: string, ownDelta: string): Map<string, ForeignDayEntry[]> {
  const month = months.find(item => item.id === monthId)
  const grouped = new Map<string, ForeignDayEntry[]>()
  if (!month) return grouped
  for (const candidate of candidatesForMonth(month).filter(item => item.number !== ownDelta)) {
    const marksByDate = new Map<string, DayMark[]>()
    for (const mark of allMarksForDelta(months, candidate.number).filter(mark => mark.date.startsWith(monthId + '-') && isScheduledMark(mark))) {
      marksByDate.set(mark.date, [...(marksByDate.get(mark.date) || []), mark])
    }
    for (const [date, marks] of marksByDate) grouped.set(date, [...(grouped.get(date) || []), { deltaNumber: candidate.number, marks }])
  }
  return grouped
}
