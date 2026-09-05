import { IDBFactory } from 'fake-indexeddb'
import { it, expect, vi } from 'vitest'
it('upgrades a populated v3 database without losing months, PDFs or account settings', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('my-shifts', 3)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('months', { keyPath: 'id' })
      r.result.createObjectStore('syncs', { keyPath: 'id' })
      r.result.createObjectStore('pdfs')
      r.result.createObjectStore('settings')
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  await new Promise<void>((resolve, reject) => {
    const t = old.transaction(['months', 'pdfs', 'settings'], 'readwrite')
    t.objectStore('months').put({
      id: '2026-08',
      fileName: 'source.pdf',
      hash: 'original',
      shifts: [],
      deltaNumber: 'D12',
      importedAt: 1,
      status: 'local',
    })
    t.objectStore('pdfs').put(new Blob(['original']), '2026-08')
    t.objectStore('settings').put('D12', 'deltaNumber')
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
  old.close()
  const { storage } = await import('../src/db')
  expect((await storage.months())[0].hash).toBe('original')
  expect(await (await storage.pdf('2026-08'))?.text()).toBe('original')
  expect(await storage.setting('deltaNumber')).toBe('D12')
  expect(await storage.revision('2026-08')).toBeUndefined()
  vi.unstubAllGlobals()
})
