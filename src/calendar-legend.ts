import { esc } from './ui'

const personalColors = ['purple', 'blue', 'green', 'orange', 'pink', 'grey']
const personalTone = (color: string) => `personal-day-color color-${color}`
const scheduleEntries = [
  { label: '24 ч · суточная смена', tones: ['duty-24'] },
  { label: '16 ч на границе · часть смены', tones: ['boundary-shift'] },
  { label: 'Другие рабочие часы · например, 8 / 12 ч', tones: ['day-schedule'] },
  { label: '#… · возможный выход', tones: ['tentative-shift'] },
  { label: 'V… · koduvalve дома', tones: ['home-duty'] },
  { label: 'Смена и koduvalve в один день · смешанный фон', tones: ['mixed-duty-home', 'mixed-day-home'] },
  { label: 'Возможный выход и koduvalve', tones: ['mixed-tentative-home'] },
  { label: 'Рабочие часы и возможный выход', tones: ['mixed-day-tentative'] },
  { label: 'Koduvalve и прочий код PDF', tones: ['mixed-home-other'] },
  { label: 'P / P-et · отпуск', tones: ['leave-vacation'] },
  { label: 'LHPu · отпуск по уходу за ребёнком из PDF', tones: ['leave-childcare'] },
  { label: 'Прочий код PDF', tones: ['other-code'] },
]
const personalEntries = [
  { kind: 'extra', label: 'Дополнительный выход', tones: ['duty-24', 'day-schedule'] },
  { kind: 'emergency', label: 'Erakorraline · экстренный выход', tones: ['duty-24', 'day-schedule'] },
  { kind: 'home', label: 'Koduvalve · домашнее дежурство', tones: ['home-duty'] },
  { kind: 'vacation', label: 'Отпуск', tones: ['leave-vacation'] },
  { kind: 'sick', label: 'Больничный', tones: [personalTone('purple')] },
  { kind: 'care', label: 'Уход за ребёнком · больничный по уходу', tones: [personalTone('purple')] },
  { kind: 'timeoff', label: 'Компенсационный отдых', tones: [personalTone('purple')] },
  { kind: 'note', label: 'Своя запись · выбранный цвет', tones: personalColors.map(personalTone) },
]
const cancellationEntries = [
  { label: '⊘ · смена отменена вами', symbol: '⊘' },
  { label: '! · отмена завершена или смена изменилась', symbol: '!' },
]
const note = '<p class="legend-note">Ручной выход: 24 часа — цвет суточной смены, другая длительность — рабочий цвет. Больничный, уход и компенсационный отдых — цвет записи, по умолчанию фиолетовый. Заметка на день смены добавляет метку и сохраняет рабочий фон.</p>'

const swatch = (tone: string) => `<i class="day legend-swatch ${tone}"></i>`
const fullEntry = ({ label, tones }: { label: string; tones: string[] }) =>
  ({ label, samples: tones.map(swatch).join('') })

export function bindCalendarLegend(monthOnly: boolean, save: (monthOnly: boolean) => void) {
  const toggle = document.querySelector<HTMLInputElement>('#legend-month-only')
  const content = document.querySelector<HTMLElement>('#legend-entries')
  const count = document.querySelector<HTMLElement>('#legend-toggle small')
  if (!toggle || !content || !count) return

  // Read the decorated month so the legend uses the same tones and markers as the grid.
  const days = [...document.querySelectorAll<HTMLElement>('#calendar-track [data-day]')]
  const monthSchedule = scheduleEntries.map(({ label, tones }) => fullEntry({
    label,
    tones: tones.filter(tone => days.some(day =>
      day.classList.contains(tone) && !day.classList.contains('personal-day-color'),
    )),
  }))

  const markers = days.flatMap(day => [...day.querySelectorAll<HTMLElement>('[data-legend-kind]')])
  const monthPersonal = personalEntries.map(({ kind, label }) => {
    const samples = new Set<string>()
    for (const marker of markers.filter(marker => marker.dataset.legendKind === kind)) {
      const color = personalColors.find(color => marker.classList.contains(`color-${color}`))
      const day = marker.closest('[data-day]')
      if (color && marker === marker.parentElement?.firstElementChild &&
          day?.classList.contains('personal-day-color')) {
        samples.add(swatch(personalTone(color)))
      }
      samples.add(`<i class="legend-marker${color ? ` color-${color}` : ''}">${esc(marker.textContent || '')}</i>`)
    }
    return { label, samples: [...samples].join('') }
  })
  const cancellations = days.flatMap(day => [...day.querySelectorAll('.cancelled-marker')])
  for (const { label, symbol } of cancellationEntries) {
    if (cancellations.some(marker => marker.textContent === symbol)) {
      monthPersonal.push({ label, samples: `<i class="legend-marker cancelled-marker">${symbol}</i>` })
    }
  }

  const number = new Intl.PluralRules('ru')
  const units: Partial<Record<Intl.LDMLPluralRule, string>> = { one: 'обозначение', few: 'обозначения' }
  const update = (onlyMonth: boolean) => {
    const schedule = onlyMonth ? monthSchedule : scheduleEntries.map(fullEntry)
    const personal = onlyMonth ? monthPersonal : [...personalEntries.map(fullEntry), {
      label: '⊘ · отменена вами; ! · отмена завершена или смена изменилась',
      samples: swatch('cancelled-swatch'),
    }]
    const sections = [
      { title: 'Смены и отметки', entries: schedule.filter(entry => entry.samples) },
      { title: 'Ручные записи', entries: personal.filter(entry => entry.samples) },
    ]
    const total = sections.reduce((sum, section) => sum + section.entries.length, 0)
    const unit = units[number.select(total)] || 'обозначений'
    count.textContent = `${total} ${unit}`
    content.innerHTML = sections.filter(section => section.entries.length).map(section =>
      `<section class="legend-block"><h3>${section.title}</h3><div class="legend-rows">${section.entries.map(entry =>
        `<div class="legend-row"><span class="legend-samples" aria-hidden="true">${entry.samples}</span><span>${esc(entry.label)}</span></div>`,
      ).join('')}</div></section>`,
    ).join('') + (onlyMonth ? total ? '' : '<p class="legend-note">В этом месяце нет обозначений.</p>' : note)
  }

  toggle.checked = monthOnly
  update(monthOnly)
  toggle.addEventListener('change', () => {
    update(toggle.checked)
    save(toggle.checked)
  })
}
