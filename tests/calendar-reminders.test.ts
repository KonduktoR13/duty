import { describe, expect, it } from 'vitest'
import { calendarRemindersLabel, googleReminders, normalizeCalendarReminders, reminderSignature } from '../src/calendar-reminders'
import { applyCalendarSync, buildCalendarDrafts, privateProperties, type CalendarGateway } from '../src/calendar-sync'
import { googleEventPayload, googleReminderPatchPayload } from '../src/google-calendar'

describe('Google Calendar shift reminders', () => {
  it('supports calendar defaults, no reminders and multiple custom popup reminders', () => {
    expect(googleReminders()).toEqual({ useDefault: true })
    expect(googleReminders({ mode: 'none' })).toEqual({ useDefault: false, overrides: [] })
    expect(googleReminders({ mode: 'custom', minutes: [720, 60] })).toEqual({
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 720 },
      ],
    })
    expect(calendarRemindersLabel({ mode: 'custom', minutes: [60, 720] })).toBe('за 1 ч · за 12 ч')
  })

  it('normalizes invalid, duplicate and excessive custom values before sending them to Google', () => {
    expect(normalizeCalendarReminders({ mode: 'custom', minutes: [60, 60, -1, 40_321, 15, 120, 720, 1_440, 2_880] })).toEqual({
      mode: 'custom',
      minutes: [15, 60, 120, 720, 1_440],
    })
  })

  it('puts reminders on new events while a bulk patch contains no time or title fields', () => {
    const draft = buildCalendarDrafts('2026-08', 'D12', [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
    expect(googleEventPayload('event1', draft, privateProperties('2026-08', 'D12', draft.key), { mode: 'none' }).reminders)
      .toEqual({ useDefault: false, overrides: [] })
    expect(googleReminderPatchPayload({ mode: 'custom', minutes: [60] })).toEqual({
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
    })
    expect(googleReminderPatchPayload({ mode: 'custom', minutes: [60] })).not.toHaveProperty('start')
    expect(googleReminderPatchPayload({ mode: 'custom', minutes: [60] })).not.toHaveProperty('summary')
  })

  it('passes the selected reminder policy through idempotent sync and records it locally', async () => {
    const draft = buildCalendarDrafts('2026-08', 'D12', [{ date: '2026-08-03', kind: 'hours', raw: '24', hours: 24 }])[0]
    const received: unknown[] = []
    const gateway: CalendarGateway = {
      get: async () => null,
      insert: async (id, _draft, _properties, reminders) => { received.push(reminders); return { id, etag: 'e1' } },
      patch: async id => ({ id }),
      remove: async () => {},
    }
    const reminders = { mode: 'custom' as const, minutes: [60, 720] }
    const result = await applyCalendarSync({
      month: '2026-08',
      deltaNumber: 'D12',
      desired: [draft],
      audits: [],
      gateway,
      eventId: async () => 'event1',
      reminders,
    })
    expect(received).toEqual([reminders])
    expect(result.events[draft.key].reminderSignature).toBe(reminderSignature(reminders))
  })
})
