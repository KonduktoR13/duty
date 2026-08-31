import { buildCalendarDrafts } from './calendar-sync'
import { allMarksForDelta } from './roster'
import type { CalendarEventDraft, MonthRecord } from './types'

export type AnalysisTone = 'ok' | 'attention' | 'info'
export type AnalysisCheck = {
  id: 'operational-shifts' | 'shift-rest' | 'weekly-rest' | 'average-time' | 'home-duty' | 'shortened-days'
  tone: AnalysisTone
  title: string
  value: string
  explanation: string
}

export type MonthAnalysis = {
  month: string
  deltaNumber: string
  workHours: number
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

type Interval = { start: number; end: number; draft: CalendarEventDraft }

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
  return months.flatMap(month => buildCalendarDrafts(month.id, deltaNumber, marks))
}

function intervals(drafts: CalendarEventDraft[]) {
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
  const long = onsite.filter(interval => interval.draft.date.startsWith(month + '-') && interval.draft.hours > 13)
  let failures = 0
  let unknown = 0
  let minimumActual = Number.POSITIVE_INFINITY
  for (const shift of long) {
    const next = allOccupied.find(interval => interval !== shift && interval.start >= shift.end)
    if (!next) { unknown++; continue }
    const actual = (next.start - shift.end) / 60
    // PäästeTS § 20 (8) excludes the general ATS § 41 (1) daily-rest limit
    // for rescue officials. ATS § 41 (4) still grants immediate compensatory
    // rest equal to the part of a duty period that exceeded 13 hours.
    const required = shift.draft.hours - 13
    minimumActual = Math.min(minimumActual, actual)
    if (actual < required) failures++
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
  const hasPreviousMonth = months.some(item => item.id === monthOffset(month, -1))
  const hasFollowingMonth = months.some(item => item.id === monthOffset(month, 1))
  const compensation = compensationCheck(onsiteIntervals, onsiteIntervals, month)
  const minimumRestHours = gaps.length ? Math.min(...gaps.map(gap => gap.hours)) : undefined
  const longestRestHours = gaps.length ? Math.max(...gaps.map(gap => gap.hours)) : undefined
  const weeklyRestSeen = gaps.some(gap => gap.hours >= 36)
  const shortenedDates = new Set([`${month.slice(0, 4)}-02-23`, `${month.slice(0, 4)}-06-22`, `${month.slice(0, 4)}-12-23`, `${month.slice(0, 4)}-12-31`])
  const shortenedShifts = onsiteDrafts.filter(draft => shortenedDates.has(draft.date))

  const operationalCheck: AnalysisCheck = {
    id: 'operational-shifts', tone: 'ok', title: 'Оперативные смены', value: `${compensation.long.length} × 24 ч`,
    explanation: 'Для päästeametnik 24-часовая оперативная смена предусмотрена специальным режимом PäästeTS §20(8): обычное ограничение ежедневного отдыха из ATS §41(1) не применяется, если работа не вредит здоровью и безопасности. Ограничение ночной работы также не применяется по PäästeTS §20(3) при том же условии и соблюдении среднего предела рабочего времени. Оценить риски здоровья по PDF невозможно.',
  }

  let compensationTone: AnalysisTone = compensation.failures ? 'attention' : compensation.unknown || !hasFollowingMonth ? 'info' : 'ok'
  let compensationValue = compensation.failures
    ? 'Меньше 11 ч'
    : Number.isFinite(compensation.minimumActual) ? `Минимум ${roundHours(compensation.minimumActual * 60)} ч` : 'Нужен следующий месяц'
  let compensationExplanation = compensation.failures
    ? 'После одной из 24-часовых оперативных смен следующая работа начинается раньше, чем закончились 11 часов компенсирующего отдыха. Для 24 часов ATS §41(4) требует немедленно дать 11 часов: это часы превышения над 13-часовой границей.'
    : 'После 24-часовой оперативной смены ATS §41(4) требует немедленный компенсирующий отдых, равный превышению 13 часов. Для смены 24 часа это 11 часов. Проверка учитывает следующую рабочую отметку, но не знает о фактических вызовах, которых нет в PDF.'

  const weeklyTone: AnalysisTone = !gaps.length || !hasPreviousMonth || !hasFollowingMonth ? 'info' : weeklyRestSeen ? 'info' : 'attention'
  const weeklyValue = longestRestHours === undefined ? 'Недостаточно данных' : `Максимум ${roundHours(longestRestHours * 60)} ч`
  const weeklyExplanation = weeklyRestSeen
    ? 'В данных виден достаточно длинный перерыв. Для päästeametnik при суммированном учёте ATS §41(3) требует не меньше 36 часов непрерывного отдыха за семидневный период. С 13.02.2026 эти 36 часов уже включают ежедневный и еженедельный отдых. Границы используемого семидневного периода PDF не показывает.'
    : 'Для päästeametnik при суммированном учёте ATS §41(3) требует не меньше 36 часов непрерывного отдыха за семидневный период. В видимой части месяца такого промежутка не найдено, но для окончательной проверки нужны соседние месяцы и границы семидневных периодов.'

  const averageTone: AnalysisTone = weeklyEquivalentHours > 48 ? 'attention' : 'info'
  const averageExplanation = weeklyEquivalentHours > 48
    ? 'Эквивалент этого месяца выше среднего предела 48 часов за 7 дней из ATS §36. Это ещё не доказывает превышение: предел считают по установленному периоду, а один месяц может уравновешиваться другим. PäästeTS допускает расчётный период службы до шести месяцев, при этом ограничение ATS §36 сформулировано для среднего за период до четырёх месяцев.'
    : 'При суммированном учёте обычные 40 часов могут распределяться по неделям неравномерно. ATS §36 ограничивает работу вместе со сверхурочной в среднем 48 часами за 7 дней за период до четырёх месяцев, а PäästeTS допускает расчётный период службы до шести месяцев. Один месяц показывает нагрузку, но не заменяет полный расчёт работодателя.'

  const checks: AnalysisCheck[] = []
  if (compensation.long.length) {
    checks.push(operationalCheck)
    checks.push({ id: 'shift-rest', tone: compensationTone, title: 'Отдых после оперативной смены', value: compensationValue, explanation: compensationExplanation })
  }
  checks.push(
    { id: 'weekly-rest', tone: weeklyTone, title: 'Еженедельный отдых', value: weeklyValue, explanation: weeklyExplanation },
    { id: 'average-time', tone: averageTone, title: 'Средняя нагрузка', value: `${weeklyEquivalentHours} ч / неделю`, explanation: averageExplanation },
  )
  if (homeDutyHours) checks.push({
    id: 'home-duty', tone: homeDutyHours > 155 ? 'attention' : 'ok', title: 'Домашнее дежурство V', value: `${homeDutyHours} из 155 ч`,
    explanation: 'Для päästeteenistuja PäästeTS §20(6) прямо считает valveaeg частью отдыха и ограничивает его 155 часами в месяц. Поэтому V не уменьшает рассчитанный свободный промежуток. Но время фактического вызова уже является работой; PDF его не содержит, и приложение не может прибавить его автоматически.',
  })
  if (shortenedShifts.length) checks.push({
    id: 'shortened-days', tone: 'info', title: 'Работа перед праздником', value: `${shortenedShifts.length} рабочий день`,
    explanation: 'ATS §42 сокращает на 3 часа рабочий день непосредственно перед Новым годом, Днём независимости, Днём победы и Рождеством. PDF показывает запланированные часы, но не основание и способ учёта оставшихся часов.',
  })

  return {
    month,
    deltaNumber,
    workHours,
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
