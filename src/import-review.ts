import type { Candidate, MonthRecord } from './types'
import { candidateForMonth } from './roster'
import { esc } from './ui'
export function importReview(candidate: Candidate, previous?: MonthRecord) {
  const before = previous ? candidateForMonth(previous, candidate.number)?.marks || [] : []
  const display = (marks: typeof before, day: string) =>
    marks
      .filter((mark) => mark.date === day)
      .map((mark) => mark.raw)
      .sort()
      .join(' + ') || '—'
  const days = [...new Set([...before, ...candidate.marks].map((mark) => mark.date))].sort()
  const changed = days.filter((day) => display(before, day) !== display(candidate.marks, day))
  const unknown = candidate.marks.filter((mark) => mark.kind === 'other')
  const hours = candidate.marks.reduce(
    (sum, mark) => sum + (mark.kind === 'hours' ? mark.hours : 0),
    0,
  )
  return (
    `<p><b>${esc(candidate.number)}</b> · ${hours} ч по PDF${previous ? ` · изменено дней: ${changed.length}` : ''}</p>` +
    (unknown.length
      ? `<aside class="sync-warning"><b>Проверьте неизвестные отметки: ${unknown.length}</b><span>${unknown.map((mark) => `${mark.date.slice(8)}: ${esc(mark.raw)}`).join(' · ')}</span></aside>`
      : '') +
    (previous
      ? `<ul class="import-diff">${changed.map((day) => `<li><b>${day.slice(8)}</b><span>${esc(display(before, day))} → ${esc(display(candidate.marks, day))}</span></li>`).join('')}</ul><p>Предыдущую версию можно будет вернуть в разделе «Графики». События Google изменятся только после синхронизации.</p>`
      : '<p>Проверьте свой D-номер и часы. Коды PDF сохраняются без изменений.</p>')
  )
}
