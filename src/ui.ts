export const esc = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  )
const paths: Record<string, string> = {
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
  analysis: '<path d="M4 20V4m0 16h17M8 16v-4m5 4V8m5 8V5"/>',
  documents: '<path d="M7 3h8l4 4v14H5V3h2m8 0v5h4M8 12h8m-8 4h8"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3Z"/><circle cx="11.5" cy="11.5" r="3"/>',
}
export function icon(name: string) {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.calendar}</svg>`
}

let opener: HTMLElement | null = null
export function dialogBusy() {
  return Boolean(document.querySelector('#dialog[open] .busy'))
}
export function openDialog(html: string) {
  let dialog = document.querySelector<HTMLDialogElement>('#dialog')
  if (!dialog) {
    dialog = document.createElement('dialog')
    dialog.id = 'dialog'
    document.body.append(dialog)
  }
  if (!dialog.open) opener = document.activeElement as HTMLElement
  dialog.innerHTML = html
  const heading = dialog.querySelector('h2')
  if (heading) {
    heading.id = 'dialog-title'
    dialog.setAttribute('aria-labelledby', heading.id)
  }
  dialog.setAttribute('aria-busy', String(Boolean(dialog.querySelector('.busy'))))
  dialog.oncancel = (event) => {
    if (dialogBusy()) event.preventDefault()
  }
  if (!dialog.open) dialog.showModal()
  requestAnimationFrame(() => {
    const focus = dialog!.querySelector<HTMLElement>('[autofocus],button,input,select')
    if (focus) focus.focus()
    else {
      dialog!.tabIndex = -1
      dialog!.focus()
    }
  })
}
export function closeDialog() {
  document.querySelector<HTMLDialogElement>('#dialog')?.close()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  else if (opener?.id) document.getElementById(opener.id)?.focus({ preventScroll: true })
}
export function localError(error: unknown) {
  const message =
    error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'На устройстве не хватает места. Сохраните резервную копию и освободите место, затем повторите.'
      : error instanceof Error
        ? error.message
        : 'Не удалось выполнить действие. Повторите попытку.'
  openDialog(
    `<h2>Не удалось завершить действие</h2><p>${esc(message)}</p><button class="primary" id="error-close">Понятно</button>`,
  )
  document.querySelector('#error-close')?.addEventListener('click', closeDialog)
}
export function run(action: () => Promise<unknown>) {
  void action().catch(localError)
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
