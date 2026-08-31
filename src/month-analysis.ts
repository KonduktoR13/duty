import { buildCalendarDrafts } from './calendar-sync'
import { allMarksForDelta } from './roster'
import type { CalendarEventDraft, MonthRecord } from './types'

export type AnalysisTone = 'ok' | 'attention' | 'info'
export type AnalysisCheck = {
  id: 'long-shifts' | 'daily-rest' | 'weekly-rest' | 'average-time' | 'night-work' | 'home-duty' | 'shortened-days' | 'breaks'
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
  shiftCount: number
  longShiftCount: number
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
  let shortestMargin = Number.POSITIVE_INFINITY
  for (const shift of long) {
    const next = allOccupied.find(interval => interval !== shift && interval.start >= shift.end)
    if (!next) { unknown++; continue }
    const actual = (next.start - shift.end) / 60
    const required = 11 + (shift.draft.hours - 13)
    shortestMargin = Math.min(shortestMargin, actual - required)
    if (actual < required) failures++
  }
  return { long, failures, unknown, shortestMargin }
}

export function analyzeMonth(months: MonthRecord[], month: string, deltaNumber: string): MonthAnalysis {
  const marks = allMarksForDelta(months, deltaNumber)
  const allDrafts = draftsForAllMonths(months, deltaNumber)
  const selectedDrafts = allDrafts.filter(draft => draft.date.startsWith(month + '-'))
  const onsiteDrafts = selectedDrafts.filter(draft => draft.kind === 'hours')
  const homeDrafts = selectedDrafts.filter(draft => draft.kind === 'home')
  const onsiteIntervals = intervals(allDrafts.filter(draft => draft.kind === 'hours'))
  const allOccupiedIntervals = intervals(allDrafts)
  const occupied = mergeIntervals(allOccupiedIntervals)
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
  const compensation = compensationCheck(onsiteIntervals, allOccupiedIntervals, month)
  const minimumRestHours = gaps.length ? Math.min(...gaps.map(gap => gap.hours)) : undefined
  const longestRestHours = gaps.length ? Math.max(...gaps.map(gap => gap.hours)) : undefined
  const dailyFailure = gaps.some(gap => gap.hours < 11)
  const weeklyRestSeen = gaps.some(gap => gap.hours >= 36)
  const shortenedDates = new Set([`${month.slice(0, 4)}-02-23`, `${month.slice(0, 4)}-06-22`, `${month.slice(0, 4)}-12-23`, `${month.slice(0, 4)}-12-31`])
  const shortenedShifts = onsiteDrafts.filter(draft => shortenedDates.has(draft.date))

  const longShiftCheck: AnalysisCheck = compensation.long.length
    ? {
        id: 'long-shifts', tone: 'info', title: 'Смены длиннее 13 часов', value: `${compensation.long.length} × 24 ч`,
        explanation: 'Обычно рабочий день ограничен 13 часами, потому что за каждые 24 часа нужно дать 11 часов непрерывного отдыха. Смена до 24 часов допустима только для предусмотренной законом работы и при необходимых условиях — например, коллективном соглашении или специальном исключении и оценке рисков. PDF не показывает, выполнены ли эти условия.',
      }
    : {
        id: 'long-shifts', tone: 'ok', title: 'Длина смен', value: 'Не больше 13 ч',
        explanation: 'В этом месяце приложение не нашло смен длиннее общей 13-часовой границы.',
      }

  let compensationTone: AnalysisTone = 'ok'
  let compensationValue = minimumRestHours === undefined ? 'Недостаточно данных' : `Минимум ${roundHours(minimumRestHours * 60)} ч`
  let compensationExplanation = 'Между показанными рабочими периодами найдено не меньше 11 часов непрерывного отдыха.'
  if (dailyFailure || compensation.failures) {
    compensationTone = 'attention'
    compensationValue = 'Нужно проверить'
    compensationExplanation = 'Между некоторыми показанными периодами отдыха меньше расчётного минимума. Домашнее дежурство V тоже не считается обычным свободным отдыхом, хотя фактическое время вызовов PDF не показывает.'
  } else if (!gaps.length || compensation.unknown || !hasFollowingMonth || !hasPreviousMonth) {
    compensationTone = 'info'
    compensationExplanation = 'Для полной проверки нужны соседние месяцы. После 24-часовой смены до следующей работы должно пройти 22 часа: обычные 11 часов плюс ещё 11 часов за превышение 13-часовой границы.'
  } else if (compensation.long.length) {
    compensationExplanation = 'Показанные интервалы отдыха проходят расчётную проверку. После 24-часовой смены приложение требует 22 часа до следующей работы: 11 обычных + 11 компенсирующих.'
  }

  const weeklyTone: AnalysisTone = !gaps.length || !hasPreviousMonth || !hasFollowingMonth ? 'info' : weeklyRestSeen ? 'info' : 'attention'
  const weeklyValue = longestRestHours === undefined ? 'Недостаточно данных' : `Максимум ${roundHours(longestRestHours * 60)} ч`
  const weeklyExplanation = weeklyRestSeen
    ? 'В данных виден хотя бы один достаточно длинный перерыв. При суммированном рабочем времени нужен минимум 36 часов непрерывного отдыха за семидневный период. По действующей с 13.02.2026 редакции TLS §52(4) эти 36 часов уже включают ежедневный отдых — прибавлять ещё 11 часов не нужно. Границы расчётной недели PDF не показывает.'
    : 'При суммированном рабочем времени нужен минимум 36 часов непрерывного отдыха за семидневный период. С 13.02.2026 ежедневный отдых входит в эти 36 часов. В видимой части месяца такого промежутка не найдено, но для окончательного вывода нужны соседние месяцы и границы используемых работодателем семидневных периодов.'

  const averageTone: AnalysisTone = weeklyEquivalentHours > 48 ? 'attention' : 'info'
  const averageExplanation = weeklyEquivalentHours > 48
    ? 'Если пересчитать только этот месяц на неделю, получается больше обычного среднего предела 48 часов. Юридически среднее считают за согласованный период, обычно до четырёх месяцев, поэтому соседние месяцы могут изменить результат.'
    : 'Обычный предел вместе со сверхурочной работой — в среднем 48 часов за 7 дней за расчётный период до четырёх месяцев. Это только эквивалент одного месяца, а не окончательная проверка всего периода.'

  return {
    month,
    deltaNumber,
    workHours,
    dayHours,
    nightHours,
    homeDutyHours,
    tentativeHours,
    shiftCount: onsiteDrafts.length,
    longShiftCount: compensation.long.length,
    leaveDays,
    minimumRestHours,
    longestRestHours,
    weeklyEquivalentHours,
    hasFollowingMonth,
    hasPreviousMonth,
    checks: [
      longShiftCheck,
      { id: 'daily-rest', tone: compensationTone, title: 'Отдых между сменами', value: compensationValue, explanation: compensationExplanation },
      { id: 'weekly-rest', tone: weeklyTone, title: 'Еженедельный отдых', value: weeklyValue, explanation: weeklyExplanation },
      { id: 'average-time', tone: averageTone, title: 'Средняя нагрузка', value: `${weeklyEquivalentHours} ч / неделю`, explanation: averageExplanation },
      {
        id: 'night-work', tone: 'info', title: 'Ночная работа', value: `${nightHours} ч`,
        explanation: 'По действующему Töölepingu seadus ночное время — с 22:00 до 06:00. Период до 10:00 законом целиком ночным не считается. Ограничения для ночного работника зависят также от регулярности ночной работы, оценки рисков и возможных исключений; одного месячного PDF для этого недостаточно.',
      },
      {
        id: 'home-duty', tone: 'info', title: 'Домашнее дежурство V', value: `${homeDutyHours} ч отдельно`,
        explanation: homeDutyHours
          ? 'Koduvalve — время готовности приступить к работе, а не автоматически отработанные часы. Фактический вызов считается рабочим временем. Обычное домашнее дежурство нельзя одновременно считать обязательным ежедневным или еженедельным отдыхом, поэтому приложение учитывает V при поиске свободных промежутков, но не прибавляет все V-часы к отработанным.'
          : 'В этом месяце кодов V нет. Если они появятся, приложение покажет koduvalve отдельно от фактически отработанных часов и учтёт его при анализе отдыха.',
      },
      {
        id: 'shortened-days', tone: shortenedShifts.length ? 'info' : 'ok', title: 'Дни перед праздниками', value: shortenedShifts.length ? `${shortenedShifts.length} смен` : 'Особых дат нет',
        explanation: shortenedShifts.length
          ? 'Рабочий день 23 февраля, 22 июня, 23 декабря и 31 декабря работодатель должен сократить на 3 часа. Если непрерывная работа требует полной смены, оставшиеся часы требуют отдельного правового основания и учёта. PDF показывает план, но не соглашение и компенсацию.'
          : 'В этом месяце нет смен, начинающихся 23 февраля, 22 июня, 23 декабря или 31 декабря — дат, когда рабочий день сокращается на 3 часа.',
      },
      {
        id: 'breaks', tone: 'info', title: 'Перерывы внутри смены', value: 'PDF не показывает',
        explanation: 'При работе дольше 6 часов обычно положен перерыв не менее 30 минут. По одному коду 8, 12 или 24 невозможно понять, когда был перерыв и входит ли он в рабочее время, поэтому приложение это не оценивает.',
      },
    ],
  }
}
