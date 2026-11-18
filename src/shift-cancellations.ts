import { eventSchema, type CancellationTarget, type PersonalEvent } from './personal-types'
import type { CalendarEventDraft, MonthRecord } from './types'
import { allMarksForDelta, candidateForMonth } from './roster'
import { workIntervals } from './intervals'

const minutes = (s: string) => Date.parse(s + 'Z') / 60000
export const targetDate = (t: CancellationTarget) => new Date(t.start * 60000).toISOString().slice(0, 10)
const code = (raw: string) => raw === '16+8' ? '24' : raw
export function sameShift(a: CancellationTarget, b: CancellationTarget) {
  return a.source === b.source && (a.source !== 'manual' || a.eventId === b.eventId) &&
    a.occurrence === b.occurrence && a.copies === b.copies && a.kind === b.kind && code(a.raw) === code(b.raw) && a.start === b.start && a.end === b.end
}
// Losing the neighbouring PDF is uncertainty, not an authoritative change to
// a previously combined 16+8 shift. Suppress its remaining known 16-hour part.
export function cancellationMatches(snapshot: CancellationTarget, current: CancellationTarget, months: MonthRecord[], owner: string) {
  if (sameShift(snapshot, current)) return true
  if (snapshot.source !== 'pdf' || current.source !== 'pdf' || !snapshot.boundary16 || !current.boundary16 || code(snapshot.raw) !== '24' || current.raw !== '16' || snapshot.kind !== 'hours' || current.kind !== 'hours' || snapshot.start !== current.start || snapshot.end <= current.end) return false
  const nextMonth = new Date(snapshot.end * 60000).toISOString().slice(0, 7)
  return !months.some(m => m.id === nextMonth && candidateForMonth(m, owner))
}
export function shiftTargets(months: MonthRecord[], owner: string, events: PersonalEvent[]): CancellationTarget[] {
  const pdf: CancellationTarget[] = workIntervals(allMarksForDelta(months, owner)).map(i => ({
    source: 'pdf', occurrence: 0, copies: 1, boundary16: months.some(m => m.id === i.date.slice(0, 7) && candidateForMonth(m, owner)?.marks.some(mark => mark.date === i.date && mark.kind === 'hours' && mark.raw === '16' && mark.hours === 16)), key: i.key, start: minutes(i.start.dateTime), end: minutes(i.end.dateTime), kind: i.kind, raw: i.raw,
  }))
  const groups = new Map<string, CancellationTarget[]>();
  for (const t of pdf) {
    const fingerprint = JSON.stringify([t.kind, code(t.raw), t.start, t.end]);
    const group = groups.get(fingerprint) || [];
    group.push(t);
    groups.set(fingerprint, group);
  }
  for (const group of groups.values()) group.forEach((t, index) => {
    t.occurrence = index;
    t.copies = group.length;
  });
  const manual: CancellationTarget[] = events.filter(e => (!e.owner || e.owner === owner) && ['extra', 'emergency', 'home'].includes(e.kind)).map(e => {
    const start = minutes(e.start + 'T' + e.startTime + ':00'), end = minutes(e.end + 'T' + e.endTime + ':00')
    return { source: 'manual', occurrence: 0, copies: 1, boundary16: false, key: 'manual:' + e.id, eventId: e.id, start, end, kind: e.kind === 'home' ? 'home' : 'hours', raw: e.kind === 'home' ? `V${(end - start) / 60}` : e.kind === 'emergency' ? 'Erakorraline' : '+' }
  })
  return [...pdf, ...manual.filter(t => {
    const e = events.find(e => e.id === t.eventId)!
    return !e.linkConfirmed || !pdf.some(p => p.key === e.linkedKey && p.kind === t.kind && p.start === t.start && p.end === t.end)
  })]
}
export function reconcileCancellations(months: MonthRecord[], events: PersonalEvent[]): PersonalEvent[] {
  const targets = new Map<string, CancellationTarget[]>()
  return events.map(e => {
    if (e.kind !== 'cancel' || !e.cancellation || e.cancellation.state !== 'active') return e
    const t = e.cancellation.target
    // No source/employee row is not proof that a shift disappeared.
    const sourceMonth = t.key.match(/^20\d\d-\d\d/)?.[0] || targetDate(t).slice(0, 7)
    if (t.source === 'pdf' && !months.some(m => m.id === sourceMonth && candidateForMonth(m, e.owner))) return e
    if (!targets.has(e.owner)) targets.set(e.owner, shiftTargets(months, e.owner, events))
    const current = targets.get(e.owner)!
    if (current.some(c => cancellationMatches(t, c, months, e.owner))) return e
    const changed = current.some(c => c.source === t.source && (t.source === 'manual' ? c.eventId === t.eventId : c.kind === t.kind && targetDate(c) === targetDate(t)))
    return { ...e, updatedAt: Date.now(), cancellation: { target: t, state: changed ? 'changed' : 'removed' } }
  })
}
export function activeCancellations(months: MonthRecord[], events: PersonalEvent[], owner: string) {
  return reconcileCancellations(months, events).filter(e => e.kind === 'cancel' && e.owner === owner && e.cancellation?.state === 'active')
}
export function cancelled(t: CancellationTarget, cancellations: PersonalEvent[], months: MonthRecord[] = []) {
  return cancellations.some(e => e.cancellation && cancellationMatches(e.cancellation.target, t, months, e.owner))
}
export function cancelledLinkedEvent(event: PersonalEvent, cancellations: PersonalEvent[]) {
  if (!event.linkConfirmed || !event.startTime || !event.endTime || !event.end) return undefined;
  return cancellations.find(e => {
    const t = e.cancellation?.target;
    return t?.source === 'pdf' && t.key === event.linkedKey && t.kind === (event.kind === 'home' ? 'home' : 'hours') &&
      t.start === minutes(event.start + 'T' + event.startTime + ':00') && t.end === minutes(event.end + 'T' + event.endTime + ':00');
  })?.cancellation?.target;
}
export function newCancellation(target: CancellationTarget, owner: string) {
  return eventSchema.parse({ id: crypto.randomUUID(), kind: 'cancel', owner, start: targetDate(target), end: targetDate(target), title: 'Отмена смены', color: 'grey', cancellation: { target, state: 'active' }, createdAt: Date.now(), updatedAt: Date.now() })
}
export function cancelledDraft(draft: CalendarEventDraft, cancellations: PersonalEvent[]) {
  return cancellations.some(e => {
    const t = e.cancellation?.target
    if (!t || t.kind !== draft.kind) return false
    const keyMatches = draft.key === t.key || draft.key.startsWith(t.key + ':part:')
    const contained = t.start <= minutes(draft.start.dateTime) && t.end >= minutes(draft.end.dateTime)
    return contained && (t.source === 'manual' ? keyMatches : code(t.raw) === code(draft.raw) && (t.copies > 1 ? keyMatches : true))
  })
}
