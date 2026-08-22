import { describe, expect, it } from 'vitest'
import { normalizeCrossMonth, timeLabel } from '../src/schedule'
import { detectMonth, parseGlyphs } from '../src/parser'

describe('schedule rules', () => {
  it('joins final-day 16 and next plain 8 into one 24-hour shift', () => {
    expect(normalizeCrossMonth([
      { date: '2026-09-30', hours: 16, code: '16' },
      { date: '2026-10-01', hours: 8, code: '8' },
    ])).toEqual([{ date: '2026-09-30', hours: 24, code: '24' }])
  })

  it('keeps a standalone first-day 8 as an ordinary shift', () => {
    expect(normalizeCrossMonth([{ date: '2026-10-01', hours: 8, code: '8' }]))
      .toEqual([{ date: '2026-10-01', hours: 8, code: '8' }])
  })

  it('keeps 16 when the following code is 8P or V8', () => {
    expect(normalizeCrossMonth([
      { date: '2026-09-30', hours: 16, code: '16' },
      { date: '2026-10-01', hours: 8, code: '8P' },
    ])).toEqual([
      { date: '2026-09-30', hours: 16, code: '16' },
      { date: '2026-10-01', hours: 8, code: '8P' },
    ])
    expect(normalizeCrossMonth([
      { date: '2026-09-30', hours: 16, code: '16' },
      { date: '2026-10-01', hours: 8, code: 'V8' },
    ])).toEqual([
      { date: '2026-09-30', hours: 16, code: '16' },
      { date: '2026-10-01', hours: 8, code: 'V8' },
    ])
  })

  it('keeps an unpaired final 16', () => {
    expect(normalizeCrossMonth([{ date: '2026-09-30', hours: 16, code: '16' }]))
      .toEqual([{ date: '2026-09-30', hours: 16, code: '16' }])
  })

  it('formats a 24-hour shift across midnight', () => {
    expect(timeLabel({ date: '2026-08-21', hours: 24, code: '24' }))
      .toBe('с 08:00 21 августа до 08:00 22 августа')
  })
})

describe('PDF parsing primitives', () => {
  it('detects Estonian and Russian months', () => {
    expect(detectMonth('Juuni 2026')).toBe('2026-06')
    expect(detectMonth('сентябрь 2027')).toBe('2027-09')
  })

  it('reads a row by coordinate cells', () => {
    const glyphs: any[] = []
    for (let day = 1; day <= 28; day++) glyphs.push({ text: String(day), x: 50 + day * 10, y: 10, width: 6 })
    glyphs.push(...[
      { text: 'D', x: 0, y: 30, width: 5 }, { text: '1', x: 5, y: 30, width: 5 }, { text: '2', x: 10, y: 30, width: 5 },
      { text: '2', x: 80, y: 30, width: 5 }, { text: '4', x: 85, y: 30, width: 5 }, { text: 'P', x: 90, y: 30, width: 5 },
    ])
    const parsed = parseGlyphs(glyphs, 'Veebruar 2026')
    expect(parsed.candidates[0].number).toBe('D12')
    expect(parsed.candidates[0].shifts).toContainEqual({ date: '2026-02-03', hours: 24, code: '24' })
    expect(parsed.candidates[0].leaveDates).toContain('2026-02-04')
  })

  it('keeps a V support layer and its decimal continuation with the same D row', () => {
    const base: Array<{ text: string; x: number; y: number; width: number }> = []
    for (let day = 1; day <= 30; day++) base.push({ text: String(day), x: 50 + day * 20, y: 0, width: 6 })
    base.push(...[
      { text: 'D12', x: 0, y: 30, width: 16 },
      { text: '12', x: 70, y: 30, width: 11 }, { text: '8', x: 90, y: 30, width: 6 }, { text: 'TK4', x: 110, y: 30, width: 16 },
      { text: 'V4', x: 70, y: 40, width: 10 }, { text: 'V8,2', x: 90, y: 40, width: 18 }, { text: 'V8', x: 110, y: 40, width: 10 },
      { text: '5', x: 90, y: 50, width: 6 },
      { text: 'D13', x: 0, y: 60, width: 16 },
    ])
    const transpose = (glyphs: typeof base) => glyphs.map(glyph => ({ ...glyph, x: glyph.y, y: glyph.x }))
    const expected = [
      { date: '2026-04-01', kind: 'hours', raw: '12', hours: 12 },
      { date: '2026-04-01', kind: 'home', raw: 'V4', hours: 4 },
      { date: '2026-04-02', kind: 'hours', raw: '8', hours: 8 },
      { date: '2026-04-02', kind: 'home', raw: 'V8,25', hours: 8.25 },
      { date: '2026-04-03', kind: 'other', raw: 'TK4' },
      { date: '2026-04-03', kind: 'home', raw: 'V8', hours: 8 },
    ]
    for (const glyphs of [base, transpose(base)]) {
      const parsed = parseGlyphs(glyphs, 'Aprill 2026')
      const d12 = parsed.candidates.find(candidate => candidate.number === 'D12')!
      const d13 = parsed.candidates.find(candidate => candidate.number === 'D13')!
      expect(d12.marks).toEqual(expected)
      expect(d13.marks).toEqual([])
    }
  })
})
