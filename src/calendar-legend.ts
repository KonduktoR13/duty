import { esc } from './ui'

const personalColors = ['purple', 'blue', 'green', 'orange', 'pink', 'grey']
const personalTone = (color: string) => `personal-day-color color-${color}`
const sections = [
  {
    title: 'Смены и отметки',
    entries: [
      { label: '24 ч · суточная смена', tones: ['duty-24'] },
      { label: '16 ч на границе · часть смены', tones: ['boundary-shift'] },
      { label: 'Другие рабочие часы · например, 8 / 12 ч', tones: ['day-schedule'] },
      { label: '#… · возможный выход', tones: ['tentative-shift'] },
      { label: 'V… · koduvalve дома', tones: ['home-duty'] },
      { label: 'Смена и koduvalve в один день · смешанный фон', tones: ['mixed-duty-home', 'mixed-day-home'] },
      { label: 'P / P-et · отпуск', tones: ['leave-vacation'] },
      { label: 'LHPu · отпуск по уходу за ребёнком из PDF', tones: ['leave-childcare'] },
      { label: 'Прочий код PDF', tones: ['other-code'] },
    ],
  },
  {
    title: 'Ручные записи',
    entries: [
      { label: 'Дополнительный выход', tones: ['duty-24', 'day-schedule'] },
      { label: 'Erakorraline · экстренный выход', tones: ['duty-24', 'day-schedule'] },
      { label: 'Koduvalve · домашнее дежурство', tones: ['home-duty'] },
      { label: 'Отпуск', tones: ['leave-vacation'] },
      { label: 'Больничный', tones: [personalTone('purple')] },
      { label: 'Уход за ребёнком · больничный по уходу', tones: [personalTone('purple')] },
      { label: 'Компенсационный отдых', tones: [personalTone('purple')] },
      { label: 'Своя запись · выбранный цвет', tones: personalColors.map(personalTone) },
    ],
  },
]

export const calendarLegendCount = sections.reduce((n, s) => n + s.entries.length, 0)

export function calendarLegendView() {
  return sections.map(section => `<section class="legend-block"><h3>${esc(section.title)}</h3><div class="legend-rows">${section.entries.map(entry =>
    `<div class="legend-row"><span class="legend-samples" aria-hidden="true">${entry.tones.map(tone => `<i class="day legend-swatch ${tone}"></i>`).join('')}</span><span>${esc(entry.label)}</span></div>`,
  ).join('')}</div></section>`).join('') +
    '<p class="legend-note">Ручной выход: 24 часа — цвет суточной смены, другая длительность — рабочий цвет. Больничный, уход и компенсационный отдых — цвет записи, по умолчанию фиолетовый. Заметка на день смены добавляет метку и сохраняет рабочий фон.</p>'
}
