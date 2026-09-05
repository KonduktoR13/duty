import type { Shift } from './types'

export const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
const localDateId = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
export function normalizeCrossMonth(raw: Shift[]): Shift[] {
  return [...raw].sort((a, b) => a.date.localeCompare(b.date)).flatMap(shift => {
    const date = new Date(`${shift.date}T12:00:00`)
    const previous = new Date(date); previous.setDate(date.getDate() - 1)
    const next = new Date(date); next.setDate(date.getDate() + 1)
    const prevKey = localDateId(previous)
    const nextKey = localDateId(next)
    const isFirst = date.getDate() === 1
    const isLast = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() === date.getDate()
    const prev = raw.find(item => item.date === prevKey && item.code === '16' && item.hours === 16)
    const following = raw.find(item => item.date === nextKey && item.code === '8')
    if (isFirst && /^8$/i.test(shift.code) && prev && prev.hours === 16 && /^16$/i.test(prev.code) && prev.date.slice(8) === String(new Date(previous.getFullYear(), previous.getMonth()+1, 0).getDate()).padStart(2, '0')) return []
    return [isLast && shift.hours === 16 && /^16$/i.test(shift.code) && following && /^8$/i.test(following.code) ? { ...shift, hours: 24, code: '24' } : shift]
  })
}
export function timeLabel(shift: Shift) {
  // Shifts are expressed in local wall-clock time (08:00 to 08:00), not in a
  // fixed number of milliseconds. Calendar arithmetic keeps the label correct
  // on daylight-saving transitions.
  const d = new Date(`${shift.date}T12:00:00`)
  const end = new Date(`${shift.date}T12:00:00`)
  end.setDate(end.getDate() + Math.floor((8 + shift.hours) / 24))
  const endHour = (8 + shift.hours) % 24
  const day = (v: Date) => `${v.getDate()} ${MONTHS[v.getMonth()]}`
  return d.getDate() === end.getDate() ? `08:00–${String(endHour).padStart(2, '0')}:00` : `с 08:00 ${day(d)} до ${String(endHour).padStart(2, '0')}:00 ${day(end)}`
}
export const humanMonth = (id: string) => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(new Date(`${id}-01T12:00:00`))
