import { esc, openDialog } from "./ui";
import type { PayrollContext, PersonalForecast } from "./personal";
import {
  personalForecast,
  personalPlan,
  eventLabels,
  eventTouches,
  eventDates,
  eventEnd,
  isAbsence,
  isWork,
  belongs,
  todayTallinn,
  intervalStats,
  wall,
  intersect,
  minute,
  shiftMonth,
} from "./personal";
import { helpButton, euros, hoursLabel, bindHelp } from "./personal-editor";
import type { PersonalEvent } from "./personal-types";

export function eventRow(e: PersonalEvent) {
  return `<button class="personal-event-row color-${e.color}" data-edit-event="${esc(e.id)}"><span class="event-symbol" aria-hidden="true">${e.kind === "note" ? "●" : e.kind === "vacation" ? "☼" : isWork(e) ? "+" : "◇"}</span><span><b>${esc(e.title || eventLabels[e.kind])}</b><small>${e.startTime ? `${e.startTime}–${e.endTime} · ` : ""}${e.end && e.end !== e.start ? `${e.start} — ${e.end}` : !e.end && isAbsence(e) ? `${e.start} — продолжается` : e.start}${e.hours ? " · " + hoursLabel(e.hours) : ""}${e.status === "planned" && e.kind !== "note" ? " · План" : ""}</small>${e.note ? `<small>${esc(e.note)}</small>` : ""}</span><i aria-hidden="true">›</i></button>`;
}
export function activeAbsence(c: PayrollContext) {
  return c.events.find(
    (e) =>
      belongs(e, c.config.owner) &&
      isAbsence(e) &&
      e.start <= todayTallinn() &&
      (!e.end || eventEnd(e) >= todayTallinn()),
  );
}
export function activeAbsenceCard(c: PayrollContext) {
  const e = activeAbsence(c);
  if (!e) return "";
  return `<section class="active-absence"><div><small>Личный календарь ${esc(c.config.owner)}</small><b>${esc(eventLabels[e.kind])}${!e.end ? " продолжается" : ""}</b><span>С ${e.start}${e.end ? " до " + e.end : ""}</span></div><button data-edit-event="${esc(e.id)}">${e.end ? "Подробнее" : "Завершить / изменить"}</button></section>`;
}
export function decoratePersonalCalendar(
  c: PayrollContext,
  month: string,
  selectedDate: string | null,
  visibleOwner: string,
) {
  const own = !c.config.owner || visibleOwner === c.config.owner;
  const add = document.createElement("button");
  add.id = "add-personal";
  add.className = "primary";
  add.textContent = own ? "＋ Добавить" : "＋ В мой календарь";
  const tools = document.querySelector(".calendar-tools");
  if (tools) {
    const toggle = tools.querySelector(".view-switch");
    if (toggle) tools.after(toggle);
    tools.append(add);
  }
  const welcome = document.querySelector(".welcome");
  if (welcome) {
    const b = document.createElement("button");
    b.id = "add-personal";
    b.textContent = "Добавить запись без PDF";
    b.className = "calendar-button";
    welcome.querySelector("#import")?.after(b);
  }
  if (!own) return;
  if (!c.months.some((m) => m.id === month) && !c.config.syncPersonal)
    document.querySelector(".sync-card")?.remove();
  const es = c.events.filter((e) => belongs(e, c.config.owner));
  for (const cell of document.querySelectorAll<HTMLElement>("[data-day]")) {
    const date = cell.dataset.day!,
      events = es.filter((e) => eventTouches(e, date));
    if (!events.length) continue;
    const marker = document.createElement("span");
    marker.className = "personal-markers";
    marker.setAttribute("aria-hidden", "true");
    marker.innerHTML =
      events
        .slice(0, 2)
        .map(
          (e) =>
            `<i class="color-${e.color}">${e.kind === "note" ? "●" : isWork(e) ? "+" : e.kind === "vacation" ? "☼" : "◇"}</i>`,
        )
        .join("") + (events.length > 2 ? `<i>+${events.length - 2}</i>` : "");
    cell.append(marker);
    cell.classList.add("has-personal");
    if (events.some(isAbsence)) cell.classList.add("has-absence");
    cell.setAttribute(
      "aria-label",
      (cell.getAttribute("aria-label") || date) +
        "; " +
        events.map((e) => e.title || eventLabels[e.kind]).join("; "),
    );
  }
  const agenda = document.querySelector(".agenda");
  if (agenda) {
    for (const e of es.filter(
      (e) => e.start <= month + "-31" && eventEnd(e) >= month + "-01",
    )) {
      const holder = document.createElement("div");
      holder.innerHTML = eventRow(e);
      holder.firstElementChild!.setAttribute(
        "data-sort-date",
        e.start < month + "-01" ? month + "-01" : e.start,
      );
      agenda.append(holder.firstElementChild!);
    }
    const rows = [...agenda.children].filter((e) => e.matches("button"));
    if (rows.length) {
      agenda.querySelector(":scope>p")?.remove();
      rows.sort((a, b) =>
        (
          a.getAttribute("data-sort-date") ||
          a.getAttribute("data-agenda-day") ||
          ""
        ).localeCompare(
          b.getAttribute("data-sort-date") ||
            b.getAttribute("data-agenda-day") ||
            "",
        ),
      );
      rows.forEach((r) => agenda.append(r));
    }
  }
  if (!c.months.some((m) => m.id === month)) {
    const empty = document.querySelector(".empty-detail");
    if (empty)
      empty.textContent =
        "PDF не загружен. Здесь можно добавить свою запись, выход или отсутствие.";
  }
  const content = document.querySelector("#shift-details .detail-content");
  if (content && selectedDate) {
    const div = document.createElement("div");
    div.className = "personal-day-content";
    div.innerHTML =
      es
        .filter((e) => eventTouches(e, selectedDate))
        .map(eventRow)
        .join("") +
      `<button class="primary" id="add-day-personal">＋ Добавить на этот день</button>`;
    content.append(div);
    document
      .querySelector(".shift-details")
      ?.setAttribute("data-personal-panel", "true");
  }
}
export function personalSummary(
  c: PayrollContext,
  month: string,
  f = personalForecast(c, month),
) {
  const source = intervalStats(f.plan.original, month);
  return `<section class="personal-summary"><h2>Ваши изменения</h2><p class="field-hint">По личному плану и внесённой работе ${helpButton("quality")}</p><div class="pay-row"><span>По исходному графику</span><b>${hoursLabel(source.work)}</b></div><div class="pay-row"><span>Пропущено по отсутствиям</span><b>−${hoursLabel(intervalStats(f.plan.blocked, month).work)}</b></div><div class="pay-row"><span>Дополнительные выходы</span><b>${hoursLabel(f.stat.extra)}</b></div><div class="pay-row"><span>Erakorraline</span><b>${hoursLabel(f.stat.emergency)}</b></div><div class="pay-row total"><span>По плану с изменениями</span><b>${hoursLabel(f.stat.work)}</b></div><details><summary>Свои часы: ${hoursLabel(f.ownHours)}</summary>${
    c.events
      .filter((e) => e.kind === "note" && e.start.startsWith(month))
      .map(eventRow)
      .join("") || "<p>Личных часов нет.</p>"
  }</details>${periodView(f)}${c.events.some((e) => e.kind === "emergency" && e.compensation === "rest") ? '<button class="calendar-button" data-add-timeoff>Использовать компенсационный отдых</button>' : ""}${f.plan.conflicts.length ? '<p class="form-error">Есть пересечения, требующие проверки. Спорные выходы не добавлены к исходному времени.</p>' : ""}</section>`;
}
function periodView(f: PersonalForecast) {
  const p = f.period;
  return p
    ? `<details><summary>Учётный период · ${p.start} — ${p.end} ${helpButton("period")}</summary><div class="pay-row"><span>Работа без Erakorraline</span><b>${hoursLabel(p.hours)}</b></div><div class="pay-row"><span>Уменьшенная норма</span><b>${hoursLabel(p.norm)}</b></div><div class="pay-row"><span>Баланс периода</span><b>${hoursLabel(p.balance)}</b></div><p>${p.confirmed ? "Табель подтверждён вами." : p.complete ? "По графикам: итог требует подтверждения табеля." : "Не все месяцы графика доступны: итог предварительный."}${p.rest ? " Компенсация отдыхом: " + hoursLabel(p.rest) : ""}</p>${p.rest ? "<button data-add-timeoff>Использовать компенсационный отдых</button>" : ""}<button data-open-payroll>Настроить период</button></details>`
    : '<button class="calendar-button" data-open-payroll>Настроить учётный период</button>';
}
export function forecastView(
  c: PayrollContext,
  month: string,
  f = personalForecast(c, month),
) {
  const row = (s: string, v: number) =>
    `<div class="pay-row"><span>${s}</span><b>${euros(v)}</b></div>`;
  const actualWage = c.records.find((r) => r.id === month)?.wage;
  const workRows =
    actualWage !== undefined
      ? row("Заработок за работу по введённому начислению", actualWage)
      : row("Põhipalk после отсутствий", f.base) +
        (f.replacement ? row("Asendamise tasu", f.replacement) : "") +
        row(
          "Ночные, праздники и V",
          f.legacy.nightPremium +
            f.legacy.homeDutyPremium +
            f.legacy.publicHolidayPremium,
        ) +
        (f.emergency ? row("Erakorraline", f.emergency) : "") +
        (f.period?.pay
          ? row("Обычные сверхурочные · итог периода", f.period.pay)
          : "");
  const noGraph = !c.months.some((m) => m.id === month);
  return `<section class="personal-forecast"><div class="salary-head"><div><small>Оценка за период · не дата поступления</small><h2>Прогноз выплат</h2></div>${helpButton("payments")}</div>
    <h3>От работодателя</h3>${workRows}${f.vacation ? row("Отпускные", f.vacation) : ""}${f.employerBenefit ? row("Пособие по болезни", f.employerBenefit) : ""}${row("Примерно начислено · bruto", f.gross)}${row("Примерно на руки · neto", f.net)}
    ${f.lines.some((l) => l.insurer !== undefined) ? `<h3>От Tervisekassa</h3>${row("Пособия · bruto", f.insurer || 0)}${row("После подоходного налога 22%", f.insurerNet || 0)}` : ""}
    <div class="pay-row total"><span>${f.unknown ? "По рассчитанным частям" : "Всего по прогнозу"}</span><strong>≈ ${euros(f.totalNet)}</strong></div>
    ${noGraph ? '<p class="estimate-note">Нет PDF месяца. Оклад оценён; неизвестные смены и надбавки не учтены.</p>' : ""}${f.unknown ? '<p class="estimate-note">Есть неизвестные части или открытый лист. Итог не является полной суммой ожидаемого дохода.</p>' : ""}
    ${f.lines
      .filter((l) => l.rate)
      .map(
        (l) =>
          `<p class="estimate-note">${esc(l.label)}: ${l.rate!.facts ? l.rate!.facts + " мес. начислений; " : ""}графики ${l.rate!.graphs} из ${l.rate!.period.length}${l.rate!.estimated ? " · оценено " + l.rate!.estimated + " мес." : ""} ${helpButton("quality")}</p>`,
      )
      .join("")}
    <div class="forecast-actions"><button data-forecast-details="${month}">Как посчитано</button><button data-open-payroll>Уточнить данные</button></div>
    </section>`;
}
export function openForecastDetails(c: PayrollContext, month: string) {
  const f = personalForecast(c, month);
  openDialog(
    `<div class="dialog-panel"><div class="dialog-head"><h2>Как посчитано</h2><button id="forecast-close" aria-label="Закрыть">×</button></div><div class="dialog-content personal-form"><p>${month} · ${esc(c.config.owner)} · правила 30.10.2026</p><p>Норма месяца ${f.legacy.normHours} ч. Часовая ставка: ${f.settings.baseSalary} / ${f.legacy.normHours} = ${f.legacy.hourlyRate.toFixed(4)} €. Ночные: ${hoursLabel(f.stat.night)} × ${euros(f.legacy.nightHourlyPremium)}. Erakorraline: часы × часовая ставка × 1,5; праздничная надбавка и ночные добавляются отдельно, базовая оплата не дублируется.</p>${f.lines.map((l) => `<section class="payment-detail"><h3>${esc(l.label)}</h3><p>Оплачиваемых дней: ${l.days}. Работодатель: ${euros(l.employer)}${l.insurer !== undefined ? " · Tervisekassa: " + euros(l.insurer) : ""}</p>${l.rate ? `<p>Период базы: ${l.rate.period[0] || "—"} — ${l.rate.period.at(-1) || "—"}. Введено: ${l.rate.facts}; по PDF: ${l.rate.graphs}; оценено: ${l.rate.estimated} мес.</p>${l.rate.notes.map((n) => `<p class="estimate-note">${esc(n)}</p>`).join("")}` : ""}${l.notes.map((n) => `<p>${esc(n)}</p>`).join("")}${l.paymentDate ? `<p>Ожидаемая дата: ${l.paymentDate}</p>` : "<p>Дата поступления не подтверждена.</p>"}${c.events.find((e) => e.id === l.id)?.paid !== undefined ? `<p>Фактически получено: ${euros(c.events.find((e) => e.id === l.id)!.paid!)} · ${c.events.find((e) => e.id === l.id)?.paidDate || "дата не указана"}. Эта сумма не пересчитывается новым PDF.</p>` : ""}<button data-edit-event="${esc(l.id)}">Изменить запись / ставку</button></section>`).join("") || "<p>Новые периоды отсутствия не внесены.</p>"}<p>Зарплатные удержания применены к зарплате и отпускным; стандартное пособие работодателя исключено из пенсионных и страховых взносов. Необлагаемый минимум работодателя используется один раз. У Tervisekassa отдельный подоходный налог.</p><p>PDF содержит план. Приближённые начисления не являются официальным табелем или обещанием даты выплаты. Фактически полученные суммы сохраняются отдельно.</p><button data-open-payroll>Периоды и начисления</button></div></div>`,
    "settings",
  );
  document
    .querySelector("#forecast-close")!
    .addEventListener("click", () =>
      document.querySelector<HTMLDialogElement>("#dialog")!.close(),
    );
  bindHelp();
}
