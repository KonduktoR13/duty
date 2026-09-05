import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../src/db'
import { calendarSyncId } from '../src/calendar-sync'
import type { CalendarMonthSync, MonthRecord } from '../src/types'

beforeEach(async () => storage.clear())

describe('local persistence', () => {
  it('saves a revision atomically and restores its original PDF', async () => {
    const old: MonthRecord = { id:'2026-08',fileName:'old.pdf',importedAt:1,hash:'old',shifts:[],deltaNumber:'D12',status:'local' }
    await storage.saveImport(old,new Blob(['old']))
    await storage.saveImport({...old,hash:'new',fileName:'new.pdf'},new Blob(['new']))
    expect((await storage.revision(old.id))?.month.hash).toBe('old')
    await storage.restoreRevision(old.id)
    expect((await storage.months())[0].fileName).toBe('old.pdf')
    expect(await (await storage.pdf(old.id))?.text()).toBe('old')
  })
  it('rolls back an entire restore if one value cannot be stored', async () => {
    await storage.set('deltaNumber','D12')
    await expect(storage.restore({months:[],pdfs:[],syncs:[],revisions:[],settings:[['bad',()=>{}]]})).rejects.toBeDefined()
    expect(await storage.setting('deltaNumber')).toBe('D12')
  })
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
