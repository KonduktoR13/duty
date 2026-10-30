import { esc } from "./ui";
import type { SalarySettings } from "./types";

type SettingsView = {
  delta: string;
  googleLabel: string;
  lastSync: string;
  tracked: number;
  salary: SalarySettings;
};

function money(value: number) {
  return (
    new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value) + " €"
  );
}

export function settingsView({
  delta,
  googleLabel,
  lastSync,
  tracked,
  salary,
}: SettingsView) {
  return `<div class="dialog-panel">
    <div class="dialog-head"><h2>Настройки</h2><button class="dialog-close" id="close" aria-label="Закрыть настройки">×</button></div>
    <div class="dialog-content">
      <section class="settings-group" aria-labelledby="schedule-settings-title">
        <h3 id="schedule-settings-title">График и календарь</h3>
        <button class="settings-row" id="delta-settings"><span><b>Показываемый D-номер</b><small>Сменить график на экране</small></span><strong>${esc(delta || "Выбрать")} <i aria-hidden="true">›</i></strong></button>
        <button class="settings-row" id="google-settings"><span><b>Google Calendar</b><small>${esc(googleLabel)}</small><small>${esc(lastSync)}${tracked ? ` · событий приложения: ${tracked}` : ""}</small></span><i aria-hidden="true">›</i></button>
      </section>
      <section class="settings-group" aria-labelledby="salary-settings-title">
        <h3 id="salary-settings-title">Прогноз зарплаты</h3>
        <button class="settings-row" id="salary-settings"><span><b>Põhipalk и надбавки</b><small>${salary.replacementEnabled ? `Asendamise tasu ${String(salary.replacementPercent).replace(".", ",")}%` : "Asendamise tasu выключена"} · отпускные ${salary.vacationEnabled ? money(salary.vacationDailyRate) + "/дн." : "выключены"}</small></span><strong>${money(salary.baseSalary)} <i aria-hidden="true">›</i></strong></button>
      </section>
      <section class="settings-group" aria-labelledby="data-settings-title">
        <h3 id="data-settings-title">Данные на устройстве</h3>
        <button class="settings-row" id="export-backup"><span><b>Сохранить резервную копию</b><small>Графики, PDF и настройки в одном файле</small></span><i aria-hidden="true">↓</i></button>
        <button class="settings-row" id="import-backup"><span><b>Восстановить из копии</b><small>Перенести ранее сохранённые данные</small></span><i aria-hidden="true">↑</i></button>
        <details class="storage-details"><summary>О хранении данных</summary><p class="storage-status" role="status">Проверяем хранилище…</p></details>
      </section>
      <nav class="settings-legal" aria-label="Информация о приложении"><a href="privacy/" target="_blank" rel="noopener">Конфиденциальность</a><a href="terms/" target="_blank" rel="noopener">Условия использования</a></nav>
      <p class="settings-version">Версия ${__APP_VERSION__}</p>
      <details class="settings-danger"><summary>Удаление данных</summary><p>Удаляет графики, PDF и настройки из этого браузера. События Google останутся.</p><button class="danger" id="wipe">Удалить все локальные данные</button></details>
    </div>
  </div>`;
}

export function salarySettingsView(
  settings: SalarySettings,
  fromAnalysis: boolean,
) {
  return `<div class="dialog-panel">
    <div class="dialog-head"><h2>Расчёт зарплаты</h2><button class="dialog-close" id="salary-back" aria-label="Назад">‹</button></div>
    <form class="dialog-content salary-settings-form" id="salary-form">
      <p class="settings-lead">Параметры хранятся только на устройстве. Расчёт в «Анализе» остаётся ориентировочным.</p>
      <h3 class="form-section-title">Оклад и надбавки</h3><label><span>Новые параметры действуют с</span><input type="date" id="salary-effective" required value="${new Date().toISOString().slice(0, 7)}-01"></label>
      <label><span>Põhipalk в месяц</span><span class="number-field"><input id="base-salary" name="baseSalary" type="number" inputmode="decimal" min="0.01" max="100000" step="0.01" required value="${settings.baseSalary}"><i>€</i></span></label>
      <label class="toggle-field"><span><b>Asendamise tasu</b><small>Временная надбавка от põhipalk</small></span><input id="replacement-enabled" name="replacementEnabled" type="checkbox"${settings.replacementEnabled ? " checked" : ""}></label>
      <label id="replacement-percent-row"${settings.replacementEnabled ? "" : " hidden"}><span>Процент надбавки</span><span class="number-field"><input id="replacement-percent" name="replacementPercent" type="number" inputmode="decimal" min="0" max="100" step="0.0001" required value="${settings.replacementPercent}"><i>%</i></span></label>
      <small class="salary-form-note">По двум palgateatis значение надбавки составляет примерно 16,0184%. При выключении она полностью скрыта из анализа.</small>
      <label class="toggle-field"><span><b>Учитывать отпускные</b><small>По отметкам P в D-графике</small></span><input id="vacation-enabled" name="vacationEnabled" type="checkbox"${settings.vacationEnabled ? " checked" : ""}></label>
      <label id="vacation-rate-row"${settings.vacationEnabled ? "" : " hidden"}><span>Средняя ставка отпускных</span><span class="number-field"><input id="vacation-rate" name="vacationDailyRate" type="number" inputmode="decimal" min="0" max="10000" step="0.01" required value="${settings.vacationDailyRate}"><i>€/дн.</i></span></label>
      <small class="salary-form-note">98,46 € подтверждены palgateatis за декабрь 2025 — июль 2026. Обновите ставку после следующего расчёта бухгалтерии.</small>
      <details class="salary-tax-settings"><summary><span><b>Налоги и дополнительные ставки</b><small>22% · 700 € · пенсионная ставка 2%</small></span><i>⌄</i></summary>
        <label><span>Tulumaks</span><span class="number-field"><input id="income-tax-percent" type="number" min="0" max="100" step="0.01" value="${settings.incomeTaxPercent}"><i>%</i></span></label>
        <label><span>Maksuvaba tulu</span><span class="number-field"><input id="tax-free-allowance" type="number" min="0" max="10000" step="0.01" value="${settings.taxFreeAllowance}"><i>€</i></span></label>
        <label><span>Töötuskindlustus</span><span class="number-field"><input id="unemployment-percent" type="number" min="0" max="100" step="0.01" value="${settings.unemploymentPercent}"><i>%</i></span></label>
        <label><span>Kogumispension</span><span class="number-field"><input id="funded-pension-percent" type="number" min="0" max="100" step="0.01" value="${settings.fundedPensionPercent}"><i>%</i></span></label>
        <label><span>Valveaeg</span><span class="number-field"><input id="home-duty-percent" type="number" min="0" max="100" step="0.01" value="${settings.homeDutyPercent}"><i>%</i></span></label>
      </details>
      <input type="hidden" name="fromAnalysis" value="${fromAnalysis ? "1" : "0"}">
    </form>
    <div class="dialog-actions"><button class="primary" type="submit" form="salary-form">Сохранить</button></div>
  </div>`;
}

export function deltaPickerView(
  numbers: string[],
  current: string,
  fromSettings: boolean,
) {
  return `<div class="dialog-panel">
    <div class="dialog-head"><h2>Выбор D-номера</h2><button class="dialog-close" id="cancel" aria-label="${fromSettings ? "Назад к настройкам" : "Закрыть выбор номера"}">${fromSettings ? "‹" : "×"}</button></div>
    <div class="dialog-content"><p class="picker-note">Выберите, чей график показывать. Все PDF и остальные номера сохранятся.</p>
    <div class="delta-choices" role="group" aria-label="D-номера">${numbers.map((number) => `<button class="delta-choice" data-select-delta="${esc(number)}" aria-pressed="${number === current}"><b>${esc(number)}</b><span>${number === current ? "Выбран" : "Показать"}</span>${number === current ? '<i aria-hidden="true">✓</i>' : ""}</button>`).join("") || "<p>Сначала импортируйте PDF-график.</p>"}</div></div>
  </div>`;
}
