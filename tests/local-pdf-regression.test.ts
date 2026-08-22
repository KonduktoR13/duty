// This regression test deliberately reads the reference PDF outside the PWA
// directory, so personal schedules are never committed or served by the app.
// It runs locally when the Android reference project is present and is skipped
// in a clean CI checkout.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parseGlyphs } from '../src/parser'

const source = new URL('../../August 2026_kinnitamata.pdf', import.meta.url)
const local = existsSync(source)

describe.skipIf(!local)('August 2026 reference PDF', () => {
  it('finds D12 and its audited shifts', async () => {
    const data = new Uint8Array(await readFile(source))
    const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise
    const page = await doc.getPage(1); const content = await page.getTextContent()
    const glyphs = content.items.filter((x): x is typeof x & { str: string; transform: number[]; width: number } => 'str' in x)
      .map(x => ({ text: x.str, x: x.transform[4], y: x.transform[5], width: x.width }))
    const parsed = parseGlyphs(glyphs, (await page.getTextContent()).items.map(x => 'str' in x ? x.str : '').join(' '))
    const d12 = parsed.candidates.find(x => x.number === 'D12')!
    expect(d12.shifts.map(x => x.date)).toEqual(['2026-08-03','2026-08-07','2026-08-09','2026-08-12','2026-08-17','2026-08-21','2026-08-26','2026-08-30'])
    expect(d12.shifts.every(x => x.code === '24')).toBe(true)
  })

  it('also reads the rotated July table', async () => {
    const july = new URL('../../Juuli 2026_kinnitamata.pdf', import.meta.url)
    const data = new Uint8Array(await readFile(july)); const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise
    const page = await doc.getPage(1); const content = await page.getTextContent()
    const glyphs = content.items.filter((x): x is typeof x & { str: string; transform: number[]; width: number } => 'str' in x).map(x => ({ text: x.str, x: x.transform[4], y: x.transform[5], width: x.width }))
    const parsed = parseGlyphs(glyphs, content.items.map(x => 'str' in x ? x.str : '').join(' ')); const d12 = parsed.candidates.find(x => x.number === 'D12')!
    expect(d12.shifts.map(x => x.date)).toEqual(['2026-07-17','2026-07-21','2026-07-23','2026-07-27','2026-07-28','2026-07-29','2026-07-30','2026-07-31'])
  })

  it('keeps D13 LHPu as parental-care leave, not a shift', async () => {
    const data = new Uint8Array(await readFile(source)); const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise
    const page = await doc.getPage(1); const content = await page.getTextContent()
    const glyphs = content.items.filter((x): x is typeof x & { str: string; transform: number[]; width: number } => 'str' in x).map(x => ({ text: x.str, x: x.transform[4], y: x.transform[5], width: x.width }))
    const parsed = parseGlyphs(glyphs, content.items.map(x => 'str' in x ? x.str : '').join(' ')); const d13 = parsed.candidates.find(x => x.number === 'D13')!
    expect(d13.shifts).toEqual([]); expect(d13.leaveDates).toHaveLength(31); expect(d13.leaveCodes['2026-08-01']).toBe('LHPu')
  })
})
