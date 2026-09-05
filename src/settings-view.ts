import { esc } from './ui'

type SettingsView = { delta: string; googleLabel: string; lastSync: string; tracked: number }

export function settingsView({ delta, googleLabel, lastSync, tracked }: SettingsView) {
  return `<div class="dialog-panel">
    <div class="dialog-head"><h2>Настройки</h2><button class="dialog-close" id="close" aria-label="Закрыть настройки">×</button></div>
    <div class="dialog-content">
      <section class="settings-group" aria-labelledby="schedule-settings-title">
        <h3 id="schedule-settings-title">График и календарь</h3>
        <button class="settings-row" id="delta-settings"><span><b>Показываемый D-номер</b><small>Сменить график на экране</small></span><strong>${esc(delta || 'Выбрать')} <i aria-hidden="true">›</i></strong></button>
        <button class="settings-row" id="google-settings"><span><b>Google Calendar</b><small>${esc(googleLabel)}</small><small>${esc(lastSync)}${tracked ? ` · событий приложения: ${tracked}` : ''}</small></span><i aria-hidden="true">›</i></button>
      </section>
      <section class="settings-group" aria-labelledby="data-settings-title">
        <h3 id="data-settings-title">Данные на устройстве</h3>
        <button class="settings-row" id="export-backup"><span><b>Сохранить резервную копию</b><small>Графики, PDF и настройки в одном файле</small></span><i aria-hidden="true">↓</i></button>
        <button class="settings-row" id="import-backup"><span><b>Восстановить из копии</b><small>Перенести ранее сохранённые данные</small></span><i aria-hidden="true">↑</i></button>
        <details class="storage-details"><summary>О хранении данных</summary><p class="storage-status" role="status">Проверяем хранилище…</p></details>
      </section>
      <nav class="settings-legal" aria-label="Информация о приложении"><a href="privacy/" target="_blank" rel="noopener">Конфиденциальность</a><a href="terms/" target="_blank" rel="noopener">Условия использования</a></nav>
      <details class="settings-danger"><summary>Удаление данных</summary><p>Удаляет графики, PDF и настройки из этого браузера. События Google останутся.</p><button class="danger" id="wipe">Удалить все локальные данные</button></details>
    </div>
  </div>`
}

export function deltaPickerView(numbers: string[], current: string, fromSettings: boolean) {
  return `<div class="dialog-panel">
    <div class="dialog-head"><h2>Выбор D-номера</h2><button class="dialog-close" id="cancel" aria-label="${fromSettings ? 'Назад к настройкам' : 'Закрыть выбор номера'}">${fromSettings ? '‹' : '×'}</button></div>
    <div class="dialog-content"><p class="picker-note">Выберите, чей график показывать. Все PDF и остальные номера сохранятся.</p>
    <div class="delta-choices" role="group" aria-label="D-номера">${numbers.map(number => `<button class="delta-choice" data-select-delta="${esc(number)}" aria-pressed="${number === current}"><b>${esc(number)}</b><span>${number === current ? 'Выбран' : 'Показать'}</span>${number === current ? '<i aria-hidden="true">✓</i>' : ''}</button>`).join('') || '<p>Сначала импортируйте PDF-график.</p>'}</div></div>
  </div>`
}
