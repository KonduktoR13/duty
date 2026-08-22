import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { Candidate, LeaveCode, ParsedSchedule, Shift } from './types'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
type Glyph = { text: string; x: number; y: number; width: number }
const monthWords: [number, string[]][] = [[1,['jaanuar','january','январ']],[2,['veebruar','february','феврал']],[3,['märts','march','март']],[4,['aprill','april','апрел']],[5,['mai','may','май']],[6,['juuni','june','июн']],[7,['juuli','july','июл']],[8,['august','август']],[9,['september','сентябр']],[10,['oktoober','october','октябр']],[11,['november','ноябр']],[12,['detsember','december','декабр']]]
export function detectMonth(text: string): string | null {
  const lower = text.toLowerCase(); const year = lower.match(/20\d{2}/)?.[0]; const month = monthWords.find(([, words]) => words.some(w => lower.includes(w)))?.[0]
  return year && month ? `${year}-${String(month).padStart(2, '0')}` : null
}
function lines(glyphs: Glyph[]) { const rows: Glyph[][] = []; for (const g of [...glyphs].sort((a,b) => a.y-b.y || a.x-b.x)) { const r = rows.at(-1); if (!r || Math.abs(r.reduce((n,v)=>n+v.y,0)/r.length-g.y) >= 2.5) rows.push([g]); else r.push(g) } return rows }
function tokens(row: Glyph[]) { const sorted = [...row].sort((a,b)=>a.x-b.x); const result: Glyph[][] = []; for (const glyph of sorted) { const cur = result.at(-1); const prev = cur?.at(-1); if (!cur || !prev || glyph.x - (prev.x + prev.width) > Math.max(2.2, prev.width*.55)) result.push([glyph]); else cur.push(glyph) } return result.map(group => ({ text: group.map(x=>x.text).join('').trim(), center: group.reduce((n,x)=>n+x.x+x.width/2,0)/group.length })) }
export function parseGlyphs(glyphs: Glyph[], plainText: string): ParsedSchedule {
  const month = detectMonth(plainText); if (!month) throw new Error('Не удалось определить месяц и год в PDF')
  const days = new Date(Number(month.slice(0,4)), Number(month.slice(5)), 0).getDate()
  const countOnAxis = (axis: 'x'|'y') => { const groups: Glyph[][]=[]; for(const g of [...glyphs].sort((a,b)=>a[axis]-b[axis])){const row=groups.at(-1);if(!row||Math.abs(row.reduce((n,v)=>n+v[axis],0)/row.length-g[axis])>2.5)groups.push([g]);else row.push(g)} return Math.max(...groups.map(row=>row.filter(g=>/^\d+$/.test(g.text.trim())&&Number(g.text)>=1&&Number(g.text)<=days).length)) }
  // Some roster PDFs are physically rotated: day numbers form a vertical
  // column. Rotate their coordinate system before applying the same table rule.
  const oriented = countOnAxis('x') > countOnAxis('y') ? glyphs.map(g=>({...g,x:g.y,y:g.x})) : glyphs
  const rows = lines(oriented)
  // PDF.js emits the visually blank spaces as wide text items. Joining those
  // items into tokens merges the whole day header ("1 2 … 31") into one token.
  // Day numbers themselves are separate positioned text items, so use them
  // directly and preserve their centres for the row-cell boundaries.
  const isDay = (g: Glyph) => /^\d+$/.test(g.text.trim()) && Number(g.text) >= 1 && Number(g.text) <= days
  const header = [...rows].sort((a,b) => b.filter(isDay).length - a.filter(isDay).length)[0]
  const dayCells = header.filter(isDay).filter((x,i,a)=>a.findIndex(v=>v.text.trim()===x.text.trim())===i).map(x=>({text:x.text.trim(),center:x.x+x.width/2})).sort((a,b)=>Number(a.text)-Number(b.text))
  if (dayCells.length !== days) throw new Error(`Найдены не все дни месяца: ${dayCells.length} из ${days}`)
  const candidates: Candidate[] = []
  for (const row of rows) { const leftEdge = dayCells[0].center - (dayCells[1].center-dayCells[0].center)/2; const label = row.filter(g=>g.x+g.width/2 < leftEdge).sort((a,b)=>a.x-b.x).map(x=>x.text).join('').replace(/\s/g,''); const match = label.match(/^D(\d+)$/i); if (!match) continue
    const values = dayCells.map((cell, i) => { const l=i? (dayCells[i-1].center+cell.center)/2 : cell.center-(dayCells[1].center-cell.center)/2; const r=i===days-1?cell.center+(cell.center-dayCells[i-1].center)/2:(cell.center+dayCells[i+1].center)/2; return row.filter(g=>g.x+g.width/2>=l&&g.x+g.width/2<r).sort((a,b)=>a.x-b.x).map(g=>g.text).join('').replace(/^D\d+/, '').trim() || '.' })
    const shifts: Shift[] = values.flatMap((raw,index) => { const code=raw.replace(/\s/g,'').replace(/^#/,''); const m=code.match(/^(\d+)(P)?$/i); return m && +m[1]>=1 && +m[1]<=48 ? [{date:`${month}-${String(index+1).padStart(2,'0')}`,hours:+m[1],code}] : [] })
    const leaveCodes: Record<string, LeaveCode> = {}
    values.forEach((raw, index) => {
      const value = raw.replace(/\s/g, '')
      const code = /^P$/i.test(value) ? 'P' : /^LHPu$/i.test(value) ? 'LHPu' : null
      if (code) leaveCodes[`${month}-${String(index + 1).padStart(2, '0')}`] = code
    })
    const leaveDates = Object.keys(leaveCodes)
    candidates.push({ number: `D${match[1]}`, values, shifts, leaveDates, leaveCodes, confidence: shifts.length || leaveDates.length ? 'high' : 'review' })
  }
  if (!candidates.length) throw new Error('В таблице не найдены Delta/D-номера')
  return { month, candidates, warnings: candidates.some(x=>x.confidence==='review') ? ['Некоторые строки требуют проверки: в них нет распознанных смен.'] : [] }
}
export async function parsePdf(file: File): Promise<ParsedSchedule> { const data = new Uint8Array(await file.arrayBuffer()); const doc = await pdfjs.getDocument({ data }).promise; const page = await doc.getPage(1); const content = await page.getTextContent(); const glyphs: Glyph[] = content.items.filter((x): x is typeof x & { str:string; transform:number[]; width:number } => 'str' in x).map(x=>({text:x.str,x:x.transform[4],y:x.transform[5],width:x.width})); const text = (await Promise.all(Array.from({length:doc.numPages},async(_,i)=>(await (await doc.getPage(i+1)).getTextContent()).items.map(x=>'str'in x?x.str:'').join(' ')))).join(' '); return parseGlyphs(glyphs,text) }
