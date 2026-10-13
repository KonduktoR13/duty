import { humanMonth } from './schedule'
import { candidateForMonth } from './roster'
import { analyzeMonth, type AnalysisCheck } from './month-analysis'
import { esc } from './ui'
import { salaryForecast } from './salary-calculation'
import { rankEmployeeWorkload, type EmployeeWorkloadSort } from './employee-workload'
import type { MonthRecord, SalarySettings } from './types'
function formatAnalysisHours(value: number) {
  return String(Math.round(value * 10) / 10).replace('.', ',') + ' ч'
}

function money(value: number) {
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + ' €'
}

function rate(value: number) {
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value) + ' €/ч'
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

function employeeWorkloadView(months: MonthRecord[], monthId: string, currentDelta: string, sort: EmployeeWorkloadSort) {
  const rows = rankEmployeeWorkload(months, monthId, sort)
  if (!rows.length) return ''
  const own = rows.find(row => row.deltaNumber === currentDelta)
  const position = own ? ` · ${esc(currentDelta)}: ${own.rank} из ${rows.length}` : ''
  const sortLabel = sort === 'total' ? 'Всего' : 'За месяц'
  const sortHeader = (mode: EmployeeWorkloadSort, label: string, description: string) => `<th scope="col" class="employee-workload-sort" aria-sort="${sort === mode ? 'descending' : 'none'}"><button id="employee-workload-sort-${mode}" data-workload-sort="${mode}" aria-label="${description}, по убыванию">${label}${sort === mode ? ' <span aria-hidden="true">↓</span>' : ''}</button></th>`
  return `<details class="employee-workload" id="employee-workload" data-month="${esc(monthId)}" data-sort="${sort}">
    <summary id="employee-workload-toggle"><span><b>Нагрузка сотрудников</b><small>D-номеров: ${rows.length}${position} · ${sortLabel}</small></span><i aria-hidden="true">⌄</i></summary>
    <div class="employee-workload-content">
      <table aria-label="Рейтинг сотрудников по рабочим часам за ${esc(humanMonth(monthId))}" aria-describedby="employee-workload-note">
        <thead><tr><th scope="col">Место</th><th scope="col">D-номер</th>${sortHeader('month', 'Месяц, ч', 'Сортировать по часам за месяц')}${sortHeader('total', 'Всего, ч', 'Сортировать по общим часам')}</tr></thead>
        <tbody>${rows.map(row => `<tr${row.deltaNumber === currentDelta ? ' class="employee-workload-own"' : ''}>
          <td>${row.rank}</td><th scope="row">${esc(row.deltaNumber)}${row.deltaNumber === currentDelta ? '<small>Вы</small>' : ''}</th>
          <td>${String(row.monthHours).replace('.', ',')}</td><td>${String(row.totalHours).replace('.', ',')}${row.availableMonths < months.length ? `<small>${row.availableMonths} из ${months.length} мес.</small>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p id="employee-workload-note">Нажмите «Месяц, ч» или «Всего, ч», чтобы выбрать сортировку по убыванию. Переходящие смены делятся по полуночи; V и возможные выходы # не включены. Всего — за загруженные месяцы (${months.length}). Без соседних графиков данные на границах могут быть неполными.</p>
      ${sourceRosterIncomplete(months, monthId) ? '<p class="employee-workload-note">В сохранённом графике доступны не все D-номера. Для полного списка импортируйте PDF повторно.</p>' : ''}
    </div>
  </details>`
}

function sourceRosterIncomplete(months: MonthRecord[], monthId: string) {
  const source = months.find(month => month.id === monthId)
  return source && (!source.candidates?.length || source.rosterComplete === false)
}

export function analysisView(month: MonthRecord, months: MonthRecord[], currentDelta: string, salarySettings: SalarySettings, workloadSort: EmployeeWorkloadSort = 'month') {
  if (!months.length)
    return '<section class="analysis-empty"><div>◔</div><h2>Сначала добавьте график</h2><p>Анализ выполняется только на устройстве по данным импортированного PDF.</p><button class="primary" id="import">Импортировать PDF</button></section>'
  const navigation =
    '<nav class="months analysis-months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker" aria-label="Выбрать месяц"><span class="month-title">' +
    humanMonth(month.id) +
    '</span></button><button id="next" aria-label="Следующий месяц">›</button></nav>'
  const source = months.find((item) => item.id === month.id)
  const employeeWorkload = employeeWorkloadView(months, month.id, currentDelta, workloadSort)
  if (!source || !candidateForMonth(source, currentDelta))
    return (
      navigation +
      '<section class="analysis-empty compact"><div>—</div><h2>Нет данных для ' +
      esc(currentDelta) +
      '</h2><p>Для ' +
      humanMonth(month.id) +
      ' график не загружен или в PDF нет выбранного D-номера.</p></section>' +
      employeeWorkload
    )
  const analysis = analyzeMonth(months, month.id, currentDelta)
  const salary = salaryForecast(month.id, analysis.calendarNightHours, salarySettings, {
    homeDutyHours: analysis.calendarHomeDutyHours,
    publicHolidayHours: analysis.publicHolidayHours,
    vacationDays: analysis.paidVacationDays,
  })
  const salaryRow = (label: string, value: number, detail = '') => '<div><span>' + label + '</span><b>+ ' + money(value) + '</b>' + (detail ? '<small>' + detail + '</small>' : '') + '</div>'
  const replacement = salary.replacementAllowance === undefined
    ? ''
    : salaryRow('Asendamise tasu · ' + String(salarySettings.replacementPercent).replace('.', ',') + '%', salary.replacementAllowance)
  const homeDuty = salary.homeDutyHours ? salaryRow('Valveaeg · ' + String(salarySettings.homeDutyPercent).replace('.', ',') + '%', salary.homeDutyPremium, formatAnalysisHours(salary.homeDutyHours) + ' × ' + money(salary.homeDutyHourlyPremium) + '/ч') : ''
  const holiday = salary.publicHolidayHours ? salaryRow('Töö riiklikul pühal · 100%', salary.publicHolidayPremium, formatAnalysisHours(salary.publicHolidayHours) + ' × ' + money(salary.publicHolidayHourlyPremium) + '/ч') : ''
  const vacation = salary.vacationPay === undefined ? '' : salaryRow('Puhkusetasu · оценка', salary.vacationPay, salary.vacationDays + ' дн. × ' + money(salarySettings.vacationDailyRate))
  const baseDetail = salary.vacationDays ? '<small>Месячная ставка ' + money(salarySettings.baseSalary) + '; часть за месяц оценочная</small>' : ''
  const leaveWarning = salary.vacationDays ? ' При отпуске уменьшение põhipalk оценивается по календарным дням и может отличаться от бухгалтерского табеля.' : ''
  const salaryCard = '<section class="salary-forecast"><div class="salary-head"><div><small>Прогноз · до налогов</small><h2>Зарплатные показатели</h2></div><button id="analysis-salary-settings" aria-label="Настроить расчёт зарплаты">⚙</button></div><div class="salary-grid"><div><span>Põhipalk' + (salary.vacationDays ? ' · часть месяца' : '') + '</span><b>' + money(salary.basePay) + '</b>' + baseDetail + '</div><div><span>Часовая ставка</span><b>' + rate(salary.hourlyRate) + '</b></div><div><span>Ночные часы месяца · 22–06</span><b>' + formatAnalysisHours(salary.nightHours) + '</b></div><div class="salary-night"><span>Öötöö 25%</span><b>+ ' + money(salary.nightPremium) + '</b><small>' + money(salary.nightHourlyPremium) + '/ч после округления</small></div>' + homeDuty + holiday + vacation + replacement + '</div><div class="salary-totals"><div><span>Примерно начислено · bruto</span><b>' + money(salary.gross) + '</b></div><div class="salary-net"><span>Примерно на руки · neto</span><strong>' + money(salary.net) + '</strong></div><details><summary>Удержания: − ' + money(salary.unemployment + salary.fundedPension + salary.incomeTax) + '</summary><small>Töötuskindlustus: ' + money(salary.unemployment) + ' · kogumispension: ' + money(salary.fundedPension) + ' · tulumaks: ' + money(salary.incomeTax) + '. Maksuvaba tulu: ' + money(salarySettings.taxFreeAllowance) + '.</small></details></div><p>Норма месяца: <b>' + salary.normHours + ' ч · ' + salary.normDays + ' раб. дн.</b> По плановому D-графику. Не включены непредсказуемые больничные, премии и сверхурочные.' + leaveWarning + '</p></section>'
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
    employeeWorkload +
    salaryCard +
    boundary +
    verdict +
    '<section class="law-analysis"><header><div><small>Предварительная оценка · päästeametnik</small><h2>Служба и отдых по закону</h2></div><span>PäästeTS</span></header><p class="law-intro">Показаны только применимые к вашему графику правила. Откройте пункт, чтобы увидеть норму и расчёт простым языком.</p>' +
    analysis.checks.map(analysisRule).join('') +
    '<aside class="legal-disclaimer"><b>Важно</b><span>Расчёт предполагает, что выбранный D-номер относится к päästeametnik Demineerimiskeskus. Это справочная автоматическая оценка, не юридическое заключение. PDF не показывает фактические вызовы во время V, сверхурочную работу вне графика, оценку рисков и полный расчётный период.</span><a href="https://www.riigiteataja.ee/akt/P%C3%A4%C3%A4steTS" target="_blank" rel="noopener">Päästeteenistuse seadus ↗</a><a href="https://www.riigiteataja.ee/akt/ATS" target="_blank" rel="noopener">Avaliku teenistuse seadus ↗</a><small>Учтены специальные нормы PäästeTS §20 и действующая с 13.02.2026 редакция ATS §41.</small></aside></section>'
  )
}
