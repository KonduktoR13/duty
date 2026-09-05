import type { CalendarMonthSync, MonthRecord } from './types'
const NAME = 'my-shifts',
  VERSION = 4
const STORES = ['months', 'pdfs', 'settings', 'syncs', 'revisions']
let connection: Promise<IDBDatabase> | undefined
export type Revision = { id: string; month: MonthRecord; pdf?: Blob }
export type Snapshot = {
  months: MonthRecord[]
  pdfs: Array<[string, Blob]>
  settings: Array<[string, unknown]>
  syncs: CalendarMonthSync[]
  revisions: Revision[]
}
function db(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise((resolve, reject) => {
    let blocked = false
    const r = indexedDB.open(NAME, VERSION)
    r.onupgradeneeded = () => {
      for (const name of STORES)
        if (!r.result.objectStoreNames.contains(name))
          r.result.createObjectStore(
            name,
            ['months', 'syncs', 'revisions'].includes(name) ? { keyPath: 'id' } : undefined,
          )
    }
    r.onsuccess = () => {
      if (blocked) {
        r.result.close()
        return
      }
      r.result.onversionchange = () => {
        r.result.close()
        connection = undefined
      }
      resolve(r.result)
    }
    r.onerror = () => {
      connection = undefined
      reject(r.error)
    }
    r.onblocked = () => {
      blocked = true
      connection = undefined
      reject(new Error('Закройте другие вкладки приложения и повторите обновление.'))
    }
  })
  return connection
}
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (t: IDBTransaction) => () => T,
): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode)
    let result: () => T
    t.oncomplete = () => resolve(result())
    t.onabort = t.onerror = () =>
      reject(t.error || new Error('Не удалось сохранить данные на устройстве.'))
    try {
      result = action(t)
    } catch (error) {
      t.abort()
      reject(error)
    }
  })
}
function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T>,
) {
  return transaction([store], mode, (t) => {
    const r = action(t.objectStore(store))
    return () => r.result
  })
}
export const storage = {
  months: async () =>
    (await tx('months', 'readonly', (s) => s.getAll())).sort((a: MonthRecord, b: MonthRecord) =>
      b.id.localeCompare(a.id),
    ) as MonthRecord[],
  put: (m: MonthRecord) => tx('months', 'readwrite', (s) => s.put(m)),
  saveImport: (month: MonthRecord, pdf: Blob) =>
    transaction(['months', 'pdfs', 'revisions', 'settings'], 'readwrite', (t) => {
      const old = t.objectStore('months').get(month.id),
        original = t.objectStore('pdfs').get(month.id)
      original.onsuccess = () => {
        if (old.result && old.result.hash !== month.hash)
          t.objectStore('revisions').put({ id: month.id, month: old.result, pdf: original.result })
        t.objectStore('months').put(month)
        t.objectStore('pdfs').put(pdf, month.id)
        t.objectStore('settings').put(month.deltaNumber, 'deltaNumber')
      }
      return () => undefined
    }),
  revision: (id: string) => tx<Revision | undefined>('revisions', 'readonly', (s) => s.get(id)),
  restoreRevision: (id: string) =>
    transaction(['months', 'pdfs', 'revisions'], 'readwrite', (t) => {
      const r = t.objectStore('revisions').get(id)
      r.onsuccess = () => {
        if (!r.result) return
        t.objectStore('months').put(r.result.month)
        if (r.result.pdf) t.objectStore('pdfs').put(r.result.pdf, id)
        else t.objectStore('pdfs').delete(id)
        t.objectStore('revisions').delete(id)
      }
      return () => undefined
    }),
  remove: (id: string) =>
    transaction(['months', 'pdfs', 'revisions'], 'readwrite', (t) => {
      for (const name of ['months', 'pdfs', 'revisions']) t.objectStore(name).delete(id)
      return () => undefined
    }),
  putPdf: (id: string, pdf: Blob) => tx('pdfs', 'readwrite', (s) => s.put(pdf, id)),
  pdf: (id: string) => tx<Blob | undefined>('pdfs', 'readonly', (s) => s.get(id)),
  syncs: () => tx<CalendarMonthSync[]>('syncs', 'readonly', (s) => s.getAll()),
  sync: (id: string) => tx<CalendarMonthSync | undefined>('syncs', 'readonly', (s) => s.get(id)),
  putSync: (sync: CalendarMonthSync) => tx('syncs', 'readwrite', (s) => s.put(sync)),
  removeSync: (id: string) => tx('syncs', 'readwrite', (s) => s.delete(id)),
  setting: <T>(key: string) => tx<T>('settings', 'readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => tx('settings', 'readwrite', (s) => s.put(value, key)),
  clear: () =>
    transaction(STORES, 'readwrite', (t) => {
      for (const name of STORES) t.objectStore(name).clear()
      return () => undefined
    }),
  snapshot: () =>
    transaction(STORES, 'readonly', (t) => {
      const months = t.objectStore('months').getAll(),
        syncs = t.objectStore('syncs').getAll(),
        revisions = t.objectStore('revisions').getAll()
      const pdfKeys = t.objectStore('pdfs').getAllKeys(),
        pdfs = t.objectStore('pdfs').getAll()
      const settingKeys = t.objectStore('settings').getAllKeys(),
        settings = t.objectStore('settings').getAll()
      return (): Snapshot => ({
        months: months.result,
        pdfs: pdfKeys.result.map((key, i) => [String(key), pdfs.result[i]]),
        settings: settingKeys.result.map((key, i) => [String(key), settings.result[i]]),
        syncs: syncs.result,
        revisions: revisions.result,
      })
    }),
  restore: (snapshot: Snapshot) =>
    transaction(STORES, 'readwrite', (t) => {
      for (const name of STORES) t.objectStore(name).clear()
      for (const month of snapshot.months) t.objectStore('months').put(month)
      for (const [key, value] of snapshot.pdfs) t.objectStore('pdfs').put(value, key)
      for (const [key, value] of snapshot.settings) t.objectStore('settings').put(value, key)
      for (const sync of snapshot.syncs) t.objectStore('syncs').put(sync)
      for (const revision of snapshot.revisions) t.objectStore('revisions').put(revision)
      return () => undefined
    }),
}
