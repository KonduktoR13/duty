import type { PayrollContext } from './personal'
import { wall } from './personal'
import { cancelled, cancelledLinkedEvent, cancellationMatches, reconcileCancellations, shiftTargets, targetDate } from './shift-cancellations'
import type { MonthRecord } from './types'
import type { CancellationTarget, PersonalEvent } from './personal-types'
import { esc } from './ui'

export function shiftLabel(t: CancellationTarget) {
  return `${t.kind === 'home' ? 'Koduvalve' : 'Смена'} · ${t.raw === '16+8' ? '24' : t.raw} · ${wall(t.start).slice(11, 16)}–${wall(t.end).slice(11, 16)}${targetDate(t) !== wall(t.end).slice(0, 10) ? ' (' + wall(t.end).slice(0, 10) + ')' : ''}`
}
export function cancellationStatus(e: PersonalEvent, targets: CancellationTarget[], months: MonthRecord[] = []) {
  const c = e.cancellation!
  const exists = targets.some(t => cancellationMatches(c.target, t, months, e.owner))
  if (c.state === 'active') return exists ? 'Отменена вами' : 'Источник недоступен · отмена сохранена'
  if (exists) return 'Смена появилась снова · прежняя отмена не применяется'
  return c.state === 'changed' ? 'Смена изменилась · прежняя отмена не применяется' : 'Смены больше нет в источнике · отмена завершена'
}
export function cancellationDayView(c: PayrollContext, date: string) {
  const targets = shiftTargets(c.months, c.config.owner, c.events)
  const history = reconcileCancellations(c.months, c.events).filter(e => e.kind === 'cancel' && e.owner === c.config.owner && e.start === date)
  const active = history.filter(e => e.cancellation?.state === 'active')
  const controls = targets.flatMap((t, index) => targetDate(t) !== date || cancelled(t, active, c.months) || (t.eventId && cancelledLinkedEvent(c.events.find(e => e.id === t.eventId)!, active)) ? [] : [
    `<div class="cancellation-row"><span>${esc(shiftLabel(t))}</span><button data-cancel-shift="${index}">Отменить ${t.kind === 'home' ? 'дежурство' : 'смену'}</button></div>`,
  ]).join('')
  const rows = history.map(e => `<div class="cancellation-row cancelled-record"><div><s>${esc(shiftLabel(e.cancellation!.target))}</s><small>${esc(cancellationStatus(e, targets, c.months))}</small></div><button data-restore-shift="${esc(e.id)}">${e.cancellation!.state === 'active' && targets.some(t => cancellationMatches(e.cancellation!.target, t, c.months, e.owner)) ? 'Восстановить смену' : e.cancellation!.state === 'active' ? 'Снять отмену' : 'Скрыть отметку'}</button></div>`).join('')
  return controls || rows ? `<section class="cancellation-controls" aria-label="Отмена смен">${controls}${rows}</section>` : ''
}
export function cancellationAgendaRow(e: PersonalEvent, targets: CancellationTarget[]) {
  return `<button class="personal-event-row cancelled-record" data-cancel-day="${esc(e.start)}" data-sort-date="${esc(e.start)}"><span aria-hidden="true">⊘</span><span><s>${esc(shiftLabel(e.cancellation!.target))}</s><small>${esc(cancellationStatus(e, targets))}</small></span></button>`
}
