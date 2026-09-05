import type { MonthRecord } from './types'
import { candidateForMonth } from './roster'
import { humanMonth } from './schedule'
import { esc, icon } from './ui'

export function documentsView(months: MonthRecord[], delta: string, revisions: Set<string>) {
  const rows = months
    .map(
      (month) => `<article>
    <button class="document-open" data-open-pdf="${month.id}" aria-label="Открыть PDF ${esc(month.fileName)}"><span class="doc-icon">${icon('documents')}</span><span><b>${humanMonth(month.id)}</b><span>${esc(month.fileName)}</span><small>${candidateForMonth(month, delta)?.shifts.length || 0} рабочих отметок · ${esc(delta)}<br>Загружен ${new Date(month.importedAt).toLocaleDateString('ru-RU')}</small></span></button>
    <button class="delete-month" data-delete-month="${month.id}" aria-label="Удалить ${humanMonth(month.id)}">×</button>
    ${revisions.has(month.id) ? `<button class="document-revision" data-restore-month="${month.id}">Вернуть предыдущую версию</button>` : ''}
  </article>`,
    )
    .join('')
  return `<section class="documents-intro"><p>Оригинальные PDF доступны без интернета. Нажмите график, чтобы открыть источник.</p><button class="primary" id="import">Импортировать PDF</button></section><h2 class="list-title">Загруженные графики</h2><section class="documents">${rows || '<p>Графики ещё не импортированы.</p>'}</section><p class="documents-hint">При замене графика можно проверить изменения и вернуть предыдущую версию.</p><button class="calendar-button" id="export-backup">Сохранить резервную копию</button><button class="calendar-button" id="import-backup">Восстановить из копии</button>`
}
