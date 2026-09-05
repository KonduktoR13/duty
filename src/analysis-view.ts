import { humanMonth } from './schedule'
import { candidateForMonth } from './roster'
import { analyzeMonth, type AnalysisCheck } from './month-analysis'
import { esc } from './ui'
import type { MonthRecord } from './types'
function formatAnalysisHours(value: number) {
  return String(Math.round(value * 10) / 10).replace('.', ',') + ' ч'
}

function analysisRule(check: AnalysisCheck) {
  const icon = check.tone === 'ok' ? '✓' : check.tone === 'attention' ? '!' : 'i'
  const findings = check.findings?.length
    ? '<ul class="analysis-findings">' +
      check.findings.map((finding) => '<li>' + esc(finding) + '</li>').join('') +
      '</ul>'
    : ''
  return (
    '<details class="analysis-rule ' +
    check.tone +
    '" id="analysis-' +
    check.id +
    '"' +
    (check.tone === 'attention' ? ' open' : '') +
    '><summary><i>' +
    icon +
    '</i><span><b>' +
    esc(check.title) +
    '</b><small>' +
    esc(check.value) +
    '</small></span><em>⌄</em></summary>' +
    findings +
    '<p>' +
    esc(check.explanation) +
    '</p></details>'
  )
}

function issueCountLabel(count: number) {
  const remainder = count % 100
  const ending =
    remainder >= 11 && remainder <= 14
      ? 'пунктов'
      : count % 10 === 1
        ? 'пункт'
        : count % 10 >= 2 && count % 10 <= 4
          ? 'пункта'
          : 'пунктов'
  return `${count} ${ending} для проверки`
}

export function analysisView(month: MonthRecord, months: MonthRecord[], currentDelta: string) {
  if (!months.length)
    return '<section class="analysis-empty"><div>◔</div><h2>Сначала добавьте график</h2><p>Анализ выполняется только на устройстве по данным импортированного PDF.</p><button class="primary" id="import">Импортировать PDF</button></section>'
  const navigation =
    '<nav class="months analysis-months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker" aria-label="Выбрать месяц"><span class="month-title">' +
    humanMonth(month.id) +
    '</span></button><button id="next" aria-label="Следующий месяц">›</button></nav>'
  const source = months.find((item) => item.id === month.id)
  if (!source || !candidateForMonth(source, currentDelta))
    return (
      navigation +
      '<section class="analysis-empty compact"><div>—</div><h2>Нет данных для ' +
      esc(currentDelta) +
      '</h2><p>Для ' +
      humanMonth(month.id) +
      ' график не загружен или в PDF нет выбранного D-номера.</p></section>'
    )
  const analysis = analyzeMonth(months, month.id, currentDelta)
  const totalParts = analysis.homeDutyHours
    ? '<span>+ ' + formatAnalysisHours(analysis.homeDutyHours) + ' valveaeg отдельно</span>'
    : '<span>Рабочее время по графику</span>'
  const tentative = analysis.tentativeHours
    ? '<p class="analysis-tentative">Возможные выходы # не включены: ' +
      formatAnalysisHours(analysis.tentativeHours) +
      '</p>'
    : ''
  const leave = analysis.leaveDays
    ? '<div><b>' + analysis.leaveDays + '</b><span>дней с отпуском</span></div>'
    : ''
  const boundary =
    !analysis.hasPreviousMonth || !analysis.hasFollowingMonth || analysis.incompleteDays.length > 0
      ? '<aside class="analysis-boundary"><b>Границы месяца видны не полностью</b><span>Для проверки отдыха нужны соседние месяцы с номером ' +
        esc(currentDelta) +
        '. ' +
        (analysis.incompleteDays.length
          ? 'Не подтверждено продолжение смен: ' +
            analysis.incompleteDays.map((day) => day.slice(8)).join(', ') +
            '.'
          : '') +
        '</span></aside>'
      : ''
  const attention = analysis.checks.filter((check) => check.tone === 'attention')
  const issueLinks = attention
    .map(
      (check) =>
        '<li><button class="analysis-jump" data-analysis-jump="analysis-' +
        check.id +
        '"><span>' +
        esc(check.title) +
        '</span><b>' +
        esc(check.value) +
        '</b><i>↓</i></button></li>',
    )
    .join('')
  const verdict = attention.length
    ? '<section class="analysis-verdict attention"><i>!</i><div><b>Найдено ' +
      issueCountLabel(attention.length) +
      '</b><span>Нажмите на причину — откроется точный расчёт.</span><ul class="analysis-issue-links">' +
      issueLinks +
      '</ul></div></section>'
    : '<section class="analysis-verdict"><i>✓</i><div><b>В видимых данных отклонений не найдено</b><span>Проверены числовые условия, которые можно восстановить из PDF.</span></div></section>'
  return (
    navigation +
    '<div class="analysis-mode"><b>Päästeametnik · Demineerimiskeskus</b><span>Summeeritud tööajaarvestus</span></div><section class="analysis-summary"><small>' +
    esc(currentDelta) +
    ' · рабочее время</small><strong>' +
    formatAnalysisHours(analysis.workHours) +
    '</strong>' +
    totalParts +
    '<div class="analysis-accounting"><span>По исходному PDF: <b>' +
    formatAnalysisHours(analysis.pdfHours) +
    '</b></span><span>В пределах месяца: <b>' +
    formatAnalysisHours(analysis.calendarHours) +
    '</b></span><details><summary>Как считаются часы</summary><small>Крупное число — полные смены, начавшиеся в месяце. В пределах месяца часы обрезаются по полуночи; предыдущая смена учитывается, если есть её график. Часы плановые, по местному времени.</small></details></div><div class="hours-bar" aria-label="Дневные ' +
    formatAnalysisHours(analysis.dayHours) +
    ', ночные ' +
    formatAnalysisHours(analysis.nightHours) +
    '"><i data-night="' +
    (analysis.workHours ? (analysis.nightHours / analysis.workHours) * 100 : 0) +
    '"></i></div><div class="hours-key"><span><i class="day-hours"></i>Дневные 06–22 <b>' +
    formatAnalysisHours(analysis.dayHours) +
    '</b></span><span><i class="night-hours"></i>Ночные 22–06 <b>' +
    formatAnalysisHours(analysis.nightHours) +
    '</b></span></div></section><p class="analysis-context"><b>24 ч — оперативная смена.</b> Остальные отметки, обычно 8 или 12 ч, показаны как служебные рабочие дни: это могут быть обучение, учения или дни командировки. Точную причину PDF не кодирует.</p>' +
    tentative +
    '<section class="analysis-metrics"><div><b>' +
    analysis.operationalShiftCount +
    '</b><span>оперативных смен · 24 ч</span></div><div><b>' +
    analysis.workdayCount +
    '</b><span>служебных рабочих дней</span></div><div><b>' +
    formatAnalysisHours(analysis.homeDutyHours) +
    '</b><span>valveaeg · V</span></div>' +
    leave +
    '</section>' +
    boundary +
    verdict +
    '<section class="law-analysis"><header><div><small>Предварительная оценка · päästeametnik</small><h2>Служба и отдых по закону</h2></div><span>PäästeTS</span></header><p class="law-intro">Показаны только применимые к вашему графику правила. Откройте пункт, чтобы увидеть норму и расчёт простым языком.</p>' +
    analysis.checks.map(analysisRule).join('') +
    '<aside class="legal-disclaimer"><b>Важно</b><span>Расчёт предполагает, что выбранный D-номер относится к päästeametnik Demineerimiskeskus. Это справочная автоматическая оценка, не юридическое заключение. PDF не показывает фактические вызовы во время V, сверхурочную работу вне графика, оценку рисков и полный расчётный период.</span><a href="https://www.riigiteataja.ee/akt/P%C3%A4%C3%A4steTS" target="_blank" rel="noopener">Päästeteenistuse seadus ↗</a><a href="https://www.riigiteataja.ee/akt/ATS" target="_blank" rel="noopener">Avaliku teenistuse seadus ↗</a><small>Учтены специальные нормы PäästeTS §20 и действующая с 13.02.2026 редакция ATS §41.</small></aside></section>'
  )
}
