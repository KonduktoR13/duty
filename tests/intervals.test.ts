import { describe, it, expect } from 'vitest'
import { nextWork, workIntervals } from '../src/intervals'
import type { DayMark } from '../src/types'
describe('current and upcoming work in Tallinn', () => {
  const marks: DayMark[] = [
    { date: '2026-09-07', kind: 'hours', raw: '24', hours: 24 },
    { date: '2026-09-10', kind: 'hours', raw: '8P', hours: 8 },
  ]
  it('keeps yesterday’s overnight shift until its end', () => {
    expect(nextWork(marks, new Date('2026-09-08T01:00:00Z'))).toMatchObject({
      active: true,
      intervals: [{ date: '2026-09-07' }],
    })
    expect(nextWork(marks, new Date('2026-09-08T05:00:00Z'))).toMatchObject({
      active: false,
      intervals: [{ date: '2026-09-10' }],
    })
  })
  it('does not show a completed daytime shift as upcoming', () => {
    expect(nextWork(marks, new Date('2026-09-10T15:00:00Z'))).toBeUndefined()
  })
  it('preserves fractional home-duty minutes and local end times across DST', () => {
    const result = workIntervals([
      { date: '2026-10-24', kind: 'hours', raw: '24', hours: 24 },
      { date: '2026-10-25', kind: 'home', raw: 'V8,25', hours: 8.25 },
    ])
    expect(result[0].end.dateTime).toBe('2026-10-25T08:00:00')
    expect(result[1].end.dateTime).toBe('2026-10-25T08:15:00')
  })
})
