import { z } from 'zod'
import { storage, type Snapshot } from './db'
import { download, openDialog, closeDialog, run, esc } from './ui'
import { clearGoogleAccessToken } from './google-calendar'

const monthId = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/)
const day = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
const delta = z.string().regex(/^D\d+$/)
const text = z.string().max(10000)
const hours = z.number().finite().positive().max(1000)
const mark = z.discriminatedUnion('kind', [
  z.object({ date: day, kind: z.literal('hours'), raw: text, hours }),
  z.object({ date: day, kind: z.literal('home'), raw: text, hours }),
  z.object({ date: day, kind: z.literal('tentative'), raw: text, hours }),
  z.object({ date: day, kind: z.literal('other'), raw: text }),
  z.object({ date: day, kind: z.literal('leave'), raw: z.enum(['P', 'LHPu']) }),
])
const shift = z.object({ date: day, hours, code: text })
const candidate = z.object({
  number: delta,
  values: z.array(text),
  marks: z.array(mark),
  shifts: z.array(shift),
  leaveDates: z.array(day),
  leaveCodes: z.record(day, z.enum(['P', 'LHPu'])),
  confidence: z.enum(['high', 'review']),
})
const month = z.object({
  id: monthId,
  fileName: text,
  importedAt: z.number(),
  hash: text,
  shifts: z.array(shift),
  marks: z.array(mark).optional(),
  candidates: z.array(candidate).optional(),
  rosterComplete: z.boolean().optional(),
  leaveDates: z.array(day).optional(),
  leaveCodes: z.record(day, z.enum(['P', 'LHPu'])).optional(),
  deltaNumber: delta,
  status: z.enum(['local', 'changed']),
  calendar: z.object({ syncedAt: z.number().optional(), dirty: z.boolean() }).optional(),
})
const dateTime = z.object({
  dateTime: z.string().regex(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  timeZone: z.literal('Europe/Tallinn'),
})
const draft = z.object({
  key: text,
  date: day,
  kind: z.enum(['hours', 'home']),
  raw: text,
  hours,
  summary: text,
  description: text,
  start: dateTime,
  end: dateTime,
})
const sync = z.object({
  id: text,
  month: monthId,
  deltaNumber: delta,
  accountProfileId: text.optional(),
  syncedAt: z.number().optional(),
  lastError: z.enum(['auth', 'offline', 'api']).optional(),
  events: z.record(
    text,
    z.object({
      eventId: text,
      draft,
      etag: text.optional(),
      updated: text.optional(),
      reminderSignature: text.optional(),
    }),
  ),
})
const reminders = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }),
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('custom'),
    minutes: z.array(z.number().int().min(0).max(40320)).max(5),
  }),
])
const google = z.object({
  enabled: z.boolean(),
  accountProfileId: text.optional(),
  accountEmail: text.optional(),
  accountProfiles: z.record(text, text).optional(),
  connectedAt: z.number().optional(),
  lastSyncAt: z.number().optional(),
  lastSyncByAccount: z.record(text, z.number()).optional(),
  calendarReminders: reminders.optional(),
})
const settings = z.array(
  z.union([
    z.tuple([z.literal('deltaNumber'), z.union([delta, z.literal('')])]),
    z.tuple([z.literal('installationId'), text]),
    z.tuple([z.literal('googleIntegration'), google]),
    z.tuple([z.literal('calendarMode'), z.enum(['grid', 'list'])]),
    z.tuple([z.literal('showColleagues'), z.boolean()]),
  ]),
)
const pdfData = z
  .string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .max(30 * 1024 * 1024)
const schema = z.object({
  format: z.literal('my-shifts-backup'),
  version: z.literal(1),
  createdAt: z.string(),
  months: z.array(month).max(600),
  pdfs: z.array(z.tuple([monthId, pdfData])).max(600),
  settings,
  syncs: z.array(sync),
  revisions: z.array(z.object({ id: monthId, month, pdf: pdfData.optional() })),
})
function encode(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
function decode(value: string) {
  return new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], {
    type: 'application/pdf',
  })
}
export async function createBackup() {
  const snapshot = await storage.snapshot()
  const content = {
    ...snapshot,
    format: 'my-shifts-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    pdfs: await Promise.all(snapshot.pdfs.map(async ([id, pdf]) => [id, await encode(pdf)])),
    revisions: await Promise.all(
      snapshot.revisions.map(async (revision) => ({
        ...revision,
        pdf: revision.pdf ? await encode(revision.pdf) : undefined,
      })),
    ),
  }
  return new Blob([JSON.stringify(content)], { type: 'application/json' })
}
export async function readBackup(file: Blob): Promise<Snapshot> {
  if (file.size > 100 * 1024 * 1024) throw new Error('Резервная копия больше 100 МБ.')
  const parsed = schema.safeParse(JSON.parse(await file.text()))
  if (!parsed.success)
    throw new Error('Формат резервной копии не поддерживается или данные повреждены.')
  const data = parsed.data
  if (new Set(data.months.map((month) => month.id)).size !== data.months.length)
    throw new Error('В резервной копии повторяются месяцы.')
  return {
    months: data.months,
    pdfs: data.pdfs.map(([id, pdf]) => [id, decode(pdf)]),
    settings: data.settings,
    syncs: data.syncs,
    revisions: data.revisions.map((revision) => ({
      ...revision,
      pdf: revision.pdf ? decode(revision.pdf) : undefined,
    })),
  }
}
export async function exportBackup() {
  download(await createBackup(), `my-shifts-${new Date().toISOString().slice(0, 10)}.json`)
}
export function chooseBackup(refresh: () => Promise<void>) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = () =>
    run(async () => {
      if (!input.files?.[0]) return
      const snapshot = await readBackup(input.files[0])
      openDialog(
        `<h2>Восстановить резервную копию?</h2><p>Месяцев: ${snapshot.months.length}. Текущие локальные данные будут заменены. Сначала автоматически скачается их резервная копия. Google Calendar останется без изменений.</p><p>${esc(snapshot.months.map((month) => month.id).join(', '))}</p><button class="primary" id="restore-backup">Сохранить текущую копию и восстановить</button><button id="cancel-backup">Отмена</button>`,
      )
      document.querySelector('#cancel-backup')?.addEventListener('click', closeDialog)
      document
        .querySelector<HTMLButtonElement>('#restore-backup')
        ?.addEventListener('click', (event) => {
          ;(event.currentTarget as HTMLButtonElement).disabled = true
          run(async () => {
            await exportBackup()
            await storage.restore(snapshot)
            clearGoogleAccessToken()
            closeDialog()
            await refresh()
          })
        })
    })
  input.click()
}

export async function storageDescription() {
  const persistent = await navigator.storage?.persisted?.().catch(() => false)
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
  return `${persistent ? 'Браузер предоставил устойчивое хранение.' : 'Автоматическое удаление браузером не исключено.'}${estimate?.usage ? ` Занято ${(estimate.usage / 1024 / 1024).toFixed(1)} МБ.` : ''} Резервная копия содержит PDF и локальную историю Google; храните её как личный документ.`
}
