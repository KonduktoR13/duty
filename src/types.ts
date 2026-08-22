export type Shift = { date: string; hours: number; code: string }
export type LeaveCode = 'P' | 'LHPu'
export type MonthRecord = { id: string; fileName: string; importedAt: number; hash: string; shifts: Shift[]; leaveDates?: string[]; leaveCodes?: Record<string, LeaveCode>; deltaNumber: string; status: 'local' | 'changed'; calendar?: { syncedAt?: number; dirty: boolean } }
export type Candidate = { number: string; values: string[]; shifts: Shift[]; leaveDates: string[]; leaveCodes: Record<string, LeaveCode>; confidence: 'high' | 'review' }
export type ParsedSchedule = { month: string; candidates: Candidate[]; warnings: string[] }
