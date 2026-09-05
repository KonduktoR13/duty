import { isWorkMark, type WorkMark } from './roster'
import type { DayMark } from './types'

export const WORK_TIME_ZONE = 'Europe/Tallinn'
export type WorkInterval = {
  key: string
  date: string
  kind: 'hours' | 'home'
  raw: string
  hours: number
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  incomplete: boolean
}
export function isIncompleteBoundary(mark: Pick<DayMark, 'date' | 'kind' | 'raw'>) {
  const date = new Date(`${mark.date}T12:00:00`)
  return (
    mark.kind === 'hours' &&
    mark.raw === '16' &&
    date.getDate() === new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  )
}

export function workIntervals(marks: DayMark[]): WorkInterval[] {
  const grouped = new Map<string, WorkMark[]>()
  for (const mark of marks.filter(isWorkMark))
    grouped.set(mark.date, [...(grouped.get(mark.date) || []), mark])
  const result: WorkInterval[] = []
  for (const [date, day] of grouped) {
    const counts = new Map<string, number>()
    for (const mark of day.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.raw.localeCompare(b.raw),
    )) {
      const index = (counts.get(mark.kind) || 0) + 1
      counts.set(mark.kind, index)
      const hour =
        mark.kind === 'home'
          ? day.some((item) => item.kind === 'hours' && item.hours === 12) && mark.hours <= 4
            ? 20
            : 0
          : 8
      const start = `${date}T${String(hour).padStart(2, '0')}:00:00`
      const end = new Date(`${start}Z`)
      end.setUTCMinutes(end.getUTCMinutes() + Math.round(mark.hours * 60))
      result.push({
        key: `${date}:${mark.kind}:${index}`,
        date,
        kind: mark.kind,
        raw: mark.raw,
        hours: mark.hours,
        start: { dateTime: start, timeZone: WORK_TIME_ZONE },
        end: { dateTime: end.toISOString().slice(0, 19), timeZone: WORK_TIME_ZONE },
        incomplete: isIncompleteBoundary(mark),
      })
    }
  }
  return result.sort(
    (a, b) => a.start.dateTime.localeCompare(b.start.dateTime) || a.key.localeCompare(b.key),
  )
}

export function tallinnWallTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (key: string) => parts.find((p) => p.type === key)!.value
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
}

export function nextWork(marks: DayMark[], now = new Date()) {
  const time = tallinnWallTime(now)
  const intervals = workIntervals(marks).filter((item) => item.end.dateTime > time)
  const active = intervals.filter((item) => item.start.dateTime <= time)
  return active.length
    ? { active: true, intervals: active }
    : intervals[0]
      ? {
          active: false,
          intervals: intervals.filter(
            (item) => item.start.dateTime === intervals[0].start.dateTime,
          ),
        }
      : undefined
}

export function intervalTime(item: WorkInterval) {
  return `${item.start.dateTime.slice(11, 16)}–${item.end.dateTime.slice(11, 16)}${item.date !== item.end.dateTime.slice(0, 10) ? ' следующего дня' : ''}`
}
