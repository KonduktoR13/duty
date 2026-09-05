import type { AnalysisCheck, AnalysisTone } from './month-analysis'

// Source edition used by these rules, not a claim of automated legal verification.
export const RULE_EDITION = {
  effectiveFrom: '2026-02-13',
  sources: [
    'https://www.riigiteataja.ee/akt/P%C3%A4%C3%A4steTS',
    'https://www.riigiteataja.ee/akt/ATS',
  ],
} as const
export const LIMITS = {
  compensatoryAfter: 13,
  weeklyRest: 36,
  weeklyAverage: 48,
  homeDuty: 155,
} as const

type Context = {
  compensation: {
    long: unknown[]
    failures: { end: number; next: number; actual: number; required: number }[]
    unknown: number
    minimumActual: number
  }
  hasFollowingMonth: boolean
  hasPreviousMonth: boolean
  gaps: { start: number; end: number; hours: number }[]
  weeklyRestSeen: boolean
  longestRestHours: number | undefined
  weeklyEquivalentHours: number
  homeDutyHours: number
  shortenedShifts: unknown[]
  roundHours: (minutes: number) => number
  hourText: (hours: number) => string
  wallLabel: (minutes: number) => string
}
export function evaluateRules(context: Context): AnalysisCheck[] {
  const {
    compensation,
    hasFollowingMonth,
    hasPreviousMonth,
    gaps,
    weeklyRestSeen,
    longestRestHours,
    weeklyEquivalentHours,
    homeDutyHours,
    shortenedShifts,
    roundHours,
    hourText,
    wallLabel,
  } = context
  const operationalCheck: AnalysisCheck = {
    id: 'operational-shifts',
    tone: 'ok',
    title: 'Оперативные смены',
    value: `${compensation.long.length} × 24 ч`,
    explanation:
      'Для päästeametnik 24-часовая оперативная смена предусмотрена специальным режимом PäästeTS §20(8): обычное ограничение ежедневного отдыха из ATS §41(1) не применяется, если работа не вредит здоровью и безопасности. Ограничение ночной работы также не применяется по PäästeTS §20(3) при том же условии и соблюдении среднего предела рабочего времени. Оценить риски здоровья по PDF невозможно.',
  }

  const compensationTone: AnalysisTone = compensation.failures.length
    ? 'attention'
    : compensation.unknown || !hasFollowingMonth
      ? 'info'
      : 'ok'
  const compensationValue = compensation.failures.length
    ? 'Меньше 11 ч'
    : Number.isFinite(compensation.minimumActual)
      ? `Минимум ${roundHours(compensation.minimumActual * 60)} ч`
      : 'Нужен следующий месяц'
  const compensationExplanation = compensation.failures.length
    ? 'После одной из 24-часовых оперативных смен следующая работа начинается раньше, чем закончились 11 часов компенсирующего отдыха. Для 24 часов ATS §41(4) требует немедленно дать 11 часов: это часы превышения над 13-часовой границей.'
    : 'После 24-часовой оперативной смены ATS §41(4) требует немедленный компенсирующий отдых, равный превышению 13 часов. Для смены 24 часа это 11 часов. Проверка учитывает следующую рабочую отметку, но не знает о фактических вызовах, которых нет в PDF.'
  const compensationFindings = compensation.failures.map(
    (item) =>
      `Смена закончилась ${wallLabel(item.end)}, следующая работа — ${wallLabel(item.next)}. Отдых ${hourText(item.actual)}, требуется ${hourText(item.required)}.`,
  )

  const weeklyTone: AnalysisTone =
    !gaps.length || !hasPreviousMonth || !hasFollowingMonth
      ? 'info'
      : weeklyRestSeen
        ? 'info'
        : 'attention'
  const weeklyValue =
    longestRestHours === undefined
      ? 'Недостаточно данных'
      : `Максимум ${roundHours(longestRestHours * 60)} ч`
  const longestGap = gaps.reduce<(typeof gaps)[number] | undefined>(
    (best, gap) => (!best || gap.hours > best.hours ? gap : best),
    undefined,
  )
  const weeklyExplanation = weeklyRestSeen
    ? 'В данных виден достаточно длинный перерыв. Для päästeametnik при суммированном учёте ATS §41(3) требует не меньше 36 часов непрерывного отдыха за семидневный период. С 13.02.2026 эти 36 часов уже включают ежедневный и еженедельный отдых. Границы используемого семидневного периода PDF не показывает.'
    : 'Для päästeametnik при суммированном учёте ATS §41(3) требует не меньше 36 часов непрерывного отдыха за семидневный период. В видимой части месяца такого промежутка не найдено, но для окончательной проверки нужны соседние месяцы и границы семидневных периодов.'

  const averageTone: AnalysisTone =
    weeklyEquivalentHours > LIMITS.weeklyAverage ? 'attention' : 'info'
  const averageExplanation =
    weeklyEquivalentHours > LIMITS.weeklyAverage
      ? 'Эквивалент этого месяца выше среднего предела 48 часов за 7 дней из ATS §36. Это ещё не доказывает превышение: предел считают по установленному периоду, а один месяц может уравновешиваться другим. PäästeTS допускает расчётный период службы до шести месяцев, при этом ограничение ATS §36 сформулировано для среднего за период до четырёх месяцев.'
      : 'При суммированном учёте обычные 40 часов могут распределяться по неделям неравномерно. ATS §36 ограничивает работу вместе со сверхурочной в среднем 48 часами за 7 дней за период до четырёх месяцев, а PäästeTS допускает расчётный период службы до шести месяцев. Один месяц показывает нагрузку, но не заменяет полный расчёт работодателя.'

  const checks: AnalysisCheck[] = []
  if (compensation.long.length) {
    checks.push(operationalCheck)
    checks.push({
      id: 'shift-rest',
      tone: compensationTone,
      title: 'Отдых после оперативной смены',
      value: compensationValue,
      explanation: compensationExplanation,
      findings: compensationFindings,
    })
  }
  checks.push(
    {
      id: 'weekly-rest',
      tone: weeklyTone,
      title: 'Еженедельный отдых',
      value: weeklyValue,
      explanation: weeklyExplanation,
      findings:
        weeklyTone === 'attention' && longestGap
          ? [
              `Самый длинный видимый перерыв: ${wallLabel(longestGap.start)}–${wallLabel(longestGap.end)}, всего ${hourText(longestGap.hours)}. Требуется не меньше 36 ч.`,
            ]
          : undefined,
    },
    {
      id: 'average-time',
      tone: averageTone,
      title: 'Средняя нагрузка',
      value: `${weeklyEquivalentHours} ч / неделю`,
      explanation: averageExplanation,
      findings:
        averageTone === 'attention'
          ? [
              `Эквивалент выбранного месяца — ${hourText(weeklyEquivalentHours)} в неделю, ориентир ATS §36 — 48 ч. Окончательный результат считается за полный расчётный период.`,
            ]
          : undefined,
    },
  )
  if (homeDutyHours)
    checks.push({
      id: 'home-duty',
      tone: homeDutyHours > LIMITS.homeDuty ? 'attention' : 'ok',
      title: 'Домашнее дежурство V',
      value: `${homeDutyHours} из ${LIMITS.homeDuty} ч`,
      explanation:
        'Для päästeteenistuja PäästeTS §20(6) прямо считает valveaeg частью отдыха и ограничивает его 155 часами в месяц. Поэтому V не уменьшает рассчитанный свободный промежуток. Но время фактического вызова уже является работой; PDF его не содержит, и приложение не может прибавить его автоматически.',
      findings:
        homeDutyHours > 155
          ? [
              `В графике ${hourText(homeDutyHours)} valveaeg — на ${hourText(homeDutyHours - 155)} больше месячного предела 155 ч.`,
            ]
          : undefined,
    })
  if (shortenedShifts.length)
    checks.push({
      id: 'shortened-days',
      tone: 'info',
      title: 'Работа перед праздником',
      value: `${shortenedShifts.length} рабочий день`,
      explanation:
        'ATS §42 сокращает на 3 часа рабочий день непосредственно перед Новым годом, Днём независимости, Днём победы и Рождеством. PDF показывает запланированные часы, но не основание и способ учёта оставшихся часов.',
    })

  return checks
}
