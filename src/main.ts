import { registerSW } from 'virtual:pwa-register'
import { storage } from './db'
import { parsePdf } from './parser'
import { humanMonth, normalizeCrossMonth, timeLabel } from './schedule'
import type { Candidate, LeaveCode, MonthRecord, ParsedSchedule, Shift } from './types'
import './style.css'
import './interaction.css'

const app = document.querySelector<HTMLDivElement>('#app')!
let months: MonthRecord[] = []
let selected = ''
let selectedShift: Shift | null = null
let section: 'calendar' | 'documents' = 'calendar'
let calendarMotion: 'next' | 'prev' | null = null
let pending: { file: File; parsed: ParsedSchedule } | null = null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined
const localDateId = (value = new Date()) => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
const today = localDateId()
const esc = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))

const allShifts = () => normalizeCrossMonth(months.flatMap(month => month.shifts))
const nextShift = () => allShifts().find(shift => shift.date >= today)
const blankMonth = (id: string): MonthRecord => ({ id, fileName: 'График не загружен', importedAt: 0, hash: '', shifts: [], deltaNumber: '', status: 'local' })

async function refresh() {
  months = await storage.months()
  if (!selected || !months.some(month => month.id === selected)) selected = months[0]?.id || ''
  selectedShift = null
  render()
}

function render() {
  const current = months.find(month => month.id === selected) || blankMonth(selected)
  const upcoming = nextShift()
  const mainContent = section === 'documents'
    ? documentsView()
    : !months.length
      ? welcome()
      : hero(upcoming) + monthView(current)
  app.innerHTML = '<main><header><div class="brand"><span>▣</span><div><h1>' +
    (section === 'calendar' ? 'Мои смены' : 'Графики') + '</h1><small>' +
    (section === 'calendar' ? 'Только на этом устройстве' : 'Источники данных календаря') +
    '</small></div></div><button class="icon" id="settings" aria-label="Настройки">⚙</button></header>' +
    mainContent + '</main><nav class="tabs" aria-label="Разделы"><button data-section="calendar" class="' +
    (section === 'calendar' ? 'active' : '') + '">▣<span>Календарь</span></button><button data-section="documents" class="' +
    (section === 'documents' ? 'active' : '') + '">▤<span>Графики</span></button></nav><input id="file" type="file" accept="application/pdf,.pdf" hidden><dialog id="dialog"></dialog>'
  calendarMotion = null
  bind()
}

function welcome() {
  return '<section class="welcome"><div class="shield">⌂</div><h2>Ваш график остаётся вашим</h2><p>PDF обрабатывается прямо в браузере и сохраняется только на этом устройстве. Мы не отправляем файл, смены или Delta-номер на сервер.</p><button class="primary" id="import">Выбрать PDF-график</button><small>Поддерживаются месячные PDF Delta. Интернет для импорта не нужен после установки.</small></section>'
}

function hero(shift: Shift | undefined) {
  return '<section class="hero"><p>Ближайшая смена</p>' + (shift
    ? '<h2>' + date(shift.date) + '</h2><strong>' + shift.hours + ' ч</strong><span>' + timeLabel(shift) + ' · ' + esc(shift.code) + '</span>'
    : '<h2>График не загружен</h2><span>Добавьте следующий месячный PDF</span>') + '</section>'
}

function monthView(month: MonthRecord) {
  const value = new Date(month.id + '-01T12:00:00')
  const offset = (value.getDay() + 6) % 7
  const totalDays = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
  const shiftsByDay = new Map(allShifts().filter(shift => shift.date.startsWith(month.id + '-')).map(shift => [Number(shift.date.slice(8)), shift]))
  const leaveDates = new Set(month.leaveDates || [])
  const cells: string[] = Array.from({ length: offset }, () => '<i></i>')
  for (let day = 1; day <= totalDays; day++) {
    const dayText = String(day).padStart(2, '0')
    const dateKey = month.id + '-' + dayText
    const shift = shiftsByDay.get(day)
    const code = month.leaveCodes?.[dateKey] || 'P'
    const leave = leaveDates.has(dateKey)
    const attributes = shift ? 'data-shift="' + dateKey + '"' : leave ? 'data-leave="' + dateKey + '" data-leave-code="' + code + '"' : ''
    const classes = ['day', shift ? 'work' : '', shift?.hours === 24 ? 'long-shift' : shift ? 'regular-shift' : '', leave ? 'leave' : '', selectedShift?.date === dateKey ? 'selected' : '', dateKey === today ? 'today' : ''].filter(Boolean).join(' ')
    cells.push('<button class="' + classes + '" ' + attributes + '><b>' + day + '</b>' + (shift ? '<small>' + esc(shift.code) + '</small>' : leave ? '<small>' + code + '</small>' : '') + '</button>')
  }
  while (cells.length < 42) cells.push('<i></i>')
  const leaveDescription = selectedShift?.code === 'LHPu'
    ? 'Отпуск по уходу за ребёнком · код LHPu'
    : selectedShift?.code === 'P'
      ? 'Отпуск · код P'
      : selectedShift
        ? selectedShift.hours + ' ч · ' + timeLabel(selectedShift) + ' · код ' + esc(selectedShift.code) + (selectedShift.code === '16+8' ? ' · 16 ч этого дня + 8 ч следующего' : '')
        : ''
  const details = selectedShift
    ? '<section class="shift-details" id="shift-details"><div class="detail-icon">' + (selectedShift.code === 'P' || selectedShift.code === 'LHPu' ? '☼' : '◷') + '</div><div><b>' + date(selectedShift.date) + '</b><span>' + leaveDescription + '</span></div></section>'
    : ''
  const motionClass = calendarMotion === 'prev' ? 'month-prev' : calendarMotion === 'next' ? 'month-next' : ''
  return '<nav class="months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker">' + humanMonth(month.id) + '</button><button id="next" aria-label="Следующий месяц">›</button></nav><section class="calendar ' + motionClass + '" id="calendar"><div class="calendar-content"><div class="week">' +
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => '<span>' + day + '</span>').join('') +
    '</div><div class="grid">' + cells.join('') + '</div><div class="legend"><span><i class="dot long"></i>24 часа</span><span><i class="dot regular"></i>обычная смена</span><span><i class="dot vacation"></i>P / LHPu · отпуск</span></div></div></section>' +
    details + '<button class="add" id="import">＋ <span>Импортировать PDF</span></button>'
}

function documentsView() {
  const rows = months.length
    ? months.map(month => '<article data-open-pdf="' + month.id + '"><div class="doc-icon">▤</div><div><b>' + humanMonth(month.id) + '</b><span>' + esc(month.fileName) + '</span><small>' + month.shifts.length + ' смен · загружен ' + new Date(month.importedAt).toLocaleDateString('ru-RU') + '</small></div><button class="delete-month" data-delete-month="' + month.id + '" aria-label="Удалить ' + humanMonth(month.id) + '">⌫</button></article>').join('')
    : '<p>Графики ещё не импортированы.</p>'
  return '<section class="documents-intro"><p>Оригинальные PDF и графики хранятся только на этом устройстве. Нажмите график, чтобы открыть его.</p><button class="primary" id="import">Импортировать PDF</button></section><h2 class="list-title">Загруженные графики</h2><section class="documents">' + rows + '</section><p class="documents-hint">Повторный импорт заменяет только соответствующий месяц и не создаёт дублей.</p>'
}

function date(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' }).format(new Date(value + 'T12:00:00'))
}

function adjacent(direction: number) {
  const date = new Date(selected + '-01T12:00:00')
  date.setMonth(date.getMonth() + direction)
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
}

function bind() {
  document.querySelector('#import')?.addEventListener('click', () => document.querySelector<HTMLInputElement>('#file')!.click())
  document.querySelector('#file')?.addEventListener('change', onFile)
  document.querySelector('#prev')?.addEventListener('click', () => moveMonth(-1))
  document.querySelector('#next')?.addEventListener('click', () => moveMonth(1))
  document.querySelector('#picker')?.addEventListener('click', showMonths)
  document.querySelector('#settings')?.addEventListener('click', showSettings)
  document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.onclick = () => { section = button.dataset.section as 'calendar' | 'documents'; selectedShift = null; render() })
  document.querySelectorAll<HTMLButtonElement>('[data-shift]').forEach(button => button.onclick = () => selectItem(allShifts().find(shift => shift.date === button.dataset.shift) || null))
  document.querySelectorAll<HTMLButtonElement>('[data-leave]').forEach(button => button.onclick = () => selectItem({ date: button.dataset.leave!, hours: 0, code: (button.dataset.leaveCode || 'P') as LeaveCode }))
  document.querySelectorAll<HTMLElement>('[data-open-pdf]').forEach(item => item.onclick = () => { const popup = window.open('', '_blank'); if (popup) popup.opener = null; void openPdf(item.dataset.openPdf!, popup) })
  document.querySelectorAll<HTMLButtonElement>('[data-delete-month]').forEach(button => button.onclick = async event => {
    event.stopPropagation()
    const id = button.dataset.deleteMonth!
    if (confirm('Удалить ' + humanMonth(id) + ' вместе со всеми сменами и PDF?')) { await storage.remove(id); await refresh() }
  })
  enableCalendarSwipe()
}

function selectItem(shift: Shift | null) {
  selectedShift = selectedShift?.date === shift?.date ? null : shift
  render()
  if (selectedShift) setTimeout(() => document.querySelector('#shift-details')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 20)
}

function enableCalendarSwipe() {
  const calendar = document.querySelector<HTMLElement>('#calendar')
  const content = calendar?.querySelector<HTMLElement>('.calendar-content')
  if (!calendar || !content) return
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let horizontal = false
  const reset = () => {
    content.style.transition = 'transform 160ms ease-out'
    content.style.transform = ''
    calendar.classList.remove('dragging')
    setTimeout(() => { content.style.transition = '' }, 170)
  }
  calendar.addEventListener('pointerdown', event => {
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    horizontal = false
    calendar.setPointerCapture(event.pointerId)
  })
  calendar.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) horizontal = true
    if (!horizontal) return
    calendar.classList.add('dragging')
    content.style.transform = 'translateX(' + Math.max(-110, Math.min(110, dx)) + 'px)'
  })
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    if (calendar.hasPointerCapture(event.pointerId)) calendar.releasePointerCapture(event.pointerId)
    pointerId = null
    if (horizontal && Math.abs(dx) > 55) moveMonth(dx < 0 ? 1 : -1)
    else reset()
  }
  calendar.addEventListener('pointerup', finish)
  calendar.addEventListener('pointercancel', finish)
}

function moveMonth(direction: number) {
  calendarMotion = direction > 0 ? 'next' : 'prev'
  selected = adjacent(direction)
  selectedShift = null
  render()
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
  if (automatic && !parsed.warnings.length) { await savePick(automatic); return }
  const choices = parsed.candidates.map(candidate => '<button data-delta="' + candidate.number + '" class="choice ' + (candidate.number === preferred ? 'recommended' : '') + '"><b>' + candidate.number + '</b><span>' + candidate.shifts.length + ' смен' + (candidate.leaveDates.length ? ' · отпуск ' + candidate.leaveDates.length + ' дн.' : '') + (candidate.number === preferred ? ' · использовали раньше' : '') + '</span></button>').join('')
  open('<h2>Чей это график?</h2><p>' + humanMonth(parsed.month) + ' · найдены номера из PDF. ' + parsed.warnings.join(' ') + '</p><div class="choices">' + choices + '</div><button class="primary" id="cancel">Отмена</button>')
  document.querySelectorAll<HTMLButtonElement>('[data-delta]').forEach(button => button.onclick = () => savePick(parsed.candidates.find(candidate => candidate.number === button.dataset.delta)!))
  document.querySelector('#cancel')!.addEventListener('click', close)
}

async function savePick(candidate: Candidate) {
  if (!pending) return
  const old = months.find(month => month.id === pending!.parsed.month)
  const hash = await digest(pending.file)
  const record: MonthRecord = { id: pending.parsed.month, fileName: pending.file.name, importedAt: Date.now(), hash, shifts: candidate.shifts, leaveDates: candidate.leaveDates, leaveCodes: candidate.leaveCodes, deltaNumber: candidate.number, status: old && old.hash !== hash ? 'changed' : 'local', calendar: { dirty: true } }
  await storage.saveImport(record, pending.file)
  await storage.set('deltaNumber', candidate.number)
  close()
  pending = null
  selected = record.id
  selectedShift = null
  await refresh()
  if (!old) calendarOffer()
}

async function digest(file: File) {
  const value = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(value)].map(item => item.toString(16).padStart(2, '0')).join('')
}

function showMonths() {
  const choices = months.map(month => '<button class="choice" data-month="' + month.id + '"><b>' + humanMonth(month.id) + '</b><span>' + esc(month.fileName) + ' · ' + month.shifts.length + ' смен</span></button>').join('')
  open('<h2>Загруженные месяцы</h2><div class="choices">' + choices + '</div><button class="primary" id="close">Закрыть</button>')
  document.querySelectorAll<HTMLElement>('[data-month]').forEach(item => item.addEventListener('click', () => { selected = item.dataset.month!; selectedShift = null; close(); render() }))
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
    if (confirm('Удалить все PDF-метаданные, смены и настройки с этого устройства?')) { await storage.clear(); close(); await refresh() }
  })
}

function open(html: string) {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!
  dialog.innerHTML = html
  if (!dialog.open) dialog.showModal()
}
function close() { document.querySelector<HTMLDialogElement>('#dialog')?.close() }

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
refresh()
