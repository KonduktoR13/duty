import { humanMonth, timeLabel } from './schedule'
import {
  candidateForMonth,
  foreignEntriesByDate,
  isWorkMark,
  type ForeignDayEntry,
  type WorkMark,
} from './roster'
import { buildCalendarDrafts } from './calendar-sync'
import { esc } from './ui'
import type { DayMark, MonthRecord } from './types'

type CalendarViewState = {
  months: MonthRecord[]
  currentDelta: string
  selectedDate: string | null
  legendExpanded: boolean
  showColleagues: boolean
  calendarMode: 'grid' | 'list'
  allMarks: () => DayMark[]
  groupMarks: (marks: DayMark[]) => Map<string, DayMark[]>
  todayId: () => string
  date: (value: string) => string
  calendarSyncCard: (month: MonthRecord) => string
}
export function createCalendarView(state: CalendarViewState) {
  const {
    months,
    currentDelta,
    selectedDate,
    legendExpanded,
    showColleagues,
    calendarMode,
    allMarks,
    groupMarks,
    todayId,
    date,
    calendarSyncCard,
  } = state
  const displayCode = (mark: Pick<WorkMark, 'raw'> | DayMark) =>
    mark.raw === '16+8' ? '24' : mark.raw
  const hoursText = (hours: number) => `${String(hours).replace('.', ',')} ч`
  function isMonthBoundaryPart(mark: DayMark) {
    if (mark.kind !== 'hours' || mark.hours !== 16 || !/^16$/i.test(mark.raw)) return false
    const value = new Date(mark.date + 'T12:00:00')
    return value.getDate() === new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
  }

  function markDescription(mark: DayMark, compact = false) {
    if (mark.kind === 'leave') return mark.raw === 'LHPu' ? 'Отпуск по уходу за ребёнком' : 'Отпуск'
    if (mark.kind === 'tentative')
      return compact
        ? `${mark.raw} · возможный выход`
        : `Возможный выход на работу · ${hoursText(mark.hours)} · ещё не подтверждён`
    if (mark.kind === 'other')
      return compact ? `Код ${mark.raw}` : `Прочая отметка из PDF · код ${mark.raw}`
    if (mark.kind === 'home')
      return compact
        ? `${mark.raw} · дома`
        : `Домашнее дежурство (koduvalve) · ${hoursText(mark.hours)} · код ${mark.raw}`
    if (mark.hours === 24)
      return compact
        ? 'Суточная смена · 24 ч'
        : `Суточная смена · ${timeLabel({ date: mark.date, hours: mark.hours, code: mark.raw })} · код 24`
    if (mark.hours === 12)
      return compact ? '12 ч на месте' : 'Дневной график · 12 ч на месте 08:00–20:00 · код 12'
    if (isMonthBoundaryPart(mark))
      return compact
        ? '16 ч · часть смены на границе месяца'
        : 'Часть смены на границе месяца · в этом PDF указано 16 ч; продолжение сверяется со следующим месяцем'
    return compact
      ? `${hoursText(mark.hours)} · код ${mark.raw}`
      : `${hoursText(mark.hours)} · ${timeLabel({ date: mark.date, hours: mark.hours, code: mark.raw })} · код ${mark.raw}`
  }

  function foreignMarkDescription(mark: DayMark, marks: DayMark[], deltaNumber: string) {
    if (!isWorkMark(mark)) return markDescription(mark)
    const draft = buildCalendarDrafts(mark.date.slice(0, 7), deltaNumber, marks).find(
      (item) => item.raw === mark.raw && item.kind === mark.kind,
    )
    if (!draft) return markDescription(mark)
    const start = draft.start.dateTime.slice(11, 16)
    const end = draft.end.dateTime.slice(11, 16)
    const nextDay = draft.start.dateTime.slice(0, 10) !== draft.end.dateTime.slice(0, 10)
    const type =
      mark.kind === 'home'
        ? 'Домашнее дежурство (koduvalve)'
        : mark.hours === 24
          ? 'Суточная смена'
          : 'Рабочая отметка'
    return `${type} · код ${mark.raw} · ${start}–${end}${nextDay ? ' следующего дня' : ''}`
  }

  function foreignEntriesHtml(entries: ForeignDayEntry[], ownDay: boolean) {
    if (!entries.length)
      return ownDay
        ? '<section class="coworkers-block empty"><b>Других смен нет</b><span>В исходном графике на это время другие D-номера не найдены.</span></section>'
        : ''
    const heading = ownDay
      ? 'Другие на работе · ' + entries.length
      : entries.length > 1
        ? 'Другие D-номера · ' + entries.length
        : 'Другой D-номер · ' + esc(entries[0].deltaNumber)
    const note = ownDay
      ? '<span class="not-yours">Не ваши смены</span>'
      : '<span class="not-yours">У вас смены нет · показаны другие сотрудники</span>'
    const rows = entries
      .map(
        (entry) =>
          '<section class="foreign-entry"><strong>' +
          esc(entry.deltaNumber) +
          '</strong><div class="detail-lines">' +
          entry.marks
            .map(
              (mark) =>
                '<div class="detail-line ' +
                mark.kind +
                '"><i></i><div><b>' +
                esc(displayCode(mark)) +
                '</b><span>' +
                esc(foreignMarkDescription(mark, entry.marks, entry.deltaNumber)) +
                '</span></div></div>',
            )
            .join('') +
          '</div></section>',
      )
      .join('')
    return (
      '<details class="coworkers-block' +
      (ownDay ? ' alongside-own' : '') +
      '"' +
      (ownDay ? '' : ' open') +
      '><summary class="coworkers-heading"><b class="foreign-title">' +
      heading +
      '</b>' +
      note +
      '</summary><div class="foreign-entries">' +
      rows +
      '</div></details>'
    )
  }

  function dayTone(marks: DayMark[]) {
    const has24 = marks.some((mark) => mark.kind === 'hours' && mark.hours === 24)
    const hasBoundary = marks.some(isMonthBoundaryPart)
    const hasDay = marks.some(
      (mark) => mark.kind === 'hours' && mark.hours !== 24 && !isMonthBoundaryPart(mark),
    )
    const hasTentative = marks.some((mark) => mark.kind === 'tentative')
    const hasHome = marks.some((mark) => mark.kind === 'home')
    const hasOther = marks.some((mark) => mark.kind === 'other')
    const leave = marks.find(
      (mark): mark is Extract<DayMark, { kind: 'leave' }> => mark.kind === 'leave',
    )
    if (has24 && hasHome) return 'mixed-duty-home'
    if (hasDay && hasHome) return 'mixed-day-home'
    if (hasTentative && hasHome) return 'mixed-tentative-home'
    if (hasDay && hasTentative) return 'mixed-day-tentative'
    if (has24) return 'duty-24'
    if (hasBoundary) return 'boundary-shift'
    if (hasDay) return 'day-schedule'
    if (hasTentative) return 'tentative-shift'
    if (hasHome && hasOther) return 'mixed-home-other'
    if (hasHome) return 'home-duty'
    if (leave?.raw === 'LHPu') return 'leave-childcare'
    if (leave) return 'leave-vacation'
    return hasOther ? 'other-code' : ''
  }

  function dayAria(dateKey: string, marks: DayMark[]) {
    return `${date(dateKey)}: ${marks.map((mark) => markDescription(mark)).join('; ')}`
  }

  function calendarPage(
    month: MonthRecord,
    marksByDate: Map<string, DayMark[]>,
    suppliedForeign?: Map<string, ForeignDayEntry[]>,
  ) {
    const currentDay = todayId()
    const value = new Date(month.id + '-01T12:00:00')
    const offset = (value.getDay() + 6) % 7
    const totalDays = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
    const foreignByDate = suppliedForeign || foreignEntriesByDate(months, month.id, currentDelta)
    const cells: string[] = Array.from(
      { length: offset },
      () => '<i class="day-blank" aria-hidden="true"></i>',
    )
    for (let day = 1; day <= totalDays; day++) {
      const dateKey = month.id + '-' + String(day).padStart(2, '0')
      const marks = marksByDate.get(dateKey) || []
      const hasColleagues =
        showColleagues && !marks.length && (foreignByDate.get(dateKey)?.length || 0) > 0
      if (!marks.length) {
        const label = hasColleagues
          ? `${date(dateKey)}: есть смены других D-номеров`
          : `${date(dateKey)}: нет смен`
        cells.push(
          '<button class="day day-empty ' +
            (hasColleagues ? 'has-colleagues ' : '') +
            (selectedDate === dateKey ? 'selected ' : '') +
            (dateKey === currentDay ? 'today' : '') +
            '" data-day="' +
            dateKey +
            '"' +
            (dateKey === currentDay ? ' aria-current="date"' : '') +
            ' aria-label="' +
            esc(label) +
            '"><b>' +
            day +
            '</b>' +
            (hasColleagues ? '<i class="colleague-dot" aria-hidden="true"></i>' : '') +
            '</button>',
        )
        continue
      }
      const regularCodes = marks.filter((mark) => mark.kind !== 'home').map(displayCode)
      const homeCodes = marks
        .filter((mark): mark is WorkMark => mark.kind === 'home')
        .map(displayCode)
      const code = marks.map(displayCode).join('+')
      const codeHtml =
        regularCodes.length && homeCodes.length
          ? '<small>' +
            esc(regularCodes.join('+')) +
            '</small><em class="home-badge">' +
            esc(homeCodes.join('+')) +
            '</em>'
          : '<small>' + esc(code) + '</small>'
      const classes = [
        'day',
        dayTone(marks),
        selectedDate === dateKey ? 'selected' : '',
        dateKey === currentDay ? 'today' : '',
      ]
        .filter(Boolean)
        .join(' ')
      cells.push(
        '<button class="' +
          classes +
          '" data-day="' +
          dateKey +
          '"' +
          (dateKey === currentDay ? ' aria-current="date"' : '') +
          ' aria-label="' +
          esc(dayAria(dateKey, marks)) +
          '"><b>' +
          day +
          '</b>' +
          codeHtml +
          '</button>',
      )
    }
    while (cells.length % 7) cells.push('<i class="day-blank" aria-hidden="true"></i>')
    return (
      '<div class="calendar-page" data-month="' +
      month.id +
      '"><div class="grid">' +
      cells.join('') +
      '</div></div>'
    )
  }

  function selectedDetails(
    marksByDate: Map<string, DayMark[]>,
    month: MonthRecord,
    foreignByDate: Map<string, ForeignDayEntry[]>,
  ) {
    if (!selectedDate) return ''
    const marks = marksByDate.get(selectedDate) || []
    if (!marks.length) {
      const entries = foreignByDate.get(selectedDate) || []
      const content = entries.length
        ? foreignEntriesHtml(entries, false)
        : '<b>Нет смен</b><span class="empty-detail">В исходном графике на этот день рабочих отметок нет.</span>'
      return (
        '<section class="shift-details ' +
        (entries.length ? 'foreign-details' : 'empty-details') +
        '" id="shift-details" aria-label="Информация за ' +
        esc(date(selectedDate)) +
        '"><i class="detail-handle" aria-hidden="true"></i><div class="detail-icon">' +
        (entries.length ? 'D' : '—') +
        '</div><div class="detail-content"><small>' +
        date(selectedDate) +
        '</small>' +
        content +
        '</div><button class="detail-close" id="detail-close" aria-label="Закрыть информацию о дне">×</button></section>'
      )
    }
    const hasHome = marks.some((mark) => mark.kind === 'home')
    const onlyHome = hasHome && marks.every((mark) => mark.kind === 'home' || mark.kind === 'other')
    const onlyLeave = marks.every((mark) => mark.kind === 'leave')
    const onlyOther = marks.every((mark) => mark.kind === 'other')
    const onlyTentative = marks.every((mark) => mark.kind === 'tentative')
    const icon = onlyLeave ? '☼' : onlyHome ? '⌂' : onlyTentative ? '?' : onlyOther ? '⋯' : '◷'
    const lines = marks
      .map(
        (mark) =>
          '<div class="detail-line ' +
          mark.kind +
          '"><i></i><div><b>' +
          esc(displayCode(mark)) +
          '</b><span>' +
          esc(markDescription(mark)) +
          '</span></div></div>',
      )
      .join('')
    const source16 =
      candidateForMonth(month, currentDelta)?.marks.some(
        (mark) => mark.date === selectedDate && mark.kind === 'hours' && mark.raw === '16',
      ) && marks.some((mark) => mark.kind === 'hours' && mark.hours === 24)
    const boundaryNote = source16
      ? '<p class="storage-status">В PDF указано 16 ч. Суточная смена подтверждена единственной отметкой 16 в последний день или продолжением 8 ч в следующем месяце.</p>'
      : ''
    const entries = foreignByDate.get(selectedDate) || []
    return (
      '<section class="shift-details" id="shift-details" aria-label="Информация за ' +
      esc(date(selectedDate)) +
      '"><i class="detail-handle" aria-hidden="true"></i><div class="detail-icon">' +
      icon +
      '</div><div class="detail-content"><b>' +
      date(selectedDate) +
      '</b><span class="own-shift-label">Ваша смена</span><div class="detail-lines">' +
      lines +
      '</div>' +
      boundaryNote +
      foreignEntriesHtml(entries, true) +
      '</div><button class="detail-close" id="detail-close" aria-label="Закрыть информацию о дне">×</button></section>'
    )
  }

  function monthView(month: MonthRecord) {
    const marksByDate = groupMarks(allMarks())
    const foreignByDate = foreignEntriesByDate(months, month.id, currentDelta)
    const toolbar =
      '<div class="calendar-tools"><button id="today">Сегодня</button><div class="view-switch" role="group" aria-label="Вид графика"><button id="grid-mode" aria-pressed="' +
      (calendarMode === 'grid') +
      '">Календарь</button><button id="list-mode" aria-pressed="' +
      (calendarMode === 'list') +
      '">Список</button></div></div><label class="colleagues-toggle"><input type="checkbox" id="show-colleagues"' +
      (showColleagues ? ' checked' : '') +
      '> Показывать коллег в календаре</label>'
    const navigation =
      '<nav class="months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker" aria-label="Выбрать месяц"><span class="month-title">' +
      humanMonth(month.id) +
      '</span></button><button id="next" aria-label="Следующий месяц">›</button></nav>'
    if (!candidateForMonth(month, currentDelta))
      return (
        toolbar +
        navigation +
        '<section class="analysis-empty compact"><h2>Нет графика для ' +
        esc(currentDelta) +
        '</h2><p>Загрузите PDF за этот месяц или выберите другой номер.</p><button class="primary" id="import">Импортировать PDF</button></section>'
      )
    if (calendarMode === 'list') {
      const rows = [...marksByDate]
        .filter(([day]) => day.startsWith(month.id + '-'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([day, marks]) =>
            '<button class="agenda-row" data-agenda-day="' +
            day +
            '"><b>' +
            date(day) +
            '</b><span>' +
            marks.map((mark) => esc(markDescription(mark))).join('<br>') +
            '</span></button>',
        )
        .join('')
      return (
        toolbar +
        navigation +
        '<section class="agenda" aria-label="Смены за месяц">' +
        (rows || '<p>Рабочих отметок нет.</p>') +
        '</section>' +
        calendarSyncCard(month) +
        selectedDetails(marksByDate, month, foreignByDate)
      )
    }
    return (
      toolbar +
      '<section class="calendar-group">' +
      navigation +
      '<section class="calendar" id="calendar"><div class="week">' +
      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => '<span>' + day + '</span>').join('') +
      '</div><div class="calendar-viewport" id="calendar-viewport"><div class="calendar-track" id="calendar-track">' +
      calendarPage(month, marksByDate, foreignByDate) +
      '</div></div><div class="legend-section"><button class="legend-toggle" id="legend-toggle" aria-expanded="' +
      legendExpanded +
      '" aria-controls="calendar-legend"><span>Легенда</span><small>7 обозначений</small><i aria-hidden="true">⌄</i></button><div class="legend-collapsible' +
      (legendExpanded ? ' expanded' : '') +
      '" id="calendar-legend"><div class="legend"><span><i class="dot duty"></i>24 ч · суточная смена</span><span><i class="dot boundary"></i>16 ч на границе · часть смены</span><span><i class="dot daytime"></i>8 / 12 ч · рабочая отметка</span><span><i class="dot tentative"></i>#… · возможный выход</span><span><i class="dot home"></i>V… · koduvalve дома</span><span><i class="dot vacation"></i>P · отпуск · LHPu · уход за ребёнком</span><span><i class="dot annotation"></i>прочий код PDF</span></div></div></div></section></section>' +
      calendarSyncCard(month) +
      selectedDetails(marksByDate, month, foreignByDate)
    )
  }

  return { monthView, calendarPage }
}
