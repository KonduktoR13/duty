import type { MonthRecord } from './types'
const NAME='my-shifts', VERSION=1
function db(): Promise<IDBDatabase> { return new Promise((resolve,reject)=>{ const r=indexedDB.open(NAME,VERSION); r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains('months'))d.createObjectStore('months',{keyPath:'id'}); if(!d.objectStoreNames.contains('settings'))d.createObjectStore('settings') }; r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error) }) }
async function tx<T>(store: string, mode: IDBTransactionMode, action:(s:IDBObjectStore)=>IDBRequest<T>) { const d=await db(); return new Promise<T>((resolve,reject)=>{const t=d.transaction(store,mode);const r=action(t.objectStore(store));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}) }
export const storage = {
  months: async () => ((await tx('months', 'readonly', s => s.getAll())).sort((a: MonthRecord, b: MonthRecord) => b.id.localeCompare(a.id)) as MonthRecord[]),
  put: (m: MonthRecord) => tx('months', 'readwrite', s => s.put(m)),
  remove: (id: string) => tx('months', 'readwrite', s => s.delete(id)),
  setting: <T>(key: string) => tx<T>('settings', 'readonly', s => s.get(key)),
  set: (key: string, value: unknown) => tx('settings', 'readwrite', s => s.put(value, key)),
  clear: async () => { const d = await db(); await Promise.all(['months', 'settings'].map(store => new Promise<void>((res, rej) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = () => res(); t.onerror = () => rej(t.error) }))) }
}
