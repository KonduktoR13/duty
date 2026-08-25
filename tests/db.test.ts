import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../src/db'
import { calendarSyncId } from '../src/calendar-sync'
import type { CalendarMonthSync, MonthRecord } from '../src/types'

beforeEach(async () => storage.clear())

describe('local persistence', () => {
  it('persists a changed D-number independently from imported PDFs', async () => {
    await storage.set('deltaNumber', 'D40')
    expect(await storage.setting('deltaNumber')).toBe('D40')
  })

  it('keeps Google sync ownership metadata when a month is deleted only locally', async () => {
    const month: MonthRecord = { id: '2026-08', fileName: 'August.pdf', importedAt: 1, hash: 'x', shifts: [], deltaNumber: 'D12', status: 'local' }
    const sync: CalendarMonthSync = { id: '2026-08|D12', month: '2026-08', deltaNumber: 'D12', syncedAt: 2, events: {} }
    await storage.put(month)
    await storage.putSync(sync)
    await storage.remove(month.id)
    expect(await storage.months()).toEqual([])
    expect(await storage.sync(sync.id)).toEqual(sync)
  })

  it('persists the same month separately for two Google account profiles', async () => {
    const base = { month: '2026-08', deltaNumber: 'D12', syncedAt: 2, events: {} }
    const first: CalendarMonthSync = { ...base, id: calendarSyncId(base.month, base.deltaNumber, 'account-a'), accountProfileId: 'account-a' }
    const second: CalendarMonthSync = { ...base, id: calendarSyncId(base.month, base.deltaNumber, 'account-b'), accountProfileId: 'account-b' }
    await storage.putSync(first)
    await storage.putSync(second)
    expect(await storage.syncs()).toEqual(expect.arrayContaining([first, second]))
  })
})
