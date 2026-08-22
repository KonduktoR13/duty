export type Shift = { date: string; hours: number; code: string }
export type LeaveCode = 'P' | 'LHPu'
export type DayMark =
  | { date: string; kind: 'hours' | 'home'; raw: string; hours: number }
  | { date: string; kind: 'leave'; raw: LeaveCode }
  | { date: string; kind: 'other'; raw: string }

export type MonthRecord = {
  id: string
  fileName: string
  importedAt: number
  hash: string
  // Kept for records saved by earlier PWA versions. New imports also store
  // marks, which can represent several entries in one calendar day.
  shifts: Shift[]
  marks?: DayMark[]
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
