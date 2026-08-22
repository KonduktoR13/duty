import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { Candidate, DayMark, LeaveCode, ParsedSchedule, Shift } from './types'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

type Glyph = { text: string; x: number; y: number; width: number }
type TableRow = { glyphs: Glyph[]; y: number }
type DayCell = { text: string; center: number }

const monthWords: [number, string[]][] = [
  [1, ['jaanuar', 'january', 'январ']], [2, ['veebruar', 'february', 'феврал']],
  [3, ['märts', 'march', 'март']], [4, ['aprill', 'april', 'апрел']],
  [5, ['mai', 'may', 'май']], [6, ['juuni', 'june', 'июн']], [7, ['juuli', 'july', 'июл']],
  [8, ['august', 'август']], [9, ['september', 'сентябр']], [10, ['oktoober', 'october', 'октябр']],
  [11, ['november', 'ноябр']], [12, ['detsember', 'december', 'декабр']],
]

export function detectMonth(text: string): string | null {
  const lower = text.toLowerCase()
  const year = lower.match(/20\d{2}/)?.[0]
  const month = monthWords.find(([, words]) => words.some(word => lower.includes(word)))?.[0]
  return year && month ? `${year}-${String(month).padStart(2, '0')}` : null
}

function makeRows(glyphs: Glyph[]): TableRow[] {
  const grouped: Glyph[][] = []
  for (const glyph of [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = grouped.at(-1)
    const average = row ? row.reduce((sum, item) => sum + item.y, 0) / row.length : 0
    if (!row || Math.abs(average - glyph.y) >= 2.5) grouped.push([glyph])
    else row.push(glyph)
  }
  return grouped.map(row => ({ glyphs: row, y: row.reduce((sum, glyph) => sum + glyph.y, 0) / row.length }))
}

function rowCells(row: TableRow, cells: DayCell[]): string[] {
  return cells.map((cell, index) => {
    const left = index
      ? (cells[index - 1].center + cell.center) / 2
      : cell.center - (cells[1].center - cell.center) / 2
    const right = index === cells.length - 1
      ? cell.center + (cell.center - cells[index - 1].center) / 2
      : (cell.center + cells[index + 1].center) / 2
    return row.glyphs
      .filter(glyph => glyph.x + glyph.width / 2 >= left && glyph.x + glyph.width / 2 < right)
      .sort((a, b) => a.x - b.x)
      .map(glyph => glyph.text)
      .join('')
      .replace(/^D\d+/, '')
      .trim() || '.'
  })
}

function rowNumber(row: TableRow, cells: DayCell[]): string | null {
  const leftEdge = cells[0].center - (cells[1].center - cells[0].center) / 2
  const label = row.glyphs
    .filter(glyph => glyph.x + glyph.width / 2 < leftEdge)
    .sort((a, b) => a.x - b.x)
    .map(glyph => glyph.text)
    .join('')
    .replace(/\s/g, '')
  const match = label.match(/^D(\d+)$/i)
  return match ? `D${match[1]}` : null
}

function nonEmpty(value: string) {
  const compact = value.replace(/\s/g, '')
  return compact !== '' && compact !== '.'
}

function parseCell(date: string, value: string): DayMark[] {
  const raw = value.replace(/\s/g, '')
  if (!nonEmpty(raw)) return []
  const leave = /^P$/i.test(raw) ? 'P' : /^LHPu$/i.test(raw) ? 'LHPu' : null
  if (leave) return [{ date, kind: 'leave', raw: leave }]

  // A cell can contain both a normal day entry and a V-entry on its second
  // printed line, e.g. 12 + V4 or 8P + V8. Treat # and every unknown code as
  // an explicit annotation rather than silently inventing working hours.
  const taggedHoursAndHome = raw.match(/^(#\d+)((?:V\d+(?:[,.]\d+)?)+)$/i)
  if (taggedHoursAndHome) return [{ date, kind: 'other', raw: taggedHoursAndHome[1] }, ...parseCell(date, taggedHoursAndHome[2])]
  const knownWork = /^(?:\d+P?|V\d+(?:[,.]\d+)?)+$/i
  if (!knownWork.test(raw)) {
    const otherAndHome = raw.match(/^(.+?)((?:V\d+(?:[,.]\d+)?)+)$/i)
    if (otherAndHome) return [{ date, kind: 'other', raw: otherAndHome[1] }, ...parseCell(date, otherAndHome[2])]
    return [{ date, kind: 'other', raw }]
  }
  const parts = raw.match(/V\d+(?:[,.]\d+)?|\d+P?/gi) || []
  const marks: DayMark[] = []
  for (const part of parts) {
    const home = part.match(/^V(\d+(?:[,.]\d+)?)$/i)
    if (home) {
      const hours = Number(home[1].replace(',', '.'))
      if (hours > 0 && hours <= 48) marks.push({ date, kind: 'home', raw: `V${home[1]}`, hours })
      else marks.push({ date, kind: 'other', raw: part })
      continue
    }
    const day = part.match(/^(\d+)(P)?$/i)
    const hours = Number(day?.[1])
    if (day && hours > 0 && hours <= 48) marks.push({ date, kind: 'hours', raw: day[0], hours })
    else marks.push({ date, kind: 'other', raw: part })
  }
  return marks
}

function supportRowsFor(base: TableRow, next: TableRow | undefined, rows: TableRow[], numbered: Set<TableRow>, cells: DayCell[], flow: -1 | 1) {
  // A support line belongs to the preceding labelled D-row in visual order.
  // In April, for example, the V8,2 line and its trailing 5 live between D14
  // and D11. Looking only at a fixed distance would incorrectly attach them
  // to D13, so the next labelled row is a hard block boundary.
  const layers = rows
    .filter(row => !numbered.has(row) && flow * (row.y - base.y) > 2 && (!next || flow * (row.y - next.y) < 0) && (next || Math.abs(row.y - base.y) <= 33))
    .map(row => ({ row, values: rowCells(row, cells) }))
    .sort((a, b) => flow * (a.row.y - b.row.y))
  const accepted: typeof layers = []
  for (const layer of layers) {
    const hasHome = layer.values.some(value => /^V\d/i.test(value.replace(/\s/g, '')))
    const followsHome = accepted.length > 0 && layer.values.some((value, index) => {
      const previous = accepted.at(-1)!.values[index].replace(/\s/g, '')
      return /^\d+$/.test(value.replace(/\s/g, '')) && /^V\d+[,.]\d*$/i.test(previous)
    })
    if (hasHome || followsHome) accepted.push(layer)
  }
  return accepted
}

export function parseGlyphs(glyphs: Glyph[], plainText: string): ParsedSchedule {
  const month = detectMonth(plainText)
  if (!month) throw new Error('Не удалось определить месяц и год в PDF')
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()
  const countOnAxis = (axis: 'x' | 'y') => {
    const groups: Glyph[][] = []
    for (const glyph of [...glyphs].sort((a, b) => a[axis] - b[axis])) {
      const group = groups.at(-1)
      const average = group ? group.reduce((sum, item) => sum + item[axis], 0) / group.length : 0
      if (!group || Math.abs(average - glyph[axis]) > 2.5) groups.push([glyph])
      else group.push(glyph)
    }
    return Math.max(...groups.map(group => group.filter(glyph => /^\d+$/.test(glyph.text.trim()) && Number(glyph.text) >= 1 && Number(glyph.text) <= days).length))
  }

  // Some roster PDFs are physically rotated: day numbers form a vertical
  // column. Rotate their coordinate system before applying the table rule.
  const oriented = countOnAxis('x') > countOnAxis('y')
    ? glyphs.map(glyph => ({ ...glyph, x: glyph.y, y: glyph.x }))
    : glyphs
  const rows = makeRows(oriented)
  const isDay = (glyph: Glyph) => /^\d+$/.test(glyph.text.trim()) && Number(glyph.text) >= 1 && Number(glyph.text) <= days
  const header = [...rows].sort((a, b) => b.glyphs.filter(isDay).length - a.glyphs.filter(isDay).length)[0]
  const dayCells = header.glyphs
    .filter(isDay)
    .filter((glyph, index, all) => all.findIndex(item => item.text.trim() === glyph.text.trim()) === index)
    .map(glyph => ({ text: glyph.text.trim(), center: glyph.x + glyph.width / 2 }))
    .sort((a, b) => Number(a.text) - Number(b.text))
  if (dayCells.length !== days) throw new Error(`Найдены не все дни месяца: ${dayCells.length} из ${days}`)

  const numberedRows = rows
    .map(row => ({ row, number: rowNumber(row, dayCells) }))
    .filter((item): item is { row: TableRow; number: string } => Boolean(item.number))
  const numbered = new Set(numberedRows.map(item => item.row))
  const averageDataY = numberedRows.reduce((sum, item) => sum + item.row.y, 0) / numberedRows.length
  const flow: -1 | 1 = averageDataY < header.y ? -1 : 1
  const visualRows = [...numberedRows].sort((a, b) => flow * (a.row.y - b.row.y))
  const candidates: Candidate[] = visualRows.map(({ row, number }, index) => {
    const next = visualRows[index + 1]?.row
    const layers = [rowCells(row, dayCells), ...supportRowsFor(row, next, rows, numbered, dayCells, flow).map(layer => layer.values)]
    const values = Array.from({ length: days }, (_, index) => layers.map(layer => layer[index]).filter(nonEmpty).join('') || '.')
    const marks = values.flatMap((value, index) => parseCell(`${month}-${String(index + 1).padStart(2, '0')}`, value))
    const shifts: Shift[] = marks
      .filter((mark): mark is Extract<DayMark, { kind: 'hours' | 'home' }> => mark.kind === 'hours' || mark.kind === 'home')
      .map(mark => ({ date: mark.date, hours: mark.hours, code: mark.raw }))
    const leaveMarks = marks.filter((mark): mark is Extract<DayMark, { kind: 'leave' }> => mark.kind === 'leave')
    const leaveCodes: Record<string, LeaveCode> = Object.fromEntries(leaveMarks.map(mark => [mark.date, mark.raw]))
    return {
      number,
      values,
      marks,
      shifts,
      leaveDates: leaveMarks.map(mark => mark.date),
      leaveCodes,
      confidence: marks.length ? 'high' : 'review',
    }
  })
  if (!candidates.length) throw new Error('В таблице не найдены Delta/D-номера')
  return { month, candidates, warnings: candidates.some(candidate => candidate.confidence === 'review') ? ['Некоторые строки требуют проверки: в них нет распознанных отметок.'] : [] }
}

export async function parsePdf(file: File): Promise<ParsedSchedule> {
  const data = new Uint8Array(await file.arrayBuffer())
  const document = await pdfjs.getDocument({ data }).promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  const glyphs: Glyph[] = content.items
    .filter((item): item is typeof item & { str: string; transform: number[]; width: number } => 'str' in item)
    .map(item => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width }))
  const text = (await Promise.all(Array.from({ length: document.numPages }, async (_, index) => {
    const pageText = await (await document.getPage(index + 1)).getTextContent()
    return pageText.items.map(item => 'str' in item ? item.str : '').join(' ')
  }))).join(' ')
  return parseGlyphs(glyphs, text)
}
