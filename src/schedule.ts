import type { Shift } from './types'

export const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
export function normalizeCrossMonth(raw: Shift[]): Shift[] {
  return [...raw].sort((a, b) => a.date.localeCompare(b.date)).flatMap(shift => {
    const date = new Date(`${shift.date}T12:00:00`)
    const previous = new Date(date); previous.setDate(date.getDate() - 1)
    const prevKey = previous.toISOString().slice(0, 10)
    const isFirst = date.getDate() === 1
    const isLast = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() === date.getDate()
    const prev = raw.find(item => item.date === prevKey)
    if (isFirst && /^8$/i.test(shift.code) && prev && prev.hours === 16 && prev.date.slice(8) === String(new Date(previous.getFullYear(), previous.getMonth()+1, 0).getDate()).padStart(2, '0')) return []
    return [isLast && shift.hours === 16 ? { ...shift, hours: 24, code: '16+8' } : shift]
  })
}
export function timeLabel(shift: Shift) {
  const d = new Date(`${shift.date}T08:00:00`); const end = new Date(d.getTime() + shift.hours * 3600000)
  const day = (v: Date) => `${v.getDate()} ${MONTHS[v.getMonth()]}`
  return d.getDate() === end.getDate() ? `08:00–${String(end.getHours()).padStart(2, '0')}:00` : `с 08:00 ${day(d)} до ${String(end.getHours()).padStart(2, '0')}:00 ${day(end)}`
}
export const humanMonth = (id: string) => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(new Date(`${id}-01T12:00:00`))
