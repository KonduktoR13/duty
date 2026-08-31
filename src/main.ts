import { registerSW } from 'virtual:pwa-register'
import { storage } from './db'
import { parsePdf } from './parser'
import { allMarksForDelta, candidateForMonth, candidatesForMonth, foreignEntriesByDate, isWorkMark, knownDeltaNumbers, migrateMark, type ForeignDayEntry, type WorkMark } from './roster'
import { applyCalendarSync, auditCalendarSync, buildCalendarDrafts, calendarSyncId, planCalendarSync, syncForAccount, syncSummary, type RemoteAudit } from './calendar-sync'
import { clearGoogleAccessToken, deterministicGoogleEventId, discoverDutyAccounts, getGoogleAccountEmail, GoogleApiError, GoogleAuthError, googleCalendarGateway, hasLiveGoogleToken, prepareGoogleIdentityServices, requestGoogleToken, revokeGoogleAccess, setGoogleLoginHint } from './google-calendar'
import { createGoogleAccountProfileId, googleEmailKey, resolveGoogleEmailProfile } from './google-account'
import { humanMonth, timeLabel } from './schedule'
import { analyzeMonth, type AnalysisCheck } from './month-analysis'
import type { CalendarMonthSync, Candidate, DayMark, GoogleIntegrationSettings, MonthRecord, ParsedSchedule } from './types'
import './style.css'
import './interaction.css'

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
let currentDelta = ''
let selectedDate: string | null = null
type AppSection = 'calendar' | 'analysis' | 'documents'
let section: AppSection = 'calendar'
let pending: { file: File; parsed: ParsedSchedule } | null = null
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined
let monthTransitioning = false
let calendarGestureActive = false
let ignoreDayClicksUntil = 0
let legacyNeedsReimport: string[] = []
let calendarSyncs: CalendarMonthSync[] = []
let googleSettings: GoogleIntegrationSettings = { enabled: false }
let highlightSyncOffer = false
let legendExpanded = false
let lastRenderedSection: AppSection = section

const localDateId = (value = new Date()) => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
const todayId = () => localDateId()
const esc = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
const displayCode = (mark: Pick<WorkMark, 'raw'> | DayMark) => mark.raw === '16+8' ? '24' : mark.raw
const hoursText = (hours: number) => `${String(hours).replace('.', ',')} ч`

function blankMonth(id: string): MonthRecord {
  return { id, fileName: 'График не загружен', importedAt: 0, hash: '', shifts: [], deltaNumber: '', status: 'local' }
}

function allMarks(): DayMark[] {
  return allMarksForDelta(months, currentDelta)
}

function groupMarks(marks: DayMark[]) {
  const grouped = new Map<string, DayMark[]>()
  for (const mark of marks) grouped.set(mark.date, [...(grouped.get(mark.date) || []), mark])
  const rank: Record<DayMark['kind'], number> = { hours: 0, tentative: 1, home: 2, leave: 3, other: 4 }
  for (const values of grouped.values()) values.sort((a, b) => rank[a.kind] - rank[b.kind])
  return grouped
}

function upcomingDay(): UpcomingDay | undefined {
  const work = allMarks().filter(isWorkMark).filter(mark => mark.date >= todayId()).sort((a, b) => a.date.localeCompare(b.date))
  const date = work[0]?.date
  return date ? { date, marks: work.filter(mark => mark.date === date) } : undefined
}

async function refresh() {
  ;[months, calendarSyncs, googleSettings] = await Promise.all([
    storage.months(),
    storage.syncs(),
    storage.setting<GoogleIntegrationSettings>('googleIntegration').then(value => value || { enabled: false }),
  ])
  if (!googleSettings.accountProfileId && (googleSettings.enabled || calendarSyncs.length)) {
    const accountProfileId = createGoogleAccountProfileId()
    googleSettings = {
      ...googleSettings,
      accountProfileId,
      lastSyncByAccount: googleSettings.lastSyncAt ? { [accountProfileId]: googleSettings.lastSyncAt } : googleSettings.lastSyncByAccount,
    }
    await storage.set('googleIntegration', googleSettings)
    const migrated: CalendarMonthSync[] = []
    for (const sync of calendarSyncs) {
      if (sync.accountProfileId) { migrated.push(sync); continue }
      const next = { ...sync, id: calendarSyncId(sync.month, sync.deltaNumber, accountProfileId), accountProfileId }
      await storage.putSync(next)
      if (next.id !== sync.id) await storage.removeSync(sync.id)
      migrated.push(next)
    }
    calendarSyncs = migrated
  }
  setGoogleLoginHint(googleSettings.enabled ? googleSettings.accountEmail : undefined)
  currentDelta = await storage.setting<string>('deltaNumber') || currentDelta
  let upgraded = false
  legacyNeedsReimport = []
  for (const month of months) {
    if (month.candidates?.length) {
      const candidates = month.candidates.map(candidate => ({ ...candidate, marks: candidate.marks.map(migrateMark) }))
      const changed = month.candidates.some((candidate, candidateIndex) => candidate.marks.some((mark, markIndex) => mark !== candidates[candidateIndex].marks[markIndex]))
      if (changed) {
        await storage.put({ ...month, candidates })
        upgraded = true
      }
      continue
    }
    const pdf = await storage.pdf(month.id)
    if (pdf) {
      try {
        const parsed = await parsePdf(pdf as File)
        const candidate = parsed.candidates.find(item => item.number === currentDelta) || parsed.candidates.find(item => item.number === month.deltaNumber) || parsed.candidates[0]
        await storage.put({ ...month, candidates: parsed.candidates, marks: candidate.marks, shifts: candidate.shifts, leaveDates: candidate.leaveDates, leaveCodes: candidate.leaveCodes })
        upgraded = true
        continue
      } catch {
        legacyNeedsReimport.push(month.id)
      }
    }
    const fallback = candidatesForMonth(month)
    if (fallback.length) {
      await storage.put({ ...month, candidates: fallback })
      upgraded = true
    } else if (!pdf) {
      legacyNeedsReimport.push(month.id)
    }
  }
  if (upgraded) months = await storage.months()
  if (!currentDelta) {
    currentDelta = knownDeltaNumbers(months)[0] || ''
    if (currentDelta) await storage.set('deltaNumber', currentDelta)
  }
  if (!selected || !months.some(month => month.id === selected)) selected = months[0]?.id || ''
  selectedDate = null
  render()
}

function render() {
  const previousScroll = document.querySelector<HTMLElement>('.app-content')?.scrollTop || 0
  const restoreScroll = lastRenderedSection === section ? previousScroll : 0
  lastRenderedSection = section
  const current = months.find(month => month.id === selected) || blankMonth(selected)
  const mainContent = section === 'documents'
    ? documentsView()
    : section === 'analysis'
      ? analysisView(current)
      : !months.length
        ? welcome()
        : hero(upcomingDay()) + legacyNotice() + monthView(current)
  const sectionCopy: Record<AppSection, { title: string; subtitle: string }> = {
    calendar: { title: 'Мои смены', subtitle: 'Только на этом устройстве' },
    analysis: { title: 'Анализ месяца', subtitle: 'Часы, нагрузка и отдых' },
    documents: { title: 'Графики', subtitle: 'Источники данных календаря' },
  }
  const copy = sectionCopy[section]
  app.innerHTML = '<div class="app-shell"><header><div class="header-inner"><div class="brand"><span>▣</span><div><h1>' +
    copy.title + '</h1><small>' + copy.subtitle +
    '</small></div></div><button class="icon" id="settings" aria-label="Настройки">⚙</button></div></header><main class="app-content">' +
    mainContent + '</main><nav class="tabs" aria-label="Разделы"><button data-section="calendar" class="' +
    (section === 'calendar' ? 'active' : '') + '">▣<span>Календарь</span></button><button data-section="analysis" class="' +
    (section === 'analysis' ? 'active' : '') + '">◔<span>Анализ</span></button><button data-section="documents" class="' +
    (section === 'documents' ? 'active' : '') + '">▤<span>Графики</span></button></nav></div><input id="file" type="file" accept="application/pdf,.pdf" hidden><dialog id="dialog"></dialog>'
  bind()
  requestAnimationFrame(() => {
    const content = document.querySelector<HTMLElement>('.app-content')
    if (content) content.scrollTop = restoreScroll
  })
}

function welcome() {
  return '<section class="welcome"><div class="shield">⌂</div><h2>Ваш график остаётся вашим</h2><p>PDF обрабатывается прямо в браузере и сохраняется только на этом устройстве. Мы не отправляем файл, смены или Delta-номер на сервер.</p><button class="primary" id="import">Выбрать PDF-график</button><small>Поддерживаются месячные PDF Delta. Интернет для импорта не нужен после установки.</small><nav class="legal-links" aria-label="Правовая информация"><a href="privacy/" target="_blank" rel="noopener">Политика конфиденциальности</a><a href="terms/" target="_blank" rel="noopener">Условия использования</a></nav></section>'
}

function hero(upcoming: UpcomingDay | undefined) {
  if (!upcoming) return '<section class="hero hero-empty"><div class="hero-copy"><p>Ближайшая смена</p><h2>Нет подтверждённых смен</h2><span>Возможные выходы с # остаются отмечены в календаре.</span></div></section>'
  const codes = upcoming.marks.map(displayCode).join(' + ')
  const label = upcoming.marks.length === 1 && upcoming.marks[0].kind === 'hours' && upcoming.marks[0].hours === 24
    ? '24 ч'
    : codes
  const description = upcoming.marks.map(mark => markDescription(mark, true)).join(' · ')
  return '<section class="hero"><div class="hero-copy"><p>Ближайшая смена</p><h2>' + date(upcoming.date) + '</h2><span>' + esc(description) + '</span></div><strong class="hero-code">' + esc(label) + '</strong></section>'
}

function legacyNotice() {
  if (!legacyNeedsReimport.length) return ''
  const names = legacyNeedsReimport.map(humanMonth).join(', ')
  return '<aside class="legacy-notice"><b>Нужен повторный импорт PDF</b><span>Для ' + esc(names) + ' старая версия не сохранила оригинал. Откройте вкладку «Графики» и загрузите PDF ещё раз, чтобы распознать LHPu, V-коды и другие отметки.</span></aside>'
}

function isMonthBoundaryPart(mark: DayMark) {
  if (mark.kind !== 'hours' || mark.hours !== 16 || !/^16$/i.test(mark.raw)) return false
  const value = new Date(mark.date + 'T12:00:00')
  return value.getDate() === new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
}

function markDescription(mark: DayMark, compact = false) {
  if (mark.kind === 'leave') return mark.raw === 'LHPu' ? 'Отпуск по уходу за ребёнком' : 'Отпуск'
  if (mark.kind === 'tentative') return compact
    ? `${mark.raw} · возможный выход`
    : `Возможный выход на работу · ${hoursText(mark.hours)} · ещё не подтверждён`
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
  if (isMonthBoundaryPart(mark)) return compact
    ? '16 ч · часть смены на границе месяца'
    : 'Часть смены на границе месяца · в этом PDF указано 16 ч; продолжение сверяется со следующим месяцем'
  return compact ? `${hoursText(mark.hours)} · код ${mark.raw}` : `${hoursText(mark.hours)} · код графика ${mark.raw}`
}

function foreignMarkDescription(mark: DayMark, marks: DayMark[], deltaNumber: string) {
  if (!isWorkMark(mark)) return markDescription(mark)
  const draft = buildCalendarDrafts(mark.date.slice(0, 7), deltaNumber, marks).find(item => item.raw === mark.raw && item.kind === mark.kind)
  if (!draft) return markDescription(mark)
  const start = draft.start.dateTime.slice(11, 16)
  const end = draft.end.dateTime.slice(11, 16)
  const nextDay = draft.start.dateTime.slice(0, 10) !== draft.end.dateTime.slice(0, 10)
  const type = mark.kind === 'home' ? 'Домашнее дежурство (koduvalve)' : mark.hours === 24 ? 'Суточная смена' : 'Рабочая отметка'
  return `${type} · код ${mark.raw} · ${start}–${end}${nextDay ? ' следующего дня' : ''}`
}

function foreignEntriesHtml(entries: ForeignDayEntry[], ownDay: boolean) {
  if (!entries.length) return ownDay
    ? '<section class="coworkers-block empty"><b>Других смен нет</b><span>В исходном графике на это время другие D-номера не найдены.</span></section>'
    : ''
  const heading = ownDay
    ? 'Другие на работе · ' + entries.length
    : entries.length > 1 ? 'Другие D-номера · ' + entries.length : 'Другой D-номер · ' + esc(entries[0].deltaNumber)
  const note = ownDay
    ? '<span class="not-yours">Не ваши смены</span>'
    : '<span class="not-yours">У вас смены нет · показаны другие сотрудники</span>'
  const rows = entries.map(entry => '<section class="foreign-entry"><strong>' + esc(entry.deltaNumber) + '</strong><div class="detail-lines">' + entry.marks.map(mark => '<div class="detail-line ' + mark.kind + '"><i></i><div><b>' + esc(displayCode(mark)) + '</b><span>' + esc(foreignMarkDescription(mark, entry.marks, entry.deltaNumber)) + '</span></div></div>').join('') + '</div></section>').join('')
  return '<section class="coworkers-block' + (ownDay ? ' alongside-own' : '') + '"><div class="coworkers-heading"><b class="foreign-title">' + heading + '</b>' + note + '</div><div class="foreign-entries">' + rows + '</div></section>'
}

function dayTone(marks: DayMark[]) {
  const has24 = marks.some(mark => mark.kind === 'hours' && mark.hours === 24)
  const hasBoundary = marks.some(isMonthBoundaryPart)
  const hasDay = marks.some(mark => mark.kind === 'hours' && mark.hours !== 24 && !isMonthBoundaryPart(mark))
  const hasTentative = marks.some(mark => mark.kind === 'tentative')
  const hasHome = marks.some(mark => mark.kind === 'home')
  const hasOther = marks.some(mark => mark.kind === 'other')
  const leave = marks.find((mark): mark is Extract<DayMark, { kind: 'leave' }> => mark.kind === 'leave')
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
  return `${date(dateKey)}: ${marks.map(mark => markDescription(mark)).join('; ')}`
}

function calendarPage(month: MonthRecord, marksByDate: Map<string, DayMark[]>, suppliedForeign?: Map<string, ForeignDayEntry[]>) {
  const currentDay = todayId()
  const value = new Date(month.id + '-01T12:00:00')
  const offset = (value.getDay() + 6) % 7
  const totalDays = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()
  const foreignByDate = suppliedForeign || foreignEntriesByDate(months, month.id, currentDelta)
  const cells: string[] = Array.from({ length: offset }, () => '<i class="day-blank" aria-hidden="true"></i>')
  for (let day = 1; day <= totalDays; day++) {
    const dateKey = month.id + '-' + String(day).padStart(2, '0')
    const marks = marksByDate.get(dateKey) || []
    const hasColleagues = !marks.length && (foreignByDate.get(dateKey)?.length || 0) > 0
    if (!marks.length) {
      const label = hasColleagues ? `${date(dateKey)}: есть смены других D-номеров` : `${date(dateKey)}: нет смен`
      cells.push('<button class="day day-empty ' + (hasColleagues ? 'has-colleagues ' : '') + (selectedDate === dateKey ? 'selected ' : '') + (dateKey === currentDay ? 'today' : '') + '" data-day="' + dateKey + '"' + (dateKey === currentDay ? ' aria-current="date"' : '') + ' aria-label="' + esc(label) + '"><b>' + day + '</b>' + (hasColleagues ? '<i class="colleague-dot" aria-hidden="true"></i>' : '') + '</button>')
      continue
    }
    const regularCodes = marks.filter(mark => mark.kind !== 'home').map(displayCode)
    const homeCodes = marks.filter((mark): mark is WorkMark => mark.kind === 'home').map(displayCode)
    const code = marks.map(displayCode).join('+')
    const codeHtml = regularCodes.length && homeCodes.length
      ? '<small>' + esc(regularCodes.join('+')) + '</small><em class="home-badge">' + esc(homeCodes.join('+')) + '</em>'
      : '<small>' + esc(code) + '</small>'
    const classes = ['day', dayTone(marks), selectedDate === dateKey ? 'selected' : '', dateKey === currentDay ? 'today' : ''].filter(Boolean).join(' ')
    cells.push('<button class="' + classes + '" data-day="' + dateKey + '"' + (dateKey === currentDay ? ' aria-current="date"' : '') + ' aria-label="' + esc(dayAria(dateKey, marks)) + '"><b>' + day + '</b>' + codeHtml + '</button>')
  }
  while (cells.length < 42) cells.push('<i class="day-blank" aria-hidden="true"></i>')
  return '<div class="calendar-page" data-month="' + month.id + '"><div class="grid">' + cells.join('') + '</div></div>'
}

function selectedDetails(marksByDate: Map<string, DayMark[]>, month: MonthRecord, foreignByDate: Map<string, ForeignDayEntry[]>) {
  if (!selectedDate) return ''
  const marks = marksByDate.get(selectedDate) || []
  if (!marks.length) {
    const entries = foreignByDate.get(selectedDate) || []
    const content = entries.length
      ? foreignEntriesHtml(entries, false)
      : '<b>Нет смен</b><span class="empty-detail">В исходном графике на этот день рабочих отметок нет.</span>'
    return '<section class="shift-details ' + (entries.length ? 'foreign-details' : 'empty-details') + '" id="shift-details" aria-label="Информация за ' + esc(date(selectedDate)) + '"><i class="detail-handle" aria-hidden="true"></i><div class="detail-icon">' + (entries.length ? 'D' : '—') + '</div><div class="detail-content"><small>' + date(selectedDate) + '</small>' + content + '</div><button class="detail-close" id="detail-close" aria-label="Закрыть информацию о дне">×</button></section>'
  }
  const hasHome = marks.some(mark => mark.kind === 'home')
  const onlyHome = hasHome && marks.every(mark => mark.kind === 'home' || mark.kind === 'other')
  const onlyLeave = marks.every(mark => mark.kind === 'leave')
  const onlyOther = marks.every(mark => mark.kind === 'other')
  const onlyTentative = marks.every(mark => mark.kind === 'tentative')
  const icon = onlyLeave ? '☼' : onlyHome ? '⌂' : onlyTentative ? '?' : onlyOther ? '⋯' : '◷'
  const lines = marks.map(mark => '<div class="detail-line ' + mark.kind + '"><i></i><div><b>' + esc(displayCode(mark)) + '</b><span>' + esc(markDescription(mark)) + '</span></div></div>').join('')
  const entries = foreignByDate.get(selectedDate) || []
  return '<section class="shift-details" id="shift-details" aria-label="Информация за ' + esc(date(selectedDate)) + '"><i class="detail-handle" aria-hidden="true"></i><div class="detail-icon">' + icon + '</div><div class="detail-content"><b>' + date(selectedDate) + '</b><span class="own-shift-label">Ваша смена</span><div class="detail-lines">' + lines + '</div>' + foreignEntriesHtml(entries, true) + '</div><button class="detail-close" id="detail-close" aria-label="Закрыть информацию о дне">×</button></section>'
}

function monthView(month: MonthRecord) {
  const marksByDate = groupMarks(allMarks())
  const foreignByDate = foreignEntriesByDate(months, month.id, currentDelta)
  return calendarSyncCard(month) + '<section class="calendar-group"><nav class="months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker" aria-label="Выбрать месяц"><span class="month-title">' + humanMonth(month.id) + '</span></button><button id="next" aria-label="Следующий месяц">›</button></nav><section class="calendar" id="calendar"><div class="week">' +
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => '<span>' + day + '</span>').join('') +
    '</div><div class="calendar-viewport" id="calendar-viewport"><div class="calendar-track" id="calendar-track">' + calendarPage(month, marksByDate, foreignByDate) +
    '</div></div><div class="legend-section"><button class="legend-toggle" id="legend-toggle" aria-expanded="' + legendExpanded + '" aria-controls="calendar-legend"><span>Легенда</span><small>7 обозначений</small><i aria-hidden="true">⌄</i></button><div class="legend-collapsible' + (legendExpanded ? ' expanded' : '') + '" id="calendar-legend"><div class="legend"><span><i class="dot duty"></i>24 ч · суточная смена</span><span><i class="dot boundary"></i>16 ч на границе · часть смены</span><span><i class="dot daytime"></i>8 / 12 ч · рабочая отметка</span><span><i class="dot tentative"></i>#… · возможный выход</span><span><i class="dot home"></i>V… · koduvalve дома</span><span><i class="dot vacation"></i>P · отпуск · LHPu · уход за ребёнком</span><span><i class="dot annotation"></i>прочий код PDF</span></div></div></div></section></section>' +
    selectedDetails(marksByDate, month, foreignByDate)
}

function syncFor(month: string, deltaNumber = currentDelta) {
  return syncForAccount(calendarSyncs, month, deltaNumber, googleSettings.accountProfileId)
}

function currentAccountSyncs() {
  return calendarSyncs.filter(sync => sync.accountProfileId === googleSettings.accountProfileId)
}

async function activateGoogleAccount(explicitSwitch: boolean) {
  const accountEmail = await getGoogleAccountEmail()
  const discovery = await discoverDutyAccounts()
  const previous = googleSettings.accountProfileId
  const accountProfileId = resolveGoogleEmailProfile(accountEmail, googleSettings, explicitSwitch, discovery, calendarSyncs) || createGoogleAccountProfileId()
  const accountProfiles = { ...(googleSettings.accountProfiles || {}), [googleEmailKey(accountEmail)]: accountProfileId }
  googleSettings = {
    ...googleSettings,
    enabled: true,
    connectedAt: googleSettings.connectedAt || Date.now(),
    accountProfileId,
    accountEmail,
    accountProfiles,
  }
  await storage.set('googleIntegration', googleSettings)
  setGoogleLoginHint(accountEmail)
  return previous !== accountProfileId
}

async function rememberGoogleSync(timestamp: number) {
  const accountProfileId = googleSettings.accountProfileId
  googleSettings = {
    ...googleSettings,
    enabled: true,
    lastSyncAt: timestamp,
    lastSyncByAccount: accountProfileId
      ? { ...(googleSettings.lastSyncByAccount || {}), [accountProfileId]: timestamp }
      : googleSettings.lastSyncByAccount,
  }
  await storage.set('googleIntegration', googleSettings)
}

function desiredFor(month: string, deltaNumber = currentDelta) {
  return buildCalendarDrafts(month, deltaNumber, allMarksForDelta(months, deltaNumber))
}

function calendarSyncCard(month: MonthRecord) {
  const sync = syncFor(month.id)
  const desired = desiredFor(month.id)
  const plan = planCalendarSync(desired, sync)
  const changed = plan.added.length + plan.changed.length + plan.removed.length > 0
  let tone = 'idle'
  let label = 'Не синхронизирован'
  const candidateAvailable = Boolean(candidateForMonth(month, currentDelta))
  if (!navigator.onLine) { tone = 'error'; label = 'Офлайн · синхронизация недоступна' }
  else if (!candidateAvailable && !sync?.syncedAt) { tone = 'idle'; label = `${currentDelta} не найден в этом PDF` }
  else if (sync?.lastError === 'auth') { tone = 'auth'; label = 'Требуется авторизация' }
  else if (sync?.lastError === 'offline') { tone = 'error'; label = 'Ошибка · нет сети' }
  else if (sync?.lastError === 'api') { tone = 'error'; label = 'Ошибка Google Calendar' }
  else if (sync?.syncedAt && changed) { tone = 'changed'; label = 'Есть изменения' }
  else if (sync?.syncedAt) { tone = 'synced'; label = 'Синхронизирован' }
  const action = sync?.syncedAt ? (changed ? 'Посмотреть изменения' : 'Проверить') : 'Добавить смены'
  const details = sync?.syncedAt
    ? `D-номер ${currentDelta} · ${new Date(sync.syncedAt).toLocaleString('ru-RU')}`
    : `${desired.length} подтверждённых событий · основной календарь`
  const disabled = (!candidateAvailable && !sync?.syncedAt) || !navigator.onLine
  return '<aside class="sync-card ' + tone + (highlightSyncOffer ? ' suggested' : '') + '"><div class="sync-mark">G</div><div class="sync-copy"><b>Google Calendar</b><span class="sync-status"><i></i>' + label + '</span><small title="' + esc(details) + '">' + esc(details) + '</small></div><div class="sync-actions"><button id="sync-month"' + (disabled ? ' disabled' : '') + '>' + action + '</button></div></aside>'
}

function documentsView() {
  const rows = months.length
    ? months.map(month => {
      const candidate = candidateForMonth(month, currentDelta)
      return '<article data-open-pdf="' + month.id + '" role="button" tabindex="0" aria-label="Открыть PDF ' + esc(month.fileName) + '"><div class="doc-icon">▤</div><div><b>' + humanMonth(month.id) + '</b><span>' + esc(month.fileName) + '</span><small>' + (candidate?.shifts.length || 0) + ' подтверждённых отметок для ' + esc(currentDelta) + ' · загружен ' + new Date(month.importedAt).toLocaleDateString('ru-RU') + '</small></div><button class="delete-month" data-delete-month="' + month.id + '" aria-label="Удалить ' + humanMonth(month.id) + '">⌫</button></article>'
    }).join('')
    : '<p>Графики ещё не импортированы.</p>'
  return '<section class="documents-intro"><p>Оригинальные PDF и графики хранятся только на этом устройстве. Нажмите график, чтобы открыть его.</p><button class="primary" id="import">Импортировать PDF</button></section><h2 class="list-title">Загруженные графики</h2><section class="documents">' + rows + '</section><p class="documents-hint">Повторный импорт заменяет только соответствующий месяц и не создаёт дублей.</p>'
}

function formatAnalysisHours(value: number) {
  return String(Math.round(value * 10) / 10).replace('.', ',') + ' ч'
}

function analysisRule(check: AnalysisCheck) {
  const icon = check.tone === 'ok' ? '✓' : check.tone === 'attention' ? '!' : 'i'
  return '<details class="analysis-rule ' + check.tone + '"><summary><i>' + icon + '</i><span><b>' + esc(check.title) + '</b><small>' + esc(check.value) + '</small></span><em>⌄</em></summary><p>' + esc(check.explanation) + '</p></details>'
}

function analysisView(month: MonthRecord) {
  const navigation = '<nav class="months analysis-months"><button id="prev" aria-label="Предыдущий месяц">‹</button><button id="picker" aria-label="Выбрать месяц"><span class="month-title">' + humanMonth(month.id) + '</span></button><button id="next" aria-label="Следующий месяц">›</button></nav>'
  const source = months.find(item => item.id === month.id)
  if (!months.length) return '<section class="analysis-empty"><div>◔</div><h2>Сначала добавьте график</h2><p>Анализ выполняется только на устройстве по данным импортированного PDF.</p><button class="primary" id="import">Импортировать PDF</button></section>'
  if (!source || !candidateForMonth(source, currentDelta)) return navigation + '<section class="analysis-empty compact"><div>—</div><h2>Нет данных для ' + esc(currentDelta) + '</h2><p>Для ' + humanMonth(month.id) + ' график не загружен или в PDF нет выбранного D-номера.</p></section>'
  const analysis = analyzeMonth(months, month.id, currentDelta)
  const totalParts = analysis.homeDutyHours ? '<span>+ ' + formatAnalysisHours(analysis.homeDutyHours) + ' koduvalve отдельно</span>' : '<span>Подтверждённые смены на месте</span>'
  const tentative = analysis.tentativeHours ? '<p class="analysis-tentative">Возможные выходы # не включены: ' + formatAnalysisHours(analysis.tentativeHours) + '</p>' : ''
  const leave = analysis.leaveDays ? '<div><b>' + analysis.leaveDays + '</b><span>дней с отпуском</span></div>' : ''
  const boundary = (!analysis.hasPreviousMonth || !analysis.hasFollowingMonth) ? '<aside class="analysis-boundary"><b>Границы месяца видны не полностью</b><span>Для точной проверки отдыха загрузите также соседние месяцы.</span></aside>' : ''
  const attention = analysis.checks.some(check => check.tone === 'attention')
  const hasLongShifts = analysis.longShiftCount > 0
  const verdict = attention
    ? '<section class="analysis-verdict attention"><i>!</i><div><b>Есть пункты, которые нужно проверить</b><span>Это сигнал посмотреть детали, а не утверждение о нарушении.</span></div></section>'
    : hasLongShifts
      ? '<section class="analysis-verdict info"><i>i</i><div><b>Интервалы отдыха выглядят достаточными</b><span>Законность самих 24-часовых смен зависит от условий, которых нет в PDF.</span></div></section>'
      : '<section class="analysis-verdict"><i>✓</i><div><b>Явных проблем в доступных данных не найдено</b><span>Часть требований нельзя доказать по одному PDF.</span></div></section>'
  return navigation + '<div class="analysis-mode"><b>Summeeritud tööajaarvestus</b><span>Суммированный учёт рабочего времени</span></div><section class="analysis-summary"><small>' + esc(currentDelta) + ' · работа на месте</small><strong>' + formatAnalysisHours(analysis.workHours) + '</strong>' + totalParts + '<div class="hours-bar" aria-label="Дневные ' + formatAnalysisHours(analysis.dayHours) + ', ночные ' + formatAnalysisHours(analysis.nightHours) + '"><i style="--night:' + (analysis.workHours ? analysis.nightHours / analysis.workHours * 100 : 0) + '%"></i></div><div class="hours-key"><span><i class="day-hours"></i>Дневные 06–22 <b>' + formatAnalysisHours(analysis.dayHours) + '</b></span><span><i class="night-hours"></i>Ночные 22–06 <b>' + formatAnalysisHours(analysis.nightHours) + '</b></span></div></section>' + tentative + '<section class="analysis-metrics"><div><b>' + analysis.shiftCount + '</b><span>рабочих смен</span></div><div><b>' + analysis.longShiftCount + '</b><span>смен по 24 ч</span></div><div><b>' + formatAnalysisHours(analysis.homeDutyHours) + '</b><span>koduvalve отдельно</span></div>' + leave + '</section>' + boundary + verdict + '<section class="law-analysis"><header><div><small>Предварительная оценка · суммированный учёт</small><h2>Работа и отдых по закону</h2></div><span>TLS</span></header><p class="law-intro">Откройте пункт, чтобы простым языком увидеть норму, расчёт приложения и ограничения проверки.</p>' + analysis.checks.map(analysisRule).join('') + '<aside class="legal-disclaimer"><b>Важно</b><span>Это справочная автоматическая оценка, не юридическое заключение. PDF не показывает фактические вызовы во время V, перерывы, договор, коллективное соглашение, оценку рисков и весь расчётный период.</span><a href="https://www.riigiteataja.ee/akt/TLS" target="_blank" rel="noopener">Töölepingu seadus · действующая редакция ↗</a><small>Правила сверены с редакцией Riigi Teataja, действующей с 13.02.2026.</small></aside></section>'
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
  document.querySelector('#sync-month')?.addEventListener('click', () => void beginMonthSync(selected))
  document.querySelector('#legend-toggle')?.addEventListener('click', event => {
    legendExpanded = !legendExpanded
    const button = event.currentTarget as HTMLButtonElement
    button.setAttribute('aria-expanded', String(legendExpanded))
    const legend = document.querySelector<HTMLElement>('#calendar-legend')
    legend?.classList.toggle('expanded', legendExpanded)
    if (legendExpanded) window.setTimeout(() => {
      const content = legend?.closest<HTMLElement>('.app-content')
      if (!content || !legend) return
      const overflow = legend.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom + 10
      if (overflow > 0) content.scrollTo({ top: content.scrollTop + overflow, behavior: 'smooth' })
    }, 330)
  })
  document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.onclick = () => { section = button.dataset.section as AppSection; selectedDate = null; render() })
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
    await deleteLocalMonth(button.dataset.deleteMonth!)
  })
  const calendar = document.querySelector<HTMLElement>('#calendar')
  calendar?.addEventListener('click', event => {
    if (Date.now() < ignoreDayClicksUntil || !(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-day]')
    if (button) selectDay(button.dataset.day!)
  })
  document.querySelector('#detail-close')?.addEventListener('click', () => {
    selectedDate = null
    render()
  })
  enableCalendarSwipe()
}

function selectDay(value: string) {
  selectedDate = selectedDate === value ? null : value
  render()
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
  })
  calendar.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId || monthTransitioning) return
    lastX = event.clientX
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      horizontal = true
      calendar.setPointerCapture(event.pointerId)
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
  const preferred = currentDelta || await storage.setting<string>('deltaNumber')
  const automatic = preferred && parsed.candidates.find(candidate => candidate.number === preferred)
  if (automatic && !parsed.warnings.length) {
    await savePick(automatic)
    return
  }
  const choices = parsed.candidates.map(candidate => {
    const workCount = candidate.marks.filter(isWorkMark).length
    const tentativeCount = candidate.marks.filter(mark => mark.kind === 'tentative').length
    return '<button data-delta="' + candidate.number + '" class="choice ' + (candidate.number === preferred ? 'recommended' : '') + '"><b>' + candidate.number + '</b><span>' + workCount + ' подтверждённых рабочих отметок' + (tentativeCount ? ' · возможных ' + tentativeCount : '') + (candidate.leaveDates.length ? ' · отпуск ' + candidate.leaveDates.length + ' дн.' : '') + (candidate.number === preferred ? ' · использовали раньше' : '') + '</span></button>'
  }).join('')
  open('<h2>Чей это график?</h2><p>' + humanMonth(parsed.month) + ' · найдены номера из PDF. ' + parsed.warnings.join(' ') + '</p><div class="choices">' + choices + '</div><button class="primary" id="cancel">Отмена</button>')
  document.querySelectorAll<HTMLButtonElement>('[data-delta]').forEach(button => button.onclick = () => savePick(parsed.candidates.find(candidate => candidate.number === button.dataset.delta)!))
  document.querySelector('#cancel')!.addEventListener('click', close)
}

async function savePick(candidate: Candidate, deltaChangeConfirmed = false) {
  if (!pending) return
  if (!deltaChangeConfirmed && currentDelta && candidate.number !== currentDelta) {
    const oldSyncs = currentAccountSyncs().filter(sync => sync.deltaNumber === currentDelta && Object.keys(sync.events).length)
    if (oldSyncs.length) {
      const oldDelta = currentDelta
      const count = oldSyncs.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
      open('<h2>Импорт меняет D-номер</h2><p>Вы выбрали ' + esc(candidate.number) + ', а для ' + esc(oldDelta) + ' в Google отслеживается событий: ' + count + '. Номера не будут смешаны.</p><button class="primary" id="keep-import">Импортировать, события ' + esc(oldDelta) + ' оставить</button><button class="danger" id="remove-import">Сначала удалить события ' + esc(oldDelta) + '</button><button id="cancel">Отмена</button>')
      document.querySelector('#cancel')?.addEventListener('click', close)
      document.querySelector('#keep-import')?.addEventListener('click', () => void savePick(candidate, true))
      document.querySelector('#remove-import')?.addEventListener('click', () => void removeSyncRecords(oldSyncs, () => savePick(candidate, true)))
      return
    }
  }
  const old = months.find(month => month.id === pending!.parsed.month)
  const hadSync = Boolean(syncFor(pending.parsed.month, candidate.number)?.syncedAt)
  const hash = await digest(pending.file)
  const record: MonthRecord = {
    id: pending.parsed.month,
    fileName: pending.file.name,
    importedAt: Date.now(),
    hash,
    marks: candidate.marks,
    candidates: pending.parsed.candidates,
    shifts: candidate.shifts,
    leaveDates: candidate.leaveDates,
    leaveCodes: candidate.leaveCodes,
    deltaNumber: candidate.number,
    status: old && old.hash !== hash ? 'changed' : 'local',
    calendar: { dirty: true },
  }
  await storage.saveImport(record, pending.file)
  await storage.set('deltaNumber', candidate.number)
  currentDelta = candidate.number
  close()
  pending = null
  selected = record.id
  selectedDate = null
  if (!old) highlightSyncOffer = true
  await refresh()
  if (hadSync) showImportedSyncChanges(record.id)
}

async function digest(file: File) {
  const value = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(value)].map(item => item.toString(16).padStart(2, '0')).join('')
}

function syncErrorKind(error: unknown): 'auth' | 'offline' | 'api' {
  if (error instanceof GoogleAuthError) return 'auth'
  if (!navigator.onLine || error instanceof TypeError) return 'offline'
  return 'api'
}

async function rememberSyncError(month: string, error: unknown, deltaNumber = currentDelta) {
  const previous = syncFor(month, deltaNumber)
  const record: CalendarMonthSync = previous
    ? { ...previous, lastError: syncErrorKind(error) }
    : { id: calendarSyncId(month, deltaNumber, googleSettings.accountProfileId), month, deltaNumber, accountProfileId: googleSettings.accountProfileId, events: {}, lastError: syncErrorKind(error) }
  await storage.putSync(record)
  calendarSyncs = [...calendarSyncs.filter(item => item.id !== record.id), record]
}

function googleErrorText(error: unknown) {
  if (error instanceof GoogleAuthError) return error.message
  if (!navigator.onLine || error instanceof TypeError) return 'Нет подключения к интернету. Локальный календарь продолжает работать.'
  if (error instanceof GoogleApiError && error.status === 412) return 'Событие изменилось в Google Calendar во время подтверждения. Запустите проверку ещё раз.'
  return error instanceof Error ? error.message : 'Не удалось выполнить операцию Google Calendar.'
}

async function handleGoogleError(month: string, error: unknown, deltaNumber = currentDelta) {
  await rememberSyncError(month, error, deltaNumber)
  render()
  open('<h2>Google Calendar</h2><p>' + esc(googleErrorText(error)) + '</p><button class="primary" id="close">Понятно</button>')
  document.querySelector('#close')?.addEventListener('click', close)
}

async function withGoogleAuthorization(month: string, action: () => Promise<void>, errorDelta = currentDelta) {
  const expectedAccountProfileId = googleSettings.accountProfileId
  if (!navigator.onLine) {
    await handleGoogleError(month, new TypeError('offline'), errorDelta)
    return
  }
  if (hasLiveGoogleToken()) {
    try { await action() } catch (error) { await handleGoogleError(month, error, errorDelta) }
    return
  }
  try {
    open('<div class="busy"><div class="spinner"></div><h2>Готовим вход через Google</h2><p>PDF и весь график остаются на устройстве.</p></div>')
    await prepareGoogleIdentityServices()
    open('<h2>Google Calendar</h2><p>Google получит только события, которые вы подтвердите для основного календаря. Токен доступа хранится только в памяти до окончания сеанса.</p><button class="primary" id="google-continue">Продолжить с Google</button><button id="cancel">Отмена</button>')
    document.querySelector('#cancel')?.addEventListener('click', close)
    document.querySelector<HTMLButtonElement>('#google-continue')?.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement
      button.disabled = true
      try {
        await requestGoogleToken('')
        const changedAccount = await activateGoogleAccount(false)
        if (expectedAccountProfileId && changedAccount) throw new GoogleAuthError('Google-аккаунт изменился. Повторите операцию для пересчитанного состояния.')
        await action()
      } catch (error) {
        await handleGoogleError(month, error, errorDelta)
      }
    })
  } catch (error) {
    await handleGoogleError(month, error, errorDelta)
  }
}

async function installationId() {
  const saved = await storage.setting<string>('installationId')
  if (saved) return saved
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  await storage.set('installationId', value)
  return value
}

function previewRows(month: string, plan: ReturnType<typeof planCalendarSync>) {
  const row = (sign: string, title: string, detail: string, tone: string) => '<li class="' + tone + '"><b>' + sign + '</b><span>' + esc(title) + '<small>' + esc(detail) + '</small></span></li>'
  const eventText = (draft: ReturnType<typeof desiredFor>[number]) => {
    const start = draft.start.dateTime.slice(11, 16)
    const end = draft.end.dateTime.slice(11, 16)
    const nextDay = draft.start.dateTime.slice(0, 10) !== draft.end.dateTime.slice(0, 10)
    return `${draft.summary} · ${start}–${end}${nextDay ? ' следующего дня' : ''}`
  }
  return [
    ...plan.added.map(draft => row('+', date(draft.date), eventText(draft), 'added')),
    ...plan.changed.map(change => row('↻', date(change.after.date), eventText(change.before.draft) + ' → ' + eventText(change.after), 'changed')),
    ...plan.removed.map(event => row('−', date(event.draft.date), eventText(event.draft), 'removed')),
  ].join('')
}

async function beginMonthSync(month: string) {
  highlightSyncOffer = false
  await withGoogleAuthorization(month, () => previewMonthSync(month, false))
}

async function beginRemoveMonthEvents(month: string, after?: () => Promise<void>) {
  await withGoogleAuthorization(month, () => previewMonthSync(month, true, after))
}

async function previewMonthSync(month: string, removeAll: boolean, after?: () => Promise<void>) {
  const previous = syncFor(month)
  const desired = removeAll ? [] : desiredFor(month)
  try {
    open('<div class="busy"><div class="spinner"></div><h2>Проверяем Google Calendar</h2><p>Сверяем только события, созданные этой PWA.</p></div>')
    const audits: RemoteAudit[] = previous ? await auditCalendarSync(previous, googleCalendarGateway) : []
    const plan = planCalendarSync(desired, previous)
    const remoteChanged = audits.filter(audit => audit.status === 'changed').length
    const remoteMissing = audits.filter(audit => audit.status === 'missing').length
    const unsafe = audits.filter(audit => audit.status === 'unsafe').length
    const metadata = audits.filter(audit => audit.status === 'metadata').length
    const hasWork = plan.added.length + plan.changed.length + plan.removed.length + remoteChanged + remoteMissing + unsafe + metadata > 0
    if (!hasWork) {
      if (removeAll) {
        if (previous) await storage.removeSync(previous.id)
        if (after) await after()
        await refresh()
        open('<h2>Событий нет</h2><p>Для ' + humanMonth(month) + ' и ' + esc(currentDelta) + ' в Google Calendar ничего не осталось.</p><button class="primary" id="close">Готово</button>')
        document.querySelector('#close')?.addEventListener('click', close)
        return
      }
      const record: CalendarMonthSync = previous
        ? { ...previous, syncedAt: Date.now(), lastError: undefined }
        : { id: calendarSyncId(month, currentDelta, googleSettings.accountProfileId), month, deltaNumber: currentDelta, accountProfileId: googleSettings.accountProfileId, syncedAt: Date.now(), events: {} }
      await storage.putSync(record)
      await rememberGoogleSync(record.syncedAt!)
      await refresh()
      open('<h2>Всё актуально</h2><p>Изменений для ' + humanMonth(month) + ' и ' + esc(currentDelta) + ' нет.</p><button class="primary" id="close">Готово</button>')
      document.querySelector('#close')?.addEventListener('click', close)
      return
    }
    const warning = (remoteChanged || remoteMissing)
      ? '<aside class="sync-warning"><b>Изменения непосредственно в Google</b><span>' + (remoteChanged ? `Изменено вручную: ${remoteChanged}. ` : '') + (remoteMissing ? `Удалено вручную: ${remoteMissing}. ` : '') + 'После подтверждения события будут восстановлены по PDF.</span></aside>'
      : ''
    const unsafeWarning = unsafe
      ? '<aside class="sync-warning"><b>Потеряна метка принадлежности: ' + unsafe + '</b><span>Эти события не будут изменены или удалены. При необходимости PWA создаст безопасную замену.</span></aside>'
      : ''
    const metadataNotice = metadata
      ? '<aside class="sync-warning"><b>Обновление связи Google-аккаунта</b><span>Событий: ' + metadata + '. Сами смены не изменились; PWA добавит только новую защищённую метку аккаунта.</span></aside>'
      : ''
    const title = removeAll ? 'Удалить события из Google?' : 'Подтвердите синхронизацию'
    const rows = previewRows(month, plan)
    open('<h2>' + title + '</h2><p><b>' + syncSummary(plan) + '</b><br>Основной календарь · ' + esc(currentDelta) + '</p>' + warning + unsafeWarning + metadataNotice + (rows ? '<ul class="sync-preview">' + rows + '</ul>' : '') + '<button class="primary" id="apply-sync">' + (removeAll ? 'Удалить отмеченные события' : 'Применить изменения') + '</button><button id="cancel">Отмена</button>')
    document.querySelector('#cancel')?.addEventListener('click', close)
    document.querySelector<HTMLButtonElement>('#apply-sync')?.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement
      button.disabled = true
      try {
        if (!hasLiveGoogleToken()) {
          await requestGoogleToken('')
          if (await activateGoogleAccount(false)) throw new GoogleAuthError('Google-аккаунт изменился. Откройте синхронизацию ещё раз для пересчитанного состояния.')
        }
        const install = await installationId()
        open('<div class="busy"><div class="spinner"></div><h2>Обновляем Google Calendar</h2><p>Не закрывайте это окно.</p></div>')
        const result = await applyCalendarSync({
          month,
          deltaNumber: currentDelta,
          desired,
          previous,
          audits,
          gateway: googleCalendarGateway,
          eventId: (key, recovery) => deterministicGoogleEventId(install, calendarSyncId(month, currentDelta, googleSettings.accountProfileId), key, recovery),
          accountProfileId: googleSettings.accountProfileId,
        })
        if (removeAll) await storage.removeSync(result.id)
        else await storage.putSync(result)
        await rememberGoogleSync(result.syncedAt!)
        if (after) await after()
        await refresh()
        open('<h2>' + (removeAll ? 'События удалены' : 'Синхронизация завершена') + '</h2><p>Изменения применены только к событиям PWA для ' + humanMonth(month) + ' и ' + esc(currentDelta) + '.</p><button class="primary" id="close">Готово</button>')
        document.querySelector('#close')?.addEventListener('click', close)
      } catch (error) {
        await handleGoogleError(month, error)
      }
    })
  } catch (error) {
    await handleGoogleError(month, error)
  }
}

function showMonths() {
  const choices = months.map(month => '<button class="choice" data-month="' + month.id + '"><b>' + humanMonth(month.id) + '</b><span>' + esc(month.fileName) + ' · ' + (candidateForMonth(month, currentDelta)?.shifts.length || 0) + ' подтверждённых отметок для ' + esc(currentDelta) + '</span></button>').join('')
  open('<h2>Загруженные месяцы</h2><div class="choices">' + choices + '</div><button class="primary" id="close">Закрыть</button>')
  document.querySelectorAll<HTMLElement>('[data-month]').forEach(item => item.addEventListener('click', () => {
    selected = item.dataset.month!
    selectedDate = null
    close()
    render()
  }))
  document.querySelector('#close')!.addEventListener('click', close)
}

function showImportedSyncChanges(month: string) {
  const sync = syncFor(month)
  if (!sync) return
  const plan = planCalendarSync(desiredFor(month), sync)
  if (!plan.added.length && !plan.changed.length && !plan.removed.length) return
  open('<h2>График уточнён</h2><p><b>' + syncSummary(plan) + '</b><br>События Google пока не изменены.</p><button class="primary" id="review-sync">Проверить и синхронизировать</button><button id="cancel">Позже</button>')
  document.querySelector('#cancel')?.addEventListener('click', close)
  document.querySelector('#review-sync')?.addEventListener('click', () => void beginMonthSync(month))
}

function showSettings() {
  const tracked = currentAccountSyncs().reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  const trackedAcrossAccounts = calendarSyncs.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  const googleLabel = googleSettings.enabled ? `${googleSettings.accountEmail || 'аккаунт определяется'} · Подключено` : 'Не подключено'
  const accountLastSync = googleSettings.accountProfileId ? googleSettings.lastSyncByAccount?.[googleSettings.accountProfileId] : undefined
  const lastSync = accountLastSync ? new Date(accountLastSync).toLocaleString('ru-RU') : 'синхронизаций ещё не было'
  open('<h2>Настройки</h2><p>Данные графиков хранятся в IndexedDB только на этом устройстве.</p><button class="calendar-button" id="delta-settings">Текущий D-номер <span>' + esc(currentDelta || 'не выбран') + '</span></button><button class="calendar-button google-settings-card" id="google-settings"><b>Google Calendar</b><span>' + esc(googleLabel) + '</span><small>Последняя синхронизация: ' + esc(lastSync) + (tracked ? ' · управляемых событий: ' + tracked : '') + '</small></button><nav class="settings-legal" aria-label="Правовая информация"><a href="privacy/" target="_blank" rel="noopener">Политика конфиденциальности</a><a href="terms/" target="_blank" rel="noopener">Условия использования</a></nav><button class="danger" id="wipe">Удалить все локальные данные</button><button class="primary" id="close">Закрыть</button>')
  document.querySelector('#close')?.addEventListener('click', close)
  document.querySelector('#delta-settings')?.addEventListener('click', showDeltaSettings)
  document.querySelector('#google-settings')?.addEventListener('click', showGoogleSettings)
  document.querySelector('#wipe')?.addEventListener('click', async () => {
    const warning = trackedAcrossAccounts ? ' События Google Calendar при этом останутся; сначала удалите их через настройки соответствующего Google-аккаунта, если они больше не нужны.' : ''
    if (confirm('Удалить все локальные PDF, графики и настройки с этого устройства?' + warning)) {
      await storage.clear()
      currentDelta = ''
      googleSettings = { enabled: false }
      setGoogleLoginHint(undefined)
      close()
      await refresh()
    }
  })
}

function showDeltaSettings() {
  const choices = knownDeltaNumbers(months).map(number => '<button class="choice ' + (number === currentDelta ? 'recommended' : '') + '" data-select-delta="' + esc(number) + '"><b>' + esc(number) + '</b><span>' + (number === currentDelta ? 'Выбран сейчас' : 'Найден в импортированных PDF') + '</span></button>').join('')
  open('<h2>Текущий D-номер</h2><p>PDF и остальные D-номера сохранятся. Календарь перестроится сразу.</p><div class="choices">' + choices + '</div><button class="primary" id="cancel">Отмена</button>')
  document.querySelector('#cancel')?.addEventListener('click', showSettings)
  document.querySelectorAll<HTMLButtonElement>('[data-select-delta]').forEach(button => button.addEventListener('click', () => void proposeDeltaSwitch(button.dataset.selectDelta!)))
}

async function proposeDeltaSwitch(nextDelta: string) {
  if (nextDelta === currentDelta) { showSettings(); return }
  const oldDelta = currentDelta
  const oldSyncs = currentAccountSyncs().filter(sync => sync.deltaNumber === oldDelta && Object.keys(sync.events).length)
  if (!oldSyncs.length) {
    await applyDeltaSwitch(nextDelta)
    return
  }
  const eventCount = oldSyncs.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  open('<h2>' + esc(oldDelta) + ' уже синхронизирован</h2><p>В Google Calendar отслеживается событий: ' + eventCount + '. Они не будут смешаны с ' + esc(nextDelta) + '.</p><button class="primary" id="keep-and-switch">Сменить D-номер, события оставить</button><button class="danger" id="remove-and-switch">Удалить события ' + esc(oldDelta) + ' из Google</button><button id="cancel">Отмена</button>')
  document.querySelector('#cancel')?.addEventListener('click', showDeltaSettings)
  document.querySelector('#keep-and-switch')?.addEventListener('click', () => void applyDeltaSwitch(nextDelta))
  document.querySelector('#remove-and-switch')?.addEventListener('click', () => void removeSyncRecords(oldSyncs, () => applyDeltaSwitch(nextDelta)))
}

async function applyDeltaSwitch(nextDelta: string) {
  currentDelta = nextDelta
  selectedDate = null
  await storage.set('deltaNumber', nextDelta)
  close()
  render()
}

function showGoogleSettings() {
  const records = currentAccountSyncs().filter(sync => Object.keys(sync.events).length)
  const eventCount = records.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  const currentRecord = selected ? syncFor(selected) : undefined
  const currentEventCount = currentRecord ? Object.keys(currentRecord.events).length : 0
  const status = googleSettings.enabled
    ? '<b>' + esc(googleSettings.accountEmail || 'Аккаунт будет определён при следующей проверке') + '</b> · Подключено'
    : 'Интеграция выключена. Локальные функции работают без Google.'
  const syncAction = googleSettings.enabled && selected ? '<button class="primary" id="google-sync-current">Проверить / синхронизировать ' + esc(humanMonth(selected)) + '</button>' : ''
  const removeMonthAction = currentEventCount ? '<button class="calendar-button google-remove-month" id="remove-google-current">Удалить события ' + esc(humanMonth(selected)) + ' из Google <span>локальный график оставить</span></button>' : ''
  open('<h2>Google Calendar</h2><p>' + status + '</p><p>Смены добавляются в <b>primary</b>. PWA управляет только событиями со своей защищённой меткой.</p>' + syncAction + (googleSettings.enabled ? '<button class="calendar-button" id="switch-google">Сменить Google-аккаунт <span>выбрать явно</span></button><button class="calendar-button" id="disconnect-google">Отключить интеграцию <span>события оставить</span></button>' : '<button class="primary" id="connect-google">Подключить Google Calendar</button>') + removeMonthAction + (eventCount ? '<button class="danger" id="remove-all-google">Удалить все события PWA из Google (' + eventCount + ')</button>' : '') + '<button id="back">Назад</button>')
  document.querySelector('#back')?.addEventListener('click', showSettings)
  document.querySelector('#connect-google')?.addEventListener('click', () => void connectGoogleFromSettings())
  document.querySelector('#switch-google')?.addEventListener('click', () => void switchGoogleAccount())
  document.querySelector('#google-sync-current')?.addEventListener('click', () => { close(); void beginMonthSync(selected) })
  document.querySelector('#remove-google-current')?.addEventListener('click', () => void beginRemoveMonthEvents(selected))
  document.querySelector('#disconnect-google')?.addEventListener('click', async () => {
    await revokeGoogleAccess()
    googleSettings = { ...googleSettings, enabled: false, accountEmail: undefined }
    await storage.set('googleIntegration', googleSettings)
    setGoogleLoginHint(undefined)
    showGoogleSettings()
  })
  document.querySelector('#remove-all-google')?.addEventListener('click', () => void removeSyncRecords(records, async () => {}))
}

async function switchGoogleAccount() {
  if (!navigator.onLine) {
    open('<h2>Нет сети</h2><p>Смена Google-аккаунта требует интернет.</p><button class="primary" id="back">Понятно</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
    return
  }
  try {
    open('<div class="busy"><div class="spinner"></div><h2>Готовим выбор аккаунта</h2></div>')
    await prepareGoogleIdentityServices()
    open('<h2>Сменить Google-аккаунт?</h2><p>События и sync metadata прежнего аккаунта сохранятся отдельно и не будут смешаны с выбранным аккаунтом.</p><button class="primary" id="select-google-account">Выбрать Google-аккаунт</button><button id="back">Отмена</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
    document.querySelector<HTMLButtonElement>('#select-google-account')?.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement
      button.disabled = true
      try {
        clearGoogleAccessToken()
        await requestGoogleToken('select_account')
        await activateGoogleAccount(true)
        await refresh()
        open('<h2>Google-аккаунт выбран</h2><p><b>' + esc(googleSettings.accountEmail || '') + '</b><br>Состояние синхронизации пересчитано для выбранного основного календаря. Данные других аккаунтов остались изолированы.</p><button class="primary" id="back">Готово</button>')
        document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
      } catch (error) {
        open('<h2>Не удалось сменить аккаунт</h2><p>' + esc(googleErrorText(error)) + '</p><button class="primary" id="back">Понятно</button>')
        document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
      }
    })
  } catch (error) {
    open('<h2>Не удалось сменить аккаунт</h2><p>' + esc(googleErrorText(error)) + '</p><button class="primary" id="back">Понятно</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
  }
}

async function connectGoogleFromSettings() {
  if (!navigator.onLine) {
    open('<h2>Нет сети</h2><p>Подключение Google требует интернет. Все локальные функции доступны офлайн.</p><button class="primary" id="back">Понятно</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
    return
  }
  try {
    open('<div class="busy"><div class="spinner"></div><h2>Готовим вход через Google</h2></div>')
    await prepareGoogleIdentityServices()
    open('<h2>Подключить Google Calendar?</h2><p>Токен не сохраняется долговременно. Никакие события не будут созданы до отдельного подтверждения синхронизации месяца.</p><button class="primary" id="authorize-google">Продолжить с Google</button><button id="back">Отмена</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
    document.querySelector('#authorize-google')?.addEventListener('click', async () => {
      try {
        await requestGoogleToken('')
        await activateGoogleAccount(false)
        showGoogleSettings()
      } catch (error) {
        open('<h2>Не удалось подключить</h2><p>' + esc(googleErrorText(error)) + '</p><button class="primary" id="back">Понятно</button>')
        document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
      }
    })
  } catch (error) {
    open('<h2>Не удалось подключить</h2><p>' + esc(googleErrorText(error)) + '</p><button class="primary" id="back">Понятно</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
  }
}

async function deleteLocalMonth(id: string) {
  const syncRecords = currentAccountSyncs().filter(sync => sync.month === id && Object.keys(sync.events).length)
  const removeLocal = async () => { await storage.remove(id) }
  if (!syncRecords.length) {
    if (confirm('Удалить ' + humanMonth(id) + ' из приложения? Исходный PDF в папке устройства не удаляется.')) {
      await removeLocal()
      await refresh()
    }
    return
  }
  const count = syncRecords.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  open('<h2>Месяц синхронизирован</h2><p>В Google Calendar отслеживается событий: ' + count + '. Исходный PDF вне приложения не удаляется.</p><button class="primary" id="local-only">Удалить только локально</button><button class="danger" id="local-and-google">Удалить также события Google</button><button id="cancel">Отмена</button>')
  document.querySelector('#cancel')?.addEventListener('click', close)
  document.querySelector('#local-only')?.addEventListener('click', async () => { await removeLocal(); close(); await refresh() })
  document.querySelector('#local-and-google')?.addEventListener('click', () => void removeSyncRecords(syncRecords, removeLocal))
}

async function removeSyncRecords(records: CalendarMonthSync[], after: () => Promise<void>) {
  if (!records.length) { await after(); await refresh(); return }
  const contextMonth = records[0].month
  await withGoogleAuthorization(contextMonth, async () => {
    open('<div class="busy"><div class="spinner"></div><h2>Проверяем события Google</h2></div>')
    const audited: Array<{ sync: CalendarMonthSync; audits: RemoteAudit[] }> = []
    for (const sync of records) audited.push({ sync, audits: await auditCalendarSync(sync, googleCalendarGateway) })
    const total = records.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
    const changed = audited.flatMap(item => item.audits).filter(audit => audit.status === 'changed').length
    const missing = audited.flatMap(item => item.audits).filter(audit => audit.status === 'missing').length
    const unsafe = audited.flatMap(item => item.audits).filter(audit => audit.status === 'unsafe').length
    open('<h2>Удалить события PWA из Google?</h2><p>Отслеживаемых событий: ' + total + '.' + (changed ? ' Изменено вручную: ' + changed + '.' : '') + (missing ? ' Уже удалено: ' + missing + '.' : '') + '</p>' + (unsafe ? '<aside class="sync-warning"><b>Без метки PWA: ' + unsafe + '</b><span>Они не будут затронуты.</span></aside>' : '') + '<button class="danger" id="confirm-remove-google">Удалить подтверждённые события</button><button id="cancel">Отмена</button>')
    document.querySelector('#cancel')?.addEventListener('click', close)
    document.querySelector('#confirm-remove-google')?.addEventListener('click', async () => {
      try {
        if (!hasLiveGoogleToken()) {
          await requestGoogleToken('')
          if (await activateGoogleAccount(false)) throw new GoogleAuthError('Google-аккаунт изменился. Повторите операцию для выбранного аккаунта.')
        }
        open('<div class="busy"><div class="spinner"></div><h2>Удаляем события PWA</h2></div>')
        const install = await installationId()
        for (const item of audited) {
          await applyCalendarSync({ month: item.sync.month, deltaNumber: item.sync.deltaNumber, desired: [], previous: item.sync, audits: item.audits, gateway: googleCalendarGateway, eventId: (key, recovery) => deterministicGoogleEventId(install, item.sync.id, key, recovery), accountProfileId: item.sync.accountProfileId })
          await storage.removeSync(item.sync.id)
        }
        await after()
        await rememberGoogleSync(Date.now())
        await refresh()
        open('<h2>Готово</h2><p>Удалены только события, однозначно отмеченные как созданные этой PWA.</p><button class="primary" id="close">Закрыть</button>')
        document.querySelector('#close')?.addEventListener('click', close)
      } catch (error) {
        await handleGoogleError(contextMonth, error, records[0].deltaNumber)
      }
    })
  }, records[0].deltaNumber)
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
window.addEventListener('online', render)
window.addEventListener('offline', render)
refresh()
