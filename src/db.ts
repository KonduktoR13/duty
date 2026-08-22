import type { MonthRecord } from './types'
const NAME='my-shifts', VERSION=2
function db(): Promise<IDBDatabase> { return new Promise((resolve,reject)=>{ const r=indexedDB.open(NAME,VERSION); r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains('months'))d.createObjectStore('months',{keyPath:'id'}); if(!d.objectStoreNames.contains('settings'))d.createObjectStore('settings'); if(!d.objectStoreNames.contains('pdfs'))d.createObjectStore('pdfs') }; r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error) }) }
async function tx<T>(store: string, mode: IDBTransactionMode, action:(s:IDBObjectStore)=>IDBRequest<T>) { const d=await db(); return new Promise<T>((resolve,reject)=>{const t=d.transaction(store,mode);const r=action(t.objectStore(store));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}) }
export const storage = {
  months: async () => ((await tx('months', 'readonly', s => s.getAll())).sort((a: MonthRecord, b: MonthRecord) => b.id.localeCompare(a.id)) as MonthRecord[]),
  put: (m: MonthRecord) => tx('months', 'readwrite', s => s.put(m)),
  saveImport: async (month: MonthRecord, pdf: Blob) => { const d=await db(); await new Promise<void>((resolve,reject)=>{const t=d.transaction(['months','pdfs'],'readwrite');t.objectStore('months').put(month);t.objectStore('pdfs').put(pdf,month.id);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error)}) },
  remove: async (id: string) => { const d=await db(); await new Promise<void>((resolve,reject)=>{const t=d.transaction(['months','pdfs'],'readwrite');t.objectStore('months').delete(id);t.objectStore('pdfs').delete(id);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error)}) },
  putPdf: (id: string, pdf: Blob) => tx('pdfs', 'readwrite', s => s.put(pdf, id)),
  pdf: (id: string) => tx<Blob | undefined>('pdfs', 'readonly', s => s.get(id)),
  setting: <T>(key: string) => tx<T>('settings', 'readonly', s => s.get(key)),
  set: (key: string, value: unknown) => tx('settings', 'readwrite', s => s.put(value, key)),
  clear: async () => { const d = await db(); await Promise.all(['months', 'settings', 'pdfs'].map(store => new Promise<void>((res, rej) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = () => res(); t.onerror = () => rej(t.error) }))) }
}
