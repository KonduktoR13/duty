export type Shift = { date: string; hours: number; code: string }
export type LeaveCode = 'P' | 'LHPu'
export type DayMark =
  | { date: string; kind: 'hours' | 'home'; raw: string; hours: number }
  | { date: string; kind: 'tentative'; raw: string; hours: number }
  | { date: string; kind: 'leave'; raw: LeaveCode }
  | { date: string; kind: 'other'; raw: string }

export type CalendarEventDraft = {
  key: string
  date: string
  kind: 'hours' | 'home'
  raw: string
  hours: number
  summary: string
  description: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
}

export type CalendarReminderSettings =
  | { mode: 'default' }
  | { mode: 'none' }
  | { mode: 'custom'; minutes: number[] }

export type SyncedCalendarEvent = {
  eventId: string
  draft: CalendarEventDraft
  etag?: string
  updated?: string
  reminderSignature?: string
}

export type CalendarSyncError = 'auth' | 'offline' | 'api'
export type CalendarMonthSync = {
  id: string
  month: string
  deltaNumber: string
  accountProfileId?: string
  syncedAt?: number
  events: Record<string, SyncedCalendarEvent>
  lastError?: CalendarSyncError
}

export type GoogleIntegrationSettings = {
  enabled: boolean
  accountProfileId?: string
  accountEmail?: string
  accountProfiles?: Record<string, string>
  connectedAt?: number
  lastSyncAt?: number
  lastSyncByAccount?: Record<string, number>
  calendarReminders?: CalendarReminderSettings
}

export type MonthRecord = {
  id: string
  fileName: string
  importedAt: number
  hash: string
  // Kept for records saved by earlier PWA versions. New imports also store
  // marks, which can represent several entries in one calendar day.
  shifts: Shift[]
  marks?: DayMark[]
  // All locally parsed rows are retained so the user can switch D-number and
  // inspect colleagues without uploading or reparsing the PDF online.
  candidates?: Candidate[]
  leaveDates?: string[]
  leaveCodes?: Record<string, LeaveCode>
  deltaNumber: string
  status: 'local' | 'changed'
  calendar?: { syncedAt?: number; dirty: boolean }
}

export type Candidate = {
  number: string
  values: string[]
  marks: DayMark[]
  shifts: Shift[]
  leaveDates: string[]
  leaveCodes: Record<string, LeaveCode>
  confidence: 'high' | 'review'
}
export type ParsedSchedule = { month: string; candidates: Candidate[]; warnings: string[] }
