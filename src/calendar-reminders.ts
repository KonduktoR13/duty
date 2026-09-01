import type { CalendarReminderSettings } from './types'

export type GoogleEventReminders = {
  useDefault: boolean
  overrides?: Array<{ method: 'popup'; minutes: number }>
}

export const DEFAULT_CALENDAR_REMINDERS: CalendarReminderSettings = { mode: 'default' }

export function normalizeCalendarReminders(value?: CalendarReminderSettings): CalendarReminderSettings {
  if (!value || value.mode === 'default') return DEFAULT_CALENDAR_REMINDERS
  if (value.mode === 'none') return { mode: 'none' }
  const minutes = [...new Set(value.minutes.filter(item => Number.isInteger(item) && item >= 0 && item <= 40_320))]
    .sort((a, b) => a - b)
    .slice(0, 5)
  return minutes.length ? { mode: 'custom', minutes } : DEFAULT_CALENDAR_REMINDERS
}

export function googleReminders(settings?: CalendarReminderSettings): GoogleEventReminders {
  const value = normalizeCalendarReminders(settings)
  if (value.mode === 'default') return { useDefault: true }
  if (value.mode === 'none') return { useDefault: false, overrides: [] }
  return { useDefault: false, overrides: value.minutes.map(minutes => ({ method: 'popup', minutes })) }
}

export function reminderSignature(settings?: CalendarReminderSettings) {
  return JSON.stringify(normalizeCalendarReminders(settings))
}

export function reminderOffsetLabel(minutes: number) {
  if (minutes > 0 && minutes % 1_440 === 0) return `за ${minutes / 1_440} дн.`
  if (minutes > 0 && minutes % 60 === 0) return `за ${minutes / 60} ч`
  if (minutes === 0) return 'в момент начала'
  return `за ${minutes} мин`
}

export function calendarRemindersLabel(settings?: CalendarReminderSettings) {
  const value = normalizeCalendarReminders(settings)
  if (value.mode === 'default') return 'Как в Google Calendar'
  if (value.mode === 'none') return 'Без уведомлений'
  return value.minutes.map(reminderOffsetLabel).join(' · ')
}
