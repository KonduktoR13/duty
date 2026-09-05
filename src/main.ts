import { registerSW } from 'virtual:pwa-register'
import { storage } from './db'
const parsePdf = async (file: File) => (await import('./parser')).parsePdf(file)
import { nextWork, intervalTime, tallinnWallTime } from './intervals'
import { esc, icon, openDialog as open, closeDialog, localError, run, dialogBusy } from './ui'
import { allMarksForDelta, candidateForMonth, candidatesForMonth, isWorkMark, knownDeltaNumbers, migrateMark, type ForeignDayEntry } from './roster'
import { applyCalendarSync, auditCalendarSync, buildCalendarDrafts, calendarSyncId, planCalendarSync, syncForAccount, syncSummary, type RemoteAudit } from './calendar-sync'
import { calendarRemindersLabel, normalizeCalendarReminders, reminderOffsetLabel, reminderSignature } from './calendar-reminders'
import { clearGoogleAccessToken, deterministicGoogleEventId, discoverDutyAccounts, getGoogleAccountEmail, GoogleApiError, GoogleAuthError, googleCalendarGateway, hasLiveGoogleToken, patchGoogleEventReminders, prepareGoogleIdentityServices, requestGoogleToken, revokeGoogleAccess, setGoogleLoginHint } from './google-calendar'
import { createGoogleAccountProfileId, googleEmailKey, resolveGoogleEmailProfile } from './google-account'
import { humanMonth } from './schedule'
import { analysisView } from './analysis-view'
import { importReview } from './import-review'
import { documentsView } from './documents-view'
import { createCalendarView } from './calendar-view'
import type { CalendarMonthSync, CalendarReminderSettings, Candidate, DayMark, GoogleIntegrationSettings, MonthRecord, ParsedSchedule } from './types'
import './style.css'
import './interaction.css'
import './experience.css'

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
function close() { pending = null; closeDialog() }
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
let calendarMode: 'grid' | 'list' = 'grid'
let showColleagues = false
let revisions = new Set<string>()

const localDateId = (value = new Date()) => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
const todayId = () => tallinnWallTime().slice(0, 10)
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

function upcomingDay() { return nextWork(allMarks()) }

async function refresh() {
  ;[months, calendarSyncs, googleSettings] = await Promise.all([
    storage.months(),
    storage.syncs(),
    storage.setting<GoogleIntegrationSettings>('googleIntegration').then(value => value || { enabled: false }),
  ])
  revisions = new Set((await Promise.all(months.map(async month => await storage.revision(month.id) ? month.id : ''))).filter(Boolean))
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
        await storage.put({ ...month, rosterComplete: true, candidates: parsed.candidates, marks: candidate.marks, shifts: candidate.shifts, leaveDates: candidate.leaveDates, leaveCodes: candidate.leaveCodes })
        upgraded = true
        continue
      } catch {
        legacyNeedsReimport.push(month.id)
      }
    }
    const fallback = candidatesForMonth(month)
    if (fallback.length) {
      await storage.put({ ...month, candidates: fallback, rosterComplete: false })
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
  if (!selected) selected = months.find(month => month.id === todayId().slice(0, 7))?.id || months[0]?.id || todayId().slice(0, 7)
  selectedDate = null
  render()
}

function render() {
  const focused = document.activeElement as HTMLElement | null
  const focusId = focused?.id
  const focusDay = focused?.dataset.day
  const focusAgenda = focused?.dataset.agendaDay
  const focusSection = focused?.dataset.section
  const previousScroll = document.querySelector<HTMLElement>('.app-content')?.scrollTop || 0
  const restoreScroll = lastRenderedSection === section ? previousScroll : 0
  lastRenderedSection = section
  const current = months.find(month => month.id === selected) || blankMonth(selected)
  const mainContent = section === 'documents'
    ? documentsView(months, currentDelta, revisions)
    : section === 'analysis'
      ? analysisView(current, months, currentDelta)
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
    (section === 'documents' ? 'active' : '') + '">▤<span>Графики</span></button></nav></div><input id="file" type="file" accept="application/pdf,.pdf" hidden>'
  bind()
  document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => {
    if (button.dataset.section === section) button.setAttribute('aria-current', 'page')
    button.innerHTML = icon(button.dataset.section!) + '<span>' + ({ calendar: 'Календарь', analysis: 'Анализ', documents: 'Графики' }[button.dataset.section!] || '') + '</span>'
  })
  const settings = document.querySelector('#settings')!
  settings.innerHTML = icon('settings')
  document.querySelector('.brand>span')!.innerHTML = icon('calendar')
  if (currentDelta) {
    const delta = document.createElement('button'); delta.className = 'delta-chip'; delta.id = 'header-delta'; delta.textContent = currentDelta + ' ▾'; delta.setAttribute('aria-label', 'Выбран ' + currentDelta + '. Сменить номер'); delta.onclick = showDeltaSettings; settings.before(delta)
  }
  document.querySelectorAll<HTMLElement>('[data-night]').forEach(bar => bar.style.setProperty('--night', bar.dataset.night + '%'))
  requestAnimationFrame(() => {
    const content = document.querySelector<HTMLElement>('.app-content')
    if (content) content.scrollTop = restoreScroll
    if (!document.querySelector('#dialog[open]')) {
      const target = focusDay ? document.querySelector<HTMLElement>('[data-day="' + focusDay + '"]') : focusAgenda ? document.querySelector<HTMLElement>('[data-agenda-day="' + focusAgenda + '"]') : focusSection ? document.querySelector<HTMLElement>('[data-section="' + focusSection + '"]') : focusId ? document.getElementById(focusId) : null
      target?.focus({ preventScroll: true })
    }
  })
}

function welcome() {
  return '<section class="welcome"><div class="shield">⌂</div><h2>Ваш график остаётся вашим</h2><p>PDF обрабатывается прямо в браузере и сохраняется только на этом устройстве. Мы не отправляем файл, смены или Delta-номер на сервер.</p><button class="primary" id="import">Выбрать PDF-график</button><small>Поддерживаются месячные PDF Delta. Интернет для импорта не нужен после установки.</small><nav class="legal-links" aria-label="Правовая информация"><a href="privacy/" target="_blank" rel="noopener">Политика конфиденциальности</a><a href="terms/" target="_blank" rel="noopener">Условия использования</a></nav></section>'
}

function hero(upcoming: ReturnType<typeof upcomingDay>) {
  if (!upcoming) return '<section class="hero hero-empty"><div class="hero-copy"><p>Следующая смена</p><h2>Нет будущих смен</h2><span>Добавьте следующий PDF в разделе «Графики».</span></div></section>'
  const first = upcoming.intervals[0]
  const label = upcoming.intervals.map(item => hoursText(item.hours)).join(' + ')
  const description = upcoming.intervals.map(item => intervalTime(item) + (item.kind === 'home' ? ' · дома' : '')).join(' · ')
  return '<button class="hero" id="hero-day" data-target-date="' + first.date + '"><div class="hero-copy"><p>' + (upcoming.active ? 'Сейчас на смене' : 'Следующая смена') + '</p><h2>' + (first.date === todayId() ? 'Сегодня' : date(first.date)) + '</h2><span>' + esc(description) + '</span><small>Код ' + esc(first.raw) + ' · время Таллина</small></div><strong class="hero-code">' + esc(label) + '</strong></button>'
}

function legacyNotice() {
  if (!legacyNeedsReimport.length) return ''
  const names = legacyNeedsReimport.map(humanMonth).join(', ')
  return '<aside class="legacy-notice"><b>Нужен повторный импорт PDF</b><span>Для ' + esc(names) + ' старая версия не сохранила оригинал. Откройте вкладку «Графики» и загрузите PDF ещё раз, чтобы распознать LHPu, V-коды и другие отметки.</span></aside>'
}

function calendarView() { return createCalendarView({ months, currentDelta, selectedDate, legendExpanded, showColleagues, calendarMode, allMarks, groupMarks, todayId, date, calendarSyncCard }) }
function monthView(month: MonthRecord) { return calendarView().monthView(month) }
function calendarPage(month: MonthRecord, marks: Map<string, DayMark[]>, foreign?: Map<string, ForeignDayEntry[]>) { return calendarView().calendarPage(month, marks, foreign) }

function syncFor(month: string, deltaNumber = currentDelta) {
  return syncForAccount(calendarSyncs, month, deltaNumber, googleSettings.accountProfileId)
}

function currentAccountSyncs() {
  return calendarSyncs.filter(sync => sync.accountProfileId === googleSettings.accountProfileId)
}

function currentCalendarReminders() {
  return normalizeCalendarReminders(googleSettings.calendarReminders)
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



function date(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' }).format(new Date(value + 'T12:00:00'))
}

function adjacent(direction: number) {
  const value = new Date(selected + '-01T12:00:00')
  value.setMonth(value.getMonth() + direction)
  return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0')
}

function bind() {
  bindBackups()
  document.querySelectorAll<HTMLButtonElement>('[data-restore-month]').forEach(button => button.onclick = () => {
    const id = button.dataset.restoreMonth!
    open('<h2>Вернуть предыдущий график?</h2><p>' + humanMonth(id) + '. События Google пока не изменятся. После возврата проверьте синхронизацию.</p><button class="primary" id="confirm-revision">Вернуть предыдущую версию</button><button id="cancel">Отмена</button>')
    document.querySelector('#cancel')?.addEventListener('click', close)
    document.querySelector('#confirm-revision')?.addEventListener('click', () => run(async () => { await storage.restoreRevision(id); close(); await refresh() }))
  })
  document.querySelector('#today')?.addEventListener('click', () => { selected = todayId().slice(0, 7); selectedDate = null; render() })
  document.querySelector('#hero-day')?.addEventListener('click', event => { selectedDate = (event.currentTarget as HTMLElement).dataset.targetDate!; selected = selectedDate.slice(0, 7); render() })
  document.querySelector('#grid-mode')?.addEventListener('click', () => { calendarMode = 'grid'; render(); run(() => storage.set('calendarMode', calendarMode)) })
  document.querySelector('#list-mode')?.addEventListener('click', () => { calendarMode = 'list'; render(); run(() => storage.set('calendarMode', calendarMode)) })
  document.querySelector('#show-colleagues')?.addEventListener('change', event => { showColleagues = (event.target as HTMLInputElement).checked; render(); run(() => storage.set('showColleagues', showColleagues)) })
  document.querySelectorAll<HTMLElement>('[data-agenda-day]').forEach(button => button.onclick = () => selectDay(button.dataset.agendaDay!))
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
  document.querySelectorAll<HTMLButtonElement>('[data-analysis-jump]').forEach(button => button.onclick = () => {
    const target = document.getElementById(button.dataset.analysisJump!) as HTMLDetailsElement | null
    if (!target) return
    target.open = true
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    target.classList.add('analysis-focus')
    window.setTimeout(() => target.classList.remove('analysis-focus'), 1200)
  })
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
  calendar?.addEventListener('keydown', event => {
    if (!(event.target instanceof HTMLElement) || !event.target.dataset.day) return
    const movement: Record<string, number> = { ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7 }
    if (!(event.key in movement)) return
    event.preventDefault()
    const day = new Date(event.target.dataset.day + 'T12:00:00')
    day.setDate(day.getDate() + movement[event.key])
    const key = localDateId(day)
    if (key.slice(0,7) !== selected) { selected=key.slice(0,7); selectedDate=null; render() }
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-day="'+key+'"]')?.focus())
  })
  calendar?.addEventListener('click', event => {
    if (Date.now() < ignoreDayClicksUntil || !(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-day]')
    if (button) selectDay(button.dataset.day!)
  })
  document.querySelector('#detail-close')?.addEventListener('click', closeDayDetails, { once: true })
  enableCalendarSwipe()
}

function selectDay(value: string) {
  if (selectedDate === value) { closeDayDetails(); return }
  selectedDate = value
  render()
}

function closeDayDetails() {
  const card = document.querySelector<HTMLElement>('#shift-details')
  const button = document.querySelector<HTMLButtonElement>('#detail-close')
  if (!selectedDate || !card) return
  const returnDate = selectedDate
  ignoreDayClicksUntil = Date.now() + 650
  button?.setAttribute('disabled', '')
  card.classList.add('closing')
  window.setTimeout(() => {
    selectedDate = null
    render()
    document.querySelector<HTMLElement>('[data-day="' + returnDate + '"],[data-agenda-day="' + returnDate + '"]')?.focus({preventScroll:true})
  }, 420)
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
    await reviewPick(automatic)
    return
  }
  const choices = parsed.candidates.map(candidate => {
    const workCount = candidate.marks.filter(isWorkMark).length
    const tentativeCount = candidate.marks.filter(mark => mark.kind === 'tentative').length
    return '<button data-delta="' + candidate.number + '" class="choice ' + (candidate.number === preferred ? 'recommended' : '') + '"><b>' + candidate.number + '</b><span>' + workCount + ' подтверждённых рабочих отметок' + (tentativeCount ? ' · возможных ' + tentativeCount : '') + (candidate.leaveDates.length ? ' · отпуск ' + candidate.leaveDates.length + ' дн.' : '') + (candidate.number === preferred ? ' · использовали раньше' : '') + '</span></button>'
  }).join('')
  open('<h2>Чей это график?</h2><p>' + humanMonth(parsed.month) + ' · найдены номера из PDF. ' + parsed.warnings.join(' ') + '</p><div class="choices">' + choices + '</div><button class="primary" id="cancel">Отмена</button>')
  document.querySelectorAll<HTMLButtonElement>('[data-delta]').forEach(button => button.onclick = () => run(() => reviewPick(parsed.candidates.find(candidate => candidate.number === button.dataset.delta)!)))
  document.querySelector('#cancel')!.addEventListener('click', close)
}

async function reviewPick(candidate: Candidate) {
  if (!pending) return
  const old = months.find(month => month.id === pending!.parsed.month)
  const hash = await digest(pending.file)
  if (old?.hash === hash && currentDelta === candidate.number) {
    open('<h2>Этот график уже сохранён</h2><p>Файл совпадает с загруженным. Изменений нет.</p><button class="primary" id="close">Готово</button>')
    pending = null
    document.querySelector('#close')?.addEventListener('click', close)
    return
  }
  open('<h2>' + (old ? 'Заменить график?' : 'Сохранить график?') + '</h2><p>' + humanMonth(pending.parsed.month) + '</p>' + importReview(candidate, old) + '<button class="primary" id="confirm-import">Сохранить график</button><button id="cancel">Отмена</button>')
  document.querySelector('#cancel')?.addEventListener('click', () => { pending = null; close() })
  document.querySelector<HTMLButtonElement>('#confirm-import')?.addEventListener('click', event => { (event.currentTarget as HTMLButtonElement).disabled = true; run(() => savePick(candidate)) })
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
    rosterComplete: true,
    shifts: candidate.shifts,
    leaveDates: candidate.leaveDates,
    leaveCodes: candidate.leaveCodes,
    deltaNumber: candidate.number,
    status: old && old.hash !== hash ? 'changed' : 'local',
    calendar: { dirty: true },
  }
  await storage.saveImport(record, pending.file)
  void navigator.storage?.persist?.().catch(() => false)
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
  const previous = await storage.sync(calendarSyncId(month, deltaNumber, googleSettings.accountProfileId)) || syncFor(month, deltaNumber)
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
    const reminderNote = removeAll ? '' : '<p class="reminder-preview"><b>Уведомления:</b> ' + esc(calendarRemindersLabel(currentCalendarReminders())) + '</p>'
    open('<h2>' + title + '</h2><p><b>' + syncSummary(plan) + '</b><br>Основной календарь · ' + esc(currentDelta) + '</p>' + reminderNote + warning + unsafeWarning + metadataNotice + (rows ? '<ul class="sync-preview">' + rows + '</ul>' : '') + '<button class="primary" id="apply-sync">' + (removeAll ? 'Удалить отмеченные события' : 'Применить изменения') + '</button><button id="cancel">Отмена</button>')
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
          reminders: currentCalendarReminders(),
          checkpoint: async sync => { await storage.putSync(sync) },
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

function bindBackups() {
  document.querySelector('#export-backup')?.addEventListener('click', () => run(async () => { await (await import('./backup')).exportBackup() }))
  document.querySelector('#import-backup')?.addEventListener('click', () => run(async () => { (await import('./backup')).chooseBackup(async () => { currentDelta = ''; selected = ''; await start() }) }))
}

function showSettings() {
  const tracked = currentAccountSyncs().reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  const trackedAcrossAccounts = calendarSyncs.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  const googleLabel = googleSettings.enabled ? `${googleSettings.accountEmail || 'аккаунт определяется'} · Подключено` : 'Не подключено'
  const accountLastSync = googleSettings.accountProfileId ? googleSettings.lastSyncByAccount?.[googleSettings.accountProfileId] : undefined
  const lastSync = accountLastSync ? new Date(accountLastSync).toLocaleString('ru-RU') : 'синхронизаций ещё не было'
  open('<h2>Настройки</h2><p>Графики и оригиналы PDF сохраняются на этом устройстве.</p><button class="calendar-button" id="delta-settings">Текущий D-номер <span>' + esc(currentDelta || 'не выбран') + '</span></button><button class="calendar-button google-settings-card" id="google-settings"><b>Google Calendar</b><span>' + esc(googleLabel) + '</span><small>Последняя синхронизация: ' + esc(lastSync) + (tracked ? ' · событий приложения: ' + tracked : '') + '</small></button><nav class="settings-legal" aria-label="Правовая информация"><a href="privacy/" target="_blank" rel="noopener">Политика конфиденциальности</a><a href="terms/" target="_blank" rel="noopener">Условия использования</a></nav><button class="danger" id="wipe">Удалить все локальные данные</button><button class="primary" id="close">Закрыть</button>')
  document.querySelector('#close')?.addEventListener('click', close)
  const tools = document.createElement('section')
  tools.innerHTML = '<button class="calendar-button" id="export-backup">Сохранить резервную копию</button><button class="calendar-button" id="import-backup">Восстановить из копии</button><p class="storage-status" role="status">Проверяем хранилище…</p>'
  document.querySelector('#wipe')?.before(tools)
  bindBackups()
  run(async () => { tools.querySelector('.storage-status')!.textContent = await (await import('./backup')).storageDescription() })
  document.querySelector('#delta-settings')?.addEventListener('click', showDeltaSettings)
  document.querySelector('#google-settings')?.addEventListener('click', showGoogleSettings)
  document.querySelector('#wipe')?.addEventListener('click', async () => {
    const warning = trackedAcrossAccounts ? ' События Google Calendar при этом останутся; сначала удалите их через настройки соответствующего Google-аккаунта, если они больше не нужны.' : ''
    if (confirm('Удалить все локальные PDF, графики и настройки с этого устройства?' + warning)) {
      await storage.clear()
      currentDelta = ''
      googleSettings = { enabled: false }
      clearGoogleAccessToken()
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
  const remindersAction = googleSettings.enabled ? '<button class="calendar-button reminder-settings-button" id="calendar-reminders"><b>Уведомления о сменах</b><span>' + esc(calendarRemindersLabel(currentCalendarReminders())) + '</span><small>' + (eventCount ? 'Можно применить сразу ко всем синхронизированным сменам' : 'Будет применяться к новым сменам') + '</small></button>' : ''
  open('<h2>Google Calendar</h2><p>' + status + '</p><p>Смены добавляются в <b>primary</b>. PWA управляет только событиями со своей защищённой меткой.</p>' + syncAction + remindersAction + (googleSettings.enabled ? '<button class="calendar-button" id="switch-google">Сменить Google-аккаунт <span>выбрать явно</span></button><button class="calendar-button" id="disconnect-google">Отключить интеграцию <span>события оставить</span></button>' : '<button class="primary" id="connect-google">Подключить Google Calendar</button>') + removeMonthAction + (eventCount ? '<button class="danger" id="remove-all-google">Удалить все события PWA из Google (' + eventCount + ')</button>' : '') + '<button id="back">Назад</button>')
  document.querySelector('#back')?.addEventListener('click', showSettings)
  document.querySelector('#connect-google')?.addEventListener('click', () => void connectGoogleFromSettings())
  document.querySelector('#switch-google')?.addEventListener('click', () => void switchGoogleAccount())
  document.querySelector('#google-sync-current')?.addEventListener('click', () => { close(); void beginMonthSync(selected) })
  document.querySelector('#calendar-reminders')?.addEventListener('click', showCalendarReminderSettings)
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

function showCalendarReminderSettings() {
  const current = currentCalendarReminders()
  const option = (mode: CalendarReminderSettings['mode'], title: string, text: string) => '<button class="choice ' + (current.mode === mode ? 'recommended' : '') + '" data-reminder-mode="' + mode + '"><b>' + title + '</b><span>' + text + '</span></button>'
  open('<h2>Уведомления о сменах</h2><p>Напоминания отсчитываются от начала смены. Настройка относится только к событиям этой PWA.</p><div class="choices">' +
    option('default', 'Как в Google Calendar', 'Использовать стандартные уведомления основного календаря') +
    option('none', 'Без уведомлений', 'Создавать смены без напоминаний') +
    option('custom', 'Настроить', current.mode === 'custom' ? calendarRemindersLabel(current) : 'Одно или несколько напоминаний до начала смены') +
    '</div><button id="back">Назад</button>')
  document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
  document.querySelector('[data-reminder-mode="default"]')?.addEventListener('click', () => confirmCalendarReminderSettings({ mode: 'default' }))
  document.querySelector('[data-reminder-mode="none"]')?.addEventListener('click', () => confirmCalendarReminderSettings({ mode: 'none' }))
  document.querySelector('[data-reminder-mode="custom"]')?.addEventListener('click', () => showCustomCalendarReminders(current.mode === 'custom' ? current.minutes : [60]))
}

function showCustomCalendarReminders(initial: number[]) {
  let selectedMinutes = [...new Set(initial)].sort((a, b) => a - b).slice(0, 5)
  const renderEditor = () => {
    const presets = [15, 60, 120, 720, 1_440].map(minutes => '<button data-reminder-preset="' + minutes + '"' + (selectedMinutes.includes(minutes) ? ' class="active" aria-pressed="true"' : ' aria-pressed="false"') + '>' + reminderOffsetLabel(minutes) + '</button>').join('')
    const chips = selectedMinutes.length
      ? selectedMinutes.map(minutes => '<button class="reminder-chip" data-remove-reminder="' + minutes + '" aria-label="Убрать ' + esc(reminderOffsetLabel(minutes)) + '">' + esc(reminderOffsetLabel(minutes)) + ' ×</button>').join('')
      : '<span class="reminder-empty">Выберите хотя бы одно напоминание</span>'
    open('<h2>Свои уведомления</h2><p>Можно установить до пяти напоминаний.</p><div class="reminder-presets">' + presets + '</div><div class="reminder-chips">' + chips + '</div><div class="reminder-add"><input id="reminder-value" type="number" inputmode="numeric" min="1" value="30" aria-label="Интервал"><select id="reminder-unit" aria-label="Единица времени"><option value="1">минут</option><option value="60">часов</option><option value="1440">дней</option></select><button id="add-reminder">Добавить</button></div><button class="primary" id="save-reminders"' + (selectedMinutes.length ? '' : ' disabled') + '>Продолжить</button><button id="back">Назад</button>')
    document.querySelector('#back')?.addEventListener('click', showCalendarReminderSettings)
    document.querySelectorAll<HTMLButtonElement>('[data-reminder-preset]').forEach(button => button.addEventListener('click', () => {
      const minutes = Number(button.dataset.reminderPreset)
      selectedMinutes = selectedMinutes.includes(minutes) ? selectedMinutes.filter(item => item !== minutes) : [...selectedMinutes, minutes].sort((a, b) => a - b).slice(0, 5)
      renderEditor()
    }))
    document.querySelectorAll<HTMLButtonElement>('[data-remove-reminder]').forEach(button => button.addEventListener('click', () => {
      selectedMinutes = selectedMinutes.filter(item => item !== Number(button.dataset.removeReminder))
      renderEditor()
    }))
    document.querySelector('#add-reminder')?.addEventListener('click', () => {
      const value = Number(document.querySelector<HTMLInputElement>('#reminder-value')?.value)
      const unit = Number(document.querySelector<HTMLSelectElement>('#reminder-unit')?.value)
      const minutes = value * unit
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 40_320 || selectedMinutes.length >= 5) return
      selectedMinutes = [...new Set([...selectedMinutes, minutes])].sort((a, b) => a - b)
      renderEditor()
    })
    document.querySelector('#save-reminders')?.addEventListener('click', () => confirmCalendarReminderSettings({ mode: 'custom', minutes: selectedMinutes }))
  }
  renderEditor()
}

function confirmCalendarReminderSettings(value: CalendarReminderSettings) {
  const next = normalizeCalendarReminders(value)
  const records = currentAccountSyncs().filter(sync => Object.keys(sync.events).length)
  const eventCount = records.reduce((sum, sync) => sum + Object.keys(sync.events).length, 0)
  if (!eventCount) {
    void saveCalendarReminderSettings(next).then(showGoogleSettings)
    return
  }
  open('<h2>Применить уведомления?</h2><p><b>' + esc(calendarRemindersLabel(next)) + '</b><br>Новая настройка всегда будет использоваться для следующих смен.</p><button class="primary" id="reminders-all">Применить ко всем сменам (' + eventCount + ')</button><button id="reminders-new">Только для новых</button><button id="back">Отмена</button>')
  document.querySelector('#back')?.addEventListener('click', showCalendarReminderSettings)
  document.querySelector('#reminders-new')?.addEventListener('click', async () => { await saveCalendarReminderSettings(next); showGoogleSettings() })
  document.querySelector('#reminders-all')?.addEventListener('click', async () => { await saveCalendarReminderSettings(next); await updateAllCalendarReminders(records, next) })
}

async function saveCalendarReminderSettings(value: CalendarReminderSettings) {
  googleSettings = { ...googleSettings, calendarReminders: normalizeCalendarReminders(value) }
  await storage.set('googleIntegration', googleSettings)
}

async function updateAllCalendarReminders(records: CalendarMonthSync[], settings: CalendarReminderSettings) {
  const contextMonth = records[0]?.month || selected
  await withGoogleAuthorization(contextMonth, async () => {
    open('<div class="busy"><div class="spinner"></div><h2>Проверяем события Google</h2><p>Проверяем защищённые метки PWA перед обновлением.</p></div>')
    const audited: Array<{ sync: CalendarMonthSync; audits: RemoteAudit[] }> = []
    for (const sync of records) audited.push({ sync, audits: await auditCalendarSync(sync, googleCalendarGateway) })
    const allAudits = audited.flatMap(item => item.audits)
    const updateCount = allAudits.filter(audit => audit.status === 'ok' || audit.status === 'changed' || audit.status === 'metadata').length
    const missing = allAudits.filter(audit => audit.status === 'missing').length
    const unsafe = allAudits.filter(audit => audit.status === 'unsafe').length
    const skipped = missing + unsafe
    if (!updateCount) {
      open('<h2>Нет доступных событий</h2><p>Не найдено событий PWA, которым можно безопасно изменить уведомления.' + (skipped ? ' Пропущено: ' + skipped + '.' : '') + '</p><button class="primary" id="back">Понятно</button>')
      document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
      return
    }
    open('<h2>Обновить уведомления?</h2><p><b>' + esc(calendarRemindersLabel(settings)) + '</b><br>Будет обновлено событий: ' + updateCount + '. Время, название и содержание событий не изменятся.' + (skipped ? ' Пропущено удалённых или небезопасных событий: ' + skipped + '.' : '') + '</p><button class="primary" id="confirm-reminder-update">Обновить уведомления</button><button id="back">Отмена</button>')
    document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
    document.querySelector<HTMLButtonElement>('#confirm-reminder-update')?.addEventListener('click', async event => {
      ;(event.currentTarget as HTMLButtonElement).disabled = true
      try {
        if (!hasLiveGoogleToken()) {
          await requestGoogleToken('')
          if (await activateGoogleAccount(false)) throw new GoogleAuthError('Google-аккаунт изменился. Повторите операцию для выбранного аккаунта.')
        }
        open('<div class="busy"><div class="spinner"></div><h2>Обновляем уведомления</h2><p>Не закрывайте это окно.</p></div>')
        const signature = reminderSignature(settings)
        const timestamp = Date.now()
        for (const item of audited) {
          const events = { ...item.sync.events }
          for (const audit of item.audits) {
            if (audit.status !== 'ok' && audit.status !== 'changed' && audit.status !== 'metadata') continue
            const tracked = events[audit.key]
            if (!tracked || !audit.remote) continue
            const remote = await patchGoogleEventReminders(tracked.eventId, settings, audit.remote.etag)
            events[audit.key] = {
              ...tracked,
              reminderSignature: signature,
              etag: audit.status === 'changed' ? tracked.etag : (remote.etag || tracked.etag),
              updated: remote.updated || tracked.updated,
            }
          }
          await storage.putSync({ ...item.sync, events, syncedAt: timestamp, lastError: undefined })
        }
        await rememberGoogleSync(timestamp)
        await refresh()
        open('<h2>Уведомления обновлены</h2><p>Настройка применена к ' + updateCount + ' событиям этой PWA.' + (skipped ? ' Пропущено: ' + skipped + '.' : '') + '</p><button class="primary" id="back">Готово</button>')
        document.querySelector('#back')?.addEventListener('click', showGoogleSettings)
      } catch (error) {
        await handleGoogleError(contextMonth, error)
      }
    })
  })
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
    open('<h2>Сменить Google-аккаунт?</h2><p>События и история синхронизации прежнего аккаунта сохранятся отдельно и не будут смешаны с выбранным аккаунтом.</p><button class="primary" id="select-google-account">Выбрать Google-аккаунт</button><button id="back">Отмена</button>')
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
          await applyCalendarSync({ month: item.sync.month, deltaNumber: item.sync.deltaNumber, desired: [], previous: item.sync, audits: item.audits, gateway: googleCalendarGateway, eventId: (key, recovery) => deterministicGoogleEventId(install, item.sync.id, key, recovery), accountProfileId: item.sync.accountProfileId, checkpoint: async sync => { await storage.putSync(sync) } })
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

async function openPdf(id: string, popup: Window | null = null) {
  const pdf = await storage.pdf(id)
  if (!pdf) {
    popup?.close()
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
    if (dialogBusy() || pending || document.querySelector('#dialog[open]')) { notice.querySelector('span')!.textContent = 'Сначала завершите действие и закройте диалог.'; return }
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
function networkChanged() {
  if (document.querySelector('#dialog[open]')) {
    const dialog = document.querySelector('#dialog')!
    let status = dialog.querySelector<HTMLElement>('.network-status')
    if (!status) { status = document.createElement('p'); status.className = 'network-status'; status.setAttribute('role', 'status'); dialog.append(status) }
    status.textContent = navigator.onLine ? 'Соединение восстановлено.' : 'Нет сети. Локальные данные доступны.'
  } else render()
}
window.addEventListener('online', networkChanged)
document.addEventListener('keydown', event => { if (event.key === 'Escape' && selectedDate && !document.querySelector('#dialog[open]')) closeDayDetails() })
document.addEventListener('cancel', () => { if (!dialogBusy()) pending = null }, true)
window.addEventListener('offline', networkChanged)
window.addEventListener('unhandledrejection', event => { event.preventDefault(); localError(event.reason) })
window.addEventListener('beforeunload', event => { if (dialogBusy()) { event.preventDefault(); event.returnValue = '' } })
async function start() {
  try {
    calendarMode = await storage.setting<'grid' | 'list'>('calendarMode') === 'list' ? 'list' : 'grid'
    showColleagues = Boolean(await storage.setting('showColleagues'))
    await refresh()
  } catch (error) {
    app.innerHTML = '<section class="welcome"><h1>Не удалось открыть данные</h1><p>Проверьте доступ к хранилищу браузера и свободное место. Данные не удалены.</p><button class="primary" id="retry-start">Повторить</button></section>'
    document.querySelector('#retry-start')?.addEventListener('click', () => void start())
    localError(error)
  }
}
void start()
setInterval(() => { if (!document.hidden && !document.querySelector('#dialog[open]') && !monthTransitioning && !calendarGestureActive) render() }, 60_000)
