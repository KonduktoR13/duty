// These regression tests deliberately read the reference PDFs outside the PWA
// directory, so personal schedules are never committed or served by the app.
// They run locally when the Android reference project is present and are
// skipped in a clean CI checkout.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parseGlyphs } from '../src/parser'
import { normalizeCrossMonth } from '../src/schedule'

const pdf = (name: string) => new URL(`../../${name}`, import.meta.url)
const april = pdf('Aprill 2026_kinnitatud.pdf')
const june = pdf('Juuni 2026_kinnitamata.pdf')
const july = pdf('Juuli 2026_kinnitamata.pdf')
const august = pdf('August 2026_kinnitamata.pdf')
const september = pdf('September 2026_kinnitamata.pdf')
const local = [april, june, july, august, september].every(existsSync)

async function parseSource(source: URL) {
  const data = new Uint8Array(await readFile(source))
  const document = await pdfjs.getDocument({ data, disableWorker: true }).promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  const glyphs = content.items
    .filter((item): item is typeof item & { str: string; transform: number[]; width: number } => 'str' in item)
    .map(item => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width }))
  return parseGlyphs(glyphs, content.items.map(item => 'str' in item ? item.str : '').join(' '))
}

describe.skipIf(!local)('reference Delta PDFs', () => {
  it('finds D12 and its audited August shifts', async () => {
    const parsed = await parseSource(august)
    const d12 = parsed.candidates.find(candidate => candidate.number === 'D12')!
    expect(d12.shifts.map(shift => shift.date)).toEqual(['2026-08-03', '2026-08-07', '2026-08-09', '2026-08-12', '2026-08-17', '2026-08-21', '2026-08-26', '2026-08-30'])
    expect(d12.shifts.every(shift => shift.code === '24')).toBe(true)
  })

  it('also reads the rotated July table', async () => {
    const parsed = await parseSource(july)
    const d12 = parsed.candidates.find(candidate => candidate.number === 'D12')!
    expect(d12.shifts.map(shift => shift.date)).toEqual(['2026-07-17', '2026-07-21', '2026-07-23', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'])
  })

  it('keeps D13 LHPu as parental-care leave, not a shift', async () => {
    const parsed = await parseSource(august)
    const d13 = parsed.candidates.find(candidate => candidate.number === 'D13')!
    expect(d13.shifts).toEqual([])
    expect(d13.leaveDates).toHaveLength(31)
    expect(d13.leaveCodes['2026-08-01']).toBe('LHPu')
  })

  it('does not leak April V support rows into the adjacent D13 row', async () => {
    const parsed = await parseSource(april)
    const d13 = parsed.candidates.find(candidate => candidate.number === 'D13')!
    expect(d13.marks).toHaveLength(30)
    expect(d13.marks.every(mark => mark.kind === 'leave' && mark.raw === 'LHPu')).toBe(true)
  })

  it('keeps V entries as a second layer in the same calendar day', async () => {
    const parsed = await parseSource(april)
    const d40 = parsed.candidates.find(candidate => candidate.number === 'D40')!
    expect(d40.marks.filter(mark => mark.date === '2026-04-16')).toEqual([
      { date: '2026-04-16', kind: 'hours', raw: '12', hours: 12 },
      { date: '2026-04-16', kind: 'home', raw: 'V4', hours: 4 },
    ])
    expect(d40.marks.filter(mark => mark.date === '2026-04-17')).toEqual([
      { date: '2026-04-17', kind: 'hours', raw: '8', hours: 8 },
      { date: '2026-04-17', kind: 'home', raw: 'V8', hours: 8 },
    ])
    const d14 = parsed.candidates.find(candidate => candidate.number === 'D14')!
    expect(d14.marks.filter(mark => mark.date === '2026-04-07')).toEqual([
      { date: '2026-04-07', kind: 'hours', raw: '8', hours: 8 },
      { date: '2026-04-07', kind: 'home', raw: 'V8,25', hours: 8.25 },
    ])
    const d12 = parsed.candidates.find(candidate => candidate.number === 'D12')!
    expect(d12.marks.filter(mark => mark.date === '2026-04-06')).toEqual([
      { date: '2026-04-06', kind: 'hours', raw: '8P', hours: 8 },
      { date: '2026-04-06', kind: 'home', raw: 'V8', hours: 8 },
    ])
  })

  it('preserves rare PDF annotations without treating them as hours', async () => {
    const [aprilSchedule, juneSchedule, augustSchedule] = await Promise.all([parseSource(april), parseSource(june), parseSource(august)])
    const d16 = aprilSchedule.candidates.find(candidate => candidate.number === 'D16')!
    expect(d16.marks).toContainEqual({ date: '2026-04-13', kind: 'other', raw: '#12' })
    expect(d16.marks).toContainEqual({ date: '2026-04-13', kind: 'home', raw: 'V5', hours: 5 })
    const d36 = aprilSchedule.candidates.find(candidate => candidate.number === 'D36')!
    expect(d36.marks).toContainEqual({ date: '2026-04-09', kind: 'other', raw: 'Õ' })
    expect(juneSchedule.candidates.find(candidate => candidate.number === 'D11')!.marks).toContainEqual({ date: '2026-06-01', kind: 'other', raw: 'TK4' })
    expect(augustSchedule.candidates.find(candidate => candidate.number === 'D34')!.marks.some(mark => mark.kind === 'other' && mark.raw === 'P-et')).toBe(true)
  })

  it('keeps D40 ordinary eights as ordinary work codes', async () => {
    const parsed = await parseSource(august)
    const d40 = parsed.candidates.find(candidate => candidate.number === 'D40')!
    expect(d40.marks.filter(mark => mark.kind === 'hours' && mark.raw === '8')).toHaveLength(20)
    expect(d40.marks.some(mark => mark.kind === 'home')).toBe(false)
  })

  it('normalizes only the actual 16 then plain 8 month boundaries', async () => {
    const [juneSchedule, julySchedule, augustSchedule, septemberSchedule] = await Promise.all([parseSource(june), parseSource(july), parseSource(august), parseSource(september)])
    const d11 = [
      juneSchedule.candidates.find(candidate => candidate.number === 'D11')!.shifts.find(shift => shift.date === '2026-06-30')!,
      julySchedule.candidates.find(candidate => candidate.number === 'D11')!.shifts.find(shift => shift.date === '2026-07-01')!,
    ]
    expect(normalizeCrossMonth(d11)).toEqual([{ date: '2026-06-30', hours: 24, code: '24' }])
    const d34 = [
      julySchedule.candidates.find(candidate => candidate.number === 'D34')!.shifts.find(shift => shift.date === '2026-07-31')!,
      augustSchedule.candidates.find(candidate => candidate.number === 'D34')!.shifts.find(shift => shift.date === '2026-08-01')!,
    ]
    expect(normalizeCrossMonth(d34)).toEqual([{ date: '2026-07-31', hours: 24, code: '24' }])
    const d36 = [
      augustSchedule.candidates.find(candidate => candidate.number === 'D36')!.shifts.find(shift => shift.date === '2026-08-31')!,
      septemberSchedule.candidates.find(candidate => candidate.number === 'D36')!.shifts.find(shift => shift.date === '2026-09-01')!,
    ]
    expect(normalizeCrossMonth(d36)).toEqual(d36)
  })
})
