import { registerSW } from 'virtual:pwa-register'
import { storage } from './db'
import { parsePdf } from './parser'
import { humanMonth, normalizeCrossMonth, timeLabel } from './schedule'
import type { Candidate, DayMark, LeaveCode, MonthRecord, ParsedSchedule, Shift } from './types'
import './style.css'
import './interaction.css'

type WorkMark = { date: string; kind: 'hours' | 'home'; raw: string; hours: number }
type UpcomingDay = { date: string; marks: WorkMark[] }
type PreparedMonthTransition = {
  calendar: HTMLElement
  track: HTMLElement
  current: MonthRecord
  target: MonthRecord
  direction: -1 | 1
  start: number
  end: number
}

const app = document.querySelector<HTMLDivElement>('#app')!
let months: MonthRecord[] = []
let selected = ''
let selectedDate: string | null = null
let section: 'calendar' | 'documents' = 'calendar'
let pending: { file: File; parsed: ParsedSchedule } | null = null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined
let monthTransitioning = false
let calendarGestureActive = false
let ignoreDayClicksUntil = 0
let legacyNeedsReimport: string[] = []

const localDateId = (value = new Date()) => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
const todayId = () => localDateId()
const esc = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
const isWorkMark = (mark: DayMark): mark is WorkMark => mark.kind === 'hours' || mark.kind === 'home'
const displayCode = (mark: Pick<WorkMark, 'raw'> | DayMark) => mark.raw === '16+8' ? '24' : mark.raw
const hoursText = (hours: number) => `${String(hours).replace('.', ',')} ч`

function blankMonth(id: string): MonthRecord {
  return { id, fileName: 'График не загружен', importedAt: 0, hash: '', shifts: [], deltaNumber: '', status: 'local' }
}

function marksForRecord(month: MonthRecord): DayMark[] {
  if (month.marks) return month.marks
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
  return [...work, ...leave]
}

function allMarks(): DayMark[] {
  const raw = months.flatMap(marksForRecord)
  const normalizedWork = normalizeCrossMonth(raw.filter(isWorkMark).map(mark => ({ date: mark.date, hours: mark.hours, code: mark.raw })))
    .map<WorkMark>(shift => ({ date: shift.date, kind: /^V\d/i.test(shift.code) ? 'home' : 'hours', raw: shift.code, hours: shift.hours }))
  return [...normalizedWork, ...raw.filter(mark => !isWorkMark(mark))]
}

function groupMarks(marks: DayMark[]) {
  const grouped = new Map<string, DayMark[]>()
  for (const mark of marks) grouped.set(mark.date, [...(grouped.get(mark.date) || []), mark])
  const rank: Record<DayMark['kind'], number> = { hours: 0, home: 1, leave: 2, other: 3 }
  for (const values of grouped.values()) values.sort((a, b) => rank[a.kind] - rank[b.kind])
  return grouped
}

function upcomingDay(): UpcomingDay | undefined {
  const work = allMarks().filter(isWorkMark).filter(mark => mark.date >= todayId()).sort((a, b) => a.date.localeCompare(b.date))
  const date = work[0]?.date
  return date ? { date, marks: work.filter(mark => mark.date === date) } : undefined
}

async function refresh() {
  months = await storage.months()
  let upgraded = false
  legacyNeedsReimport = []
  for (const month of months.filter(month => !month.marks)) {
    const pdf = await storage.pdf(month.id)
    if (!pdf) {
      legacyNeedsReimport.push(month.id)
      continue
    }
    try {
      const parsed = await parsePdf(pdf as File)
      const candidate = parsed.candidates.find(item => item.number === month.deltaNumber)
      if (!candidate) continue
      await storage.put({ ...month, marks: candidate.marks, shifts: candidate.shifts, leaveDates: candidate.leaveDates, leaveCodes: candidate.leaveCodes })
      upgraded = true
    } catch {
      // Keep the already saved legacy interpretation if its original PDF is
      // unavailable or malformed; no local data is removed during upgrade.
      legacyNeedsReimport.push(month.id)
    }
  }
  if (upgraded) months = await storage.months()
  if (!selected || !months.some(month => month.id === selected)) selected = months[0]?.id || ''
  selectedDate = null
  render()
}

function render() {
  const current = months.find(month => month.id === selected) || blankMonth(selected)
  const mainContent = section === 'documents'
    ? documentsView()
    : !months.length
      ? welcome()
      : hero(upcomingDay()) + legacyNotice() + monthView(current)
  app.innerHTML = '<main><header><div class="brand"><span>▣</span><div><h1>' +
    (section === 'calendar' ? 'Мои смены' : 'Графики') + '</h1><small>' +
    (section === 'calendar' ? 'Только на этом устройстве' : 'Источники данных календаря') +
    '</small></div></div><button class="icon" id="settings" aria-label="Настройки">⚙</button></header>' +
    mainContent + '</main><nav class="tabs" aria-label="Разделы"><button data-section="calendar" class="' +
    (section === 'calendar' ? 'active' : '') + '">▣<span>Календарь</span></button><button data-section="documents" class="' +
    (section === 'documents' ? 'active' : '') + '">▤<span>Графики</span></button></nav><input id="file" type="file" accept="application/pdf,.pdf" hidden><dialog id="dialog"></dialog>'
  bind()
}

function welcome() {
  return '<section class="welcome"><div class="shield">⌂</div><h2>Ваш график остаётся вашим</h2><p>PDF обрабатывается прямо в браузере и сохраняется только на этом устройстве. Мы не отправляем файл, смены или Delta-номер на сервер.</p><button class="primary" id="import">Выбрать PDF-график</button><small>Поддерживаются месячные PDF Delta. Интернет для импорта не нужен после установки.</small></section>'
}

function hero(upcoming: UpcomingDay | undefined) {
  if (!upcoming) return '<section class="hero"><p>Ближайшая смена</p><h2>График не загружен</h2><span>Добавьте следующий месячный PDF</span></section>'
  const codes = upcoming.marks.map(displayCode).join(' + ')
  const label = upcoming.marks.length === 1 && upcoming.marks[0].kind === 'hours' && upcoming.marks[0].hours === 24
    ? '24 ч'
    : codes
  const description = upcoming.marks.map(mark => markDescription(mark, true)).join(' · ')
  return '<section class="hero"><p>Ближайшая смена</p><h2>' + date(upcoming.date) + '</h2><strong>' + esc(label) + '</strong><span>' + esc(description) + '</span></section>'
}

function legacyNotice() {
  if (!legacyNeedsReimport.length) return ''
  const names = legacyNeedsReimport.map(humanMonth).join(', ')
  return '<aside class="legacy-notice"><b>Нужен повторный импорт PDF</b><span>Для ' + esc(names) + ' старая версия не сохранила оригинал. Загрузите PDF ещё раз, чтобы распознать LHPu, V-коды и другие отметки.</span></aside>'
}

function markDescription(mark: DayMark, compact = false) {
  if (mark.kind === 'leave') return mark.raw === 'LHPu' ? 'Отпуск по уходу за ребёнком' : 'Отпуск'
  if (mark.kind === 'other') return compact ? `Код ${mark.raw}` : `Прочая отметка из PDF · код ${mark.raw}`
  if (mark.kind === 'home') return compact
    ? `${mark.raw} · дома`
    : `Домашнее дежурство (koduvalve) · ${hoursText(mark.hours)} · код ${mark.raw}`
  if (mark.hours === 24) return compact
    ? 'Суточная смена · 24 ч'
    : `Суточная смена · ${timeLabel({ date: mark.date, hours: mark.hours, code: mark.raw })} · код 24`
  if (mark.hours === 12) return compact
    ? '12 ч на месте'
    : 'Дневной график · 12 ч на месте 08:00–20:00 · код 12'
  return compact ? `${hoursText(mark.hours)} · код ${mark.raw}` : `${hoursText(mark.hours)} · код графика ${mark.raw}`
}

function dayTone(marks: DayMark[]) {
  const has24 = marks.some(mark => mark.kind === 'hours' && mark.hours === 24)
  const hasDay = marks.some(mark => mark.kind === 'hours' && mark.hours !== 24)
  const hasHome = marks.some(mark => mark.kind === 'home')
  const hasOther = marks.some(mark => mark.kind === 'other')
  const leave = marks.find((mark): mark is Extract<DayMark, { kind: 'leave' }> => mark.kind === 'leave')
  if (has24 && hasHome) return 'mixed-duty-home'
  if (hasDay && hasHome) return 'mixed-day-home'
  if (has24) return 'duty-24'
  if (hasDay) return 'day-schedule'
  if (hasHome && hasOther) return 'mixed-home-other'
  if (hasHome) return 'home-duty'
  if (leave?.raw === 'LHPu') return 'leave-childcare'
  if (leave) return 'leave-vacation'
  return hasOther ? 'other-code' : ''
}

function dayAria(dateKey: string, marks: DayMark[]) {
  return `${date(dateKey)}: ${marks.map(mark => markDescription(mark)).join('; ')}`
}

function calendarPage(month: MonthRecord, marksByDate: Map<string, DayMark[]>) {
  const currentDay = todayId()
  const value = new Date(month.id + '-01T12:00:00')
  const offset = (value.getDay() + 6) % 7
  const totalDays = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
  const cells: string[] = Array.from({ length: offset }, () => '<i class="day-blank" aria-hidden="true"></i>')
  for (let day = 1; day <= totalDays; day++) {
    const dateKey = month.id + '-' + String(day).padStart(2, '0')
    const marks = marksByDate.get(dateKey) || []
    if (!marks.length) {
      cells.push('<span class="day day-empty ' + (dateKey === currentDay ? 'today' : '') + '"><b>' + day + '</b></span>')
      continue
    }
    const regularCodes = marks.filter(mark => mark.kind !== 'home').map(displayCode)
    const homeCodes = marks.filter((mark): mark is WorkMark => mark.kind === 'home').map(displayCode)
    const code = marks.map(displayCode).join('+')
    const codeHtml = regularCodes.length && homeCodes.length
      ? '<small>' + esc(regularCodes.join('+')) + '</small><em class="home-badge">' + esc(homeCodes.join('+')) + '</em>'
      : '<small>' + esc(code) + '</small>'
    const classes = ['day', dayTone(marks), selectedDate === dateKey ? 'selected' : '', dateKey === currentDay ? 'today' : ''].filter(Boolean).join(' ')
    cells.push('<button class="' + classes + '" data-day="' + dateKey + '" aria-label="' + esc(dayAria(dateKey, marks)) + '"><b>' + day + '</b>' + codeHtml + '</button>')
  }
  while (cells.length < 42) cells.push('<i class="day-blank" aria-hidden="true"></i>')
  return '<div class="calendar-page" data-month="' + month.id + '"><div class="grid">' + cells.join('') + '</div></div>'
}

function selectedDetails(marksByDate: Map<string, DayMark[]>) {
  if (!selectedDate) return ''
  const marks = marksByDate.get(selectedDate) || []
  if (!marks.length) return ''
  const hasHome = marks.some(mark => mark.kind === 'home')
  const onlyHome = hasHome && marks.every(mark => mark.kind === 'home' || mark.kind === 'other')
  const onlyLeave = marks.every(mark => mark.kind === 'leave')
  const onlyOther = marks.every(mark => mark.kind === 'other')
  const icon = onlyLeave ? '☼' : onlyHome ? '⌂' : onlyOther ? '⋯' : '◷'
  const lines = marks.map(mark => '<div class="detail-line ' + mark.kind + '"><i></i><div><b>' + esc(displayCode(mark)) + '</b><span>' + esc(markDescription(mark)) + '</span></div></div>').join('')
  return '<section class="shift-details" id="shift-details"><div class="detail-icon">' + icon + '</div><div class="detail-content"><b>' + date(selectedDate) + '</b><div class="detail-lines">' + lines + '</div></div></section>'
}

function monthView(month: MonthRecord) {
  const marksByDate = groupMarks(allMarks())
  return '<nav class="months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker" aria-label="Выбрать месяц"><span class="month-title">' + humanMonth(month.id) + '</span></button><button id="next" aria-label="Следующий месяц">›</button></nav><section class="calendar" id="calendar"><div class="week">' +
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => '<span>' + day + '</span>').join('') +
    '</div><div class="calendar-viewport" id="calendar-viewport"><div class="calendar-track" id="calendar-track">' + calendarPage(month, marksByDate) +
    '</div></div><div class="legend"><span><i class="dot duty"></i>24 ч · суточная смена</span><span><i class="dot daytime"></i>8 / 12 / 16 ч · дневной график</span><span><i class="dot home"></i>V… · koduvalve дома</span><span><i class="dot vacation"></i>P · отпуск · LHPu · уход за ребёнком</span><span><i class="dot annotation"></i>прочий код PDF</span></div></section>' +
    selectedDetails(marksByDate) + '<button class="add" id="import">＋ <span>Импортировать PDF</span></button>'
}

function documentsView() {
  const rows = months.length
    ? months.map(month => '<article data-open-pdf="' + month.id + '" role="button" tabindex="0" aria-label="Открыть PDF ' + esc(month.fileName) + '"><div class="doc-icon">▤</div><div><b>' + humanMonth(month.id) + '</b><span>' + esc(month.fileName) + '</span><small>' + month.shifts.length + ' рабочих отметок · загружен ' + new Date(month.importedAt).toLocaleDateString('ru-RU') + '</small></div><button class="delete-month" data-delete-month="' + month.id + '" aria-label="Удалить ' + humanMonth(month.id) + '">⌫</button></article>').join('')
    : '<p>Графики ещё не импортированы.</p>'
  return '<section class="documents-intro"><p>Оригинальные PDF и графики хранятся только на этом устройстве. Нажмите график, чтобы открыть его.</p><button class="primary" id="import">Импортировать PDF</button></section><h2 class="list-title">Загруженные графики</h2><section class="documents">' + rows + '</section><p class="documents-hint">Повторный импорт заменяет только соответствующий месяц и не создаёт дублей.</p>'
}

function date(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' }).format(new Date(value + 'T12:00:00'))
}

function adjacent(direction: number) {
  const value = new Date(selected + '-01T12:00:00')
  value.setMonth(value.getMonth() + direction)
  return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0')
}

function bind() {
  document.querySelector('#import')?.addEventListener('click', () => document.querySelector<HTMLInputElement>('#file')!.click())
  document.querySelector('#file')?.addEventListener('change', onFile)
  document.querySelector('#prev')?.addEventListener('click', () => moveMonth(-1))
  document.querySelector('#next')?.addEventListener('click', () => moveMonth(1))
  document.querySelector('#picker')?.addEventListener('click', showMonths)
  document.querySelector('#settings')?.addEventListener('click', showSettings)
  document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.onclick = () => { section = button.dataset.section as 'calendar' | 'documents'; selectedDate = null; render() })
  document.querySelectorAll<HTMLElement>('[data-open-pdf]').forEach(item => {
    const open = () => {
    const popup = window.open('', '_blank')
    if (popup) popup.opener = null
    void openPdf(item.dataset.openPdf!, popup)
    }
    item.onclick = open
    item.onkeydown = event => {
      if ((event.key === 'Enter' || event.key === ' ') && !(event.target instanceof Element && event.target.closest('[data-delete-month]'))) {
        event.preventDefault()
        open()
      }
    }
  })
  document.querySelectorAll<HTMLButtonElement>('[data-delete-month]').forEach(button => button.onclick = async event => {
    event.stopPropagation()
    const id = button.dataset.deleteMonth!
    if (confirm('Удалить ' + humanMonth(id) + ' вместе со всеми сменами и PDF?')) {
      await storage.remove(id)
      await refresh()
    }
  })
  const calendar = document.querySelector<HTMLElement>('#calendar')
  calendar?.addEventListener('click', event => {
    if (Date.now() < ignoreDayClicksUntil || !(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-day]')
    if (button) selectDay(button.dataset.day!)
  })
  enableCalendarSwipe()
}

function selectDay(value: string) {
  selectedDate = selectedDate === value ? null : value
  render()
  if (selectedDate) setTimeout(() => document.querySelector('#shift-details')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 20)
}

function prepareMonthTransition(direction: -1 | 1): PreparedMonthTransition | null {
  const calendar = document.querySelector<HTMLElement>('#calendar')
  const track = document.querySelector<HTMLElement>('#calendar-track')
  if (!calendar || !track || !selected) return null
  const current = months.find(month => month.id === selected) || blankMonth(selected)
  const target = months.find(month => month.id === adjacent(direction)) || blankMonth(adjacent(direction))
  const marksByDate = groupMarks(allMarks())
  const start = direction > 0 ? 0 : -50
  const end = direction > 0 ? -50 : 0
  track.classList.remove('animating')
  track.innerHTML = direction > 0
    ? calendarPage(current, marksByDate) + calendarPage(target, marksByDate)
    : calendarPage(target, marksByDate) + calendarPage(current, marksByDate)
  track.style.transform = `translateX(${start}%)`
  return { calendar, track, current, target, direction, start, end }
}

function animateMonthTitle(target: MonthRecord, direction: -1 | 1) {
  const picker = document.querySelector<HTMLButtonElement>('#picker')
  if (!picker) return
  picker.disabled = true
  picker.className = 'month-title-transition ' + (direction > 0 ? 'to-next' : 'to-prev')
  picker.innerHTML = '<span class="month-title-old">' + humanMonth(selected) + '</span><span class="month-title-new">' + humanMonth(target.id) + '</span>'
  requestAnimationFrame(() => picker.classList.add('running'))
}

function setMonthNavigationDisabled(value: boolean) {
  document.querySelectorAll<HTMLButtonElement>('#prev,#next,#picker').forEach(button => { button.disabled = value })
}

function commitMonthTransition(prepared: PreparedMonthTransition) {
  if (monthTransitioning) return
  monthTransitioning = true
  calendarGestureActive = false
  selectedDate = null
  ignoreDayClicksUntil = Date.now() + 500
  document.querySelector('#shift-details')?.remove()
  prepared.calendar.classList.remove('dragging')
  prepared.calendar.classList.add('is-transitioning')
  setMonthNavigationDisabled(true)
  animateMonthTitle(prepared.target, prepared.direction)
  // Flush the starting transform before enabling the transition. This makes
  // arrow navigation animate just as reliably as an already-dragged track.
  void prepared.track.offsetWidth
  let complete = false
  const finish = () => {
    if (complete) return
    complete = true
    selected = prepared.target.id
    monthTransitioning = false
    render()
  }
  prepared.track.addEventListener('transitionend', event => {
    if (event.target === prepared.track && event.propertyName === 'transform') finish()
  }, { once: true })
  requestAnimationFrame(() => {
    prepared.track.classList.add('animating')
    prepared.track.style.transform = `translateX(${prepared.end}%)`
  })
  window.setTimeout(finish, 650)
}

function cancelMonthTransition(prepared: PreparedMonthTransition) {
  monthTransitioning = true
  calendarGestureActive = false
  prepared.calendar.classList.remove('dragging')
  setMonthNavigationDisabled(true)
  let complete = false
  const finish = () => {
    if (complete) return
    complete = true
    prepared.track.classList.remove('animating')
    prepared.track.style.transform = ''
    prepared.track.innerHTML = calendarPage(prepared.current, groupMarks(allMarks()))
    monthTransitioning = false
    setMonthNavigationDisabled(false)
  }
  prepared.track.addEventListener('transitionend', event => {
    if (event.target === prepared.track && event.propertyName === 'transform') finish()
  }, { once: true })
  requestAnimationFrame(() => {
    prepared.track.classList.add('animating')
    prepared.track.style.transform = `translateX(${prepared.start}%)`
  })
  window.setTimeout(finish, 650)
}

function moveMonth(direction: -1 | 1) {
  if (monthTransitioning || calendarGestureActive) return
  const prepared = prepareMonthTransition(direction)
  if (prepared) commitMonthTransition(prepared)
  else {
    selected = adjacent(direction)
    selectedDate = null
    render()
  }
}

function enableCalendarSwipe() {
  const calendar = document.querySelector<HTMLElement>('#calendar')
  const viewport = document.querySelector<HTMLElement>('#calendar-viewport')
  if (!calendar || !viewport) return
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let startAt = 0
  let lastX = 0
  let horizontal = false
  let prepared: PreparedMonthTransition | null = null

  const release = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return false
    if (calendar.hasPointerCapture(event.pointerId)) calendar.releasePointerCapture(event.pointerId)
    pointerId = null
    return true
  }
  calendar.addEventListener('pointerdown', event => {
    if (monthTransitioning) return
    pointerId = event.pointerId
    startX = lastX = event.clientX
    startY = event.clientY
    startAt = event.timeStamp
    horizontal = false
    prepared = null
    calendar.setPointerCapture(event.pointerId)
  })
  calendar.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId || monthTransitioning) return
    lastX = event.clientX
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      horizontal = true
      const direction = dx < 0 ? 1 : -1
      prepared = prepareMonthTransition(direction)
      if (prepared) {
        calendarGestureActive = true
        calendar.classList.add('dragging')
      }
    }
    if (!horizontal || !prepared) return
    event.preventDefault()
    const width = Math.max(1, viewport.clientWidth)
    const distance = Math.max(0, prepared.direction > 0 ? -dx : dx)
    const progress = Math.min(1, distance / width)
    const offset = prepared.direction > 0 ? -50 * progress : -50 + 50 * progress
    prepared.track.style.transform = `translateX(${offset}%)`
  })
  const finish = (event: PointerEvent) => {
    if (!release(event)) return
    if (!prepared) return
    const dx = (event.type === 'pointercancel' ? lastX : event.clientX) - startX
    const width = Math.max(1, viewport.clientWidth)
    const distance = Math.max(0, prepared.direction > 0 ? -dx : dx)
    const velocity = distance / Math.max(1, event.timeStamp - startAt)
    ignoreDayClicksUntil = Date.now() + 350
    if (event.type !== 'pointercancel' && (distance >= width * 0.24 || (distance > 20 && velocity > .55))) commitMonthTransition(prepared)
    else cancelMonthTransition(prepared)
    prepared = null
  }
  calendar.addEventListener('pointerup', finish)
  calendar.addEventListener('pointercancel', finish)
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    open('<div class="busy"><div class="spinner"></div><h2>Анализируем PDF</h2><p>Файл не покидает ваше устройство.</p></div>')
    const parsed = await parsePdf(file)
    pending = { file, parsed }
    await chooseDelta(parsed)
  } catch (error) {
    open('<h2>Не удалось прочитать график</h2><p>' + esc(error instanceof Error ? error.message : 'Неизвестная ошибка') + '</p><button class="primary" autofocus>Закрыть</button>')
    document.querySelector<HTMLButtonElement>('dialog button')!.onclick = close
  } finally {
    ;(event.target as HTMLInputElement).value = ''
  }
}

async function chooseDelta(parsed: ParsedSchedule) {
  const preferred = await storage.setting<string>('deltaNumber')
  const automatic = preferred && parsed.candidates.find(candidate => candidate.number === preferred)
  if (automatic && !parsed.warnings.length) {
    await savePick(automatic)
    return
  }
  const choices = parsed.candidates.map(candidate => {
    const workCount = candidate.marks.filter(isWorkMark).length
    return '<button data-delta="' + candidate.number + '" class="choice ' + (candidate.number === preferred ? 'recommended' : '') + '"><b>' + candidate.number + '</b><span>' + workCount + ' рабочих отметок' + (candidate.leaveDates.length ? ' · отпуск ' + candidate.leaveDates.length + ' дн.' : '') + (candidate.number === preferred ? ' · использовали раньше' : '') + '</span></button>'
  }).join('')
  open('<h2>Чей это график?</h2><p>' + humanMonth(parsed.month) + ' · найдены номера из PDF. ' + parsed.warnings.join(' ') + '</p><div class="choices">' + choices + '</div><button class="primary" id="cancel">Отмена</button>')
  document.querySelectorAll<HTMLButtonElement>('[data-delta]').forEach(button => button.onclick = () => savePick(parsed.candidates.find(candidate => candidate.number === button.dataset.delta)!))
  document.querySelector('#cancel')!.addEventListener('click', close)
}

async function savePick(candidate: Candidate) {
  if (!pending) return
  const old = months.find(month => month.id === pending!.parsed.month)
  const hash = await digest(pending.file)
  const record: MonthRecord = {
    id: pending.parsed.month,
    fileName: pending.file.name,
    importedAt: Date.now(),
    hash,
    marks: candidate.marks,
    shifts: candidate.shifts,
    leaveDates: candidate.leaveDates,
    leaveCodes: candidate.leaveCodes,
    deltaNumber: candidate.number,
    status: old && old.hash !== hash ? 'changed' : 'local',
    calendar: { dirty: true },
  }
  await storage.saveImport(record, pending.file)
  await storage.set('deltaNumber', candidate.number)
  close()
  pending = null
  selected = record.id
  selectedDate = null
  await refresh()
  if (!old) calendarOffer()
}

async function digest(file: File) {
  const value = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(value)].map(item => item.toString(16).padStart(2, '0')).join('')
}

function showMonths() {
  const choices = months.map(month => '<button class="choice" data-month="' + month.id + '"><b>' + humanMonth(month.id) + '</b><span>' + esc(month.fileName) + ' · ' + month.shifts.length + ' рабочих отметок</span></button>').join('')
  open('<h2>Загруженные месяцы</h2><div class="choices">' + choices + '</div><button class="primary" id="close">Закрыть</button>')
  document.querySelectorAll<HTMLElement>('[data-month]').forEach(item => item.addEventListener('click', () => {
    selected = item.dataset.month!
    selectedDate = null
    close()
    render()
  }))
  document.querySelector('#close')!.addEventListener('click', close)
}

function calendarOffer() {
  setTimeout(() => {
    open('<h2>Синхронизировать с Google Calendar?</h2><p>В будущем вы сможете по явному действию создать отдельный календарь смен. Сейчас интеграция ожидает настройки безопасного OAuth Client ID — приложение полностью работает и без неё.</p><button class="primary" id="ok">Понятно</button>')
    document.querySelector('#ok')?.addEventListener('click', close)
  }, 60)
}

function showSettings() {
  open('<h2>Настройки</h2><p>Данные хранятся в IndexedDB браузера. Удаление нельзя отменить.</p><button class="calendar-button" id="google">Google Calendar <span>Скоро</span></button><button class="danger" id="wipe">Удалить все локальные данные</button><button class="primary" id="close">Закрыть</button>')
  document.querySelector('#close')!.addEventListener('click', close)
  document.querySelector('#google')!.addEventListener('click', () => {
    open('<h2>Google Calendar</h2><p>Синхронизация будет создавать отдельный календарь смен и запрашивать доступ только по вашему действию. Для включения нужен production OAuth Client ID; сейчас ни аккаунт, ни данные не передаются.</p><button class="primary" id="close">Понятно</button>')
    document.querySelector('#close')!.addEventListener('click', close)
  })
  document.querySelector('#wipe')!.addEventListener('click', async () => {
    if (confirm('Удалить все PDF-метаданные, смены и настройки с этого устройства?')) {
      await storage.clear()
      close()
      await refresh()
    }
  })
}

function open(html: string) {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!
  dialog.innerHTML = html
  if (!dialog.open) dialog.showModal()
}

function close() {
  document.querySelector<HTMLDialogElement>('#dialog')?.close()
}

async function openPdf(id: string, popup: Window | null = null) {
  const pdf = await storage.pdf(id)
  if (!pdf) {
    open('<h2>Оригинал недоступен</h2><p>Этот месяц был импортирован до обновления приложения, когда PDF ещё не сохранялся. Импортируйте исходный файл повторно.</p><button class="primary" id="close">Понятно</button>')
    document.querySelector('#close')!.addEventListener('click', close)
    return
  }
  const url = URL.createObjectURL(pdf)
  if (popup) popup.location.href = url
  else window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

function offerUpdate() {
  if (document.querySelector('#update-notice')) return
  const notice = document.createElement('aside')
  notice.id = 'update-notice'
  notice.setAttribute('role', 'status')
  notice.innerHTML = '<div><b>Доступна новая версия</b><span>Ваши сохранённые графики останутся на устройстве.</span></div><button class="primary">Перезапустить</button>'
  notice.querySelector('button')!.addEventListener('click', async () => {
    const button = notice.querySelector('button') as HTMLButtonElement
    button.disabled = true
    button.textContent = 'Обновляем…'
    await applyUpdate?.(true)
  })
  document.body.append(notice)
}

applyUpdate = registerSW({ onNeedRefresh: offerUpdate })
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !monthTransitioning && !document.querySelector<HTMLDialogElement>('#dialog')?.open) render()
})
refresh()
