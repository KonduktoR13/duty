import { storage } from "./db";
import { esc, openDialog, closeDialog } from "./ui";
import {
  eventSchema,
  personalSettingsSchema,
  payrollRecordSchema,
  type PersonalEvent,
  type PersonalSettings,
} from "./personal-types";
import {
  type PayrollContext,
  personalForecast,
  personalPlan,
  eventBounds,
  intersect,
  isWork,
  isAbsence,
  eventDates,
  eventEnd,
  eventLabels,
  todayTallinn,
  wall,
  minute,
  vacationAnchor,
  absenceRanges,
  monthDays,
  periodBalance,
  shiftMonth,
  holiday,
  dates,
} from "./personal";

export const euros = (n: number) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR" }).format(
    n,
  );
export const hoursLabel = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n) + " ч";
const field = (
  label: string,
  name: string,
  value: string | number = "",
  type = "text",
  extra = "",
) =>
  `<label><span>${label}</span><input name="${name}" type="${type}" value="${esc(String(value))}" ${extra}></label>`;
const options = (
  name: string,
  value: string,
  values: Array<[string, string]>,
) =>
  `<select name="${name}">${values.map(([k, l]) => `<option value="${k}"${k === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const select = (
  label: string,
  name: string,
  value: string,
  values: Array<[string, string]>,
) => `<label><span>${label}</span>${options(name, value, values)}</label>`;
const helpTexts: Record<string, [string, string, string?]> = {
  type: [
    "Как выбрать выход",
    "Erakorraline — оформленная работодателем чрезвычайная сверхурочная работа. Дополнительный выход учитывается в вашем учётном периоде: сам факт работы вне PDF не означает немедленную оплату ×1,5. Дата предупреждения сама по себе не определяет категорию.",
    "https://www.rescue.ee/et/palgaandmed",
  ],
  absence: [
    "Как уменьшается зарплата",
    "Если заболели после утверждения графика, учитываются пропущенные рабочие часы. Если отсутствие уже было в утверждённом графике, применяется норма календарных дней. В свободные дни графика оклад не уменьшается. Без исходного графика расчёт остаётся оценкой.",
    "https://www.rescue.ee/et/palgaandmed",
  ],
  rates: [
    "Разные расчётные периоды",
    "Отпускные и пособие работодателя обычно рассчитываются по предшествующим шести месяцам, но для них различается число учитываемых дней. Tervisekassa использует доход прошлого календарного года исходного случая. PDF позволяет оценить доход; фактические начисления и дневные ставки можно уточнить.",
    "https://www.tooelu.ee/et/176/keskmise-tootasu-arvutamine",
  ],
  vacation: [
    "Дни отпуска",
    "Субботы и воскресенья входят в ежегодный отпуск. Национальные и государственные праздники не расходуют отпускные дни. Период среднего определяется месяцем предпоследнего рабочего дня перед отпуском, даже если деньги выплачиваются позже.",
    "https://www.tooelu.ee/et/28/puhkusetasu",
  ],
  care: [
    "Уход за ребёнком",
    "По листу с кодом 14 Tervisekassa платит с первого дня 80%, до 60 дней одного случая. По уходу за членом семьи (12) — до 7 дней; если заболел обычный ухаживающий (13) — до 10. Смена родителя не начинает лимит заново. Основание сверяйте с официальным листом.",
    "https://tervisekassa.ee/huvitiste-vordlustabel",
  ],
  period: [
    "Учётный период",
    "Плюс часов одного месяца не всегда является сверхурочными: важны начало, длительность периода и его уменьшенная норма. Erakorraline оплачивается отдельно и не начисляется второй раз. Для итогового расчёта нужны все месяцы и подтверждение табеля.",
    "https://www.tooelu.ee/et/24/tooaeg",
  ],
  quality: [
    "Что означает оценка",
    "Графики содержат план работы. Неизвестные премии, фактические отсутствия и доходы других работодателей в них не видны. Недостающие месяцы оцениваются по известному окладу и доступным надбавкам. Подтверждённые начисления заменяют оценку.",
  ],
  payments: [
    "Начисления и поступления",
    "Здесь показан прогноз за период работы или отсутствия. Деньги могут прийти позже или раньше, например отпускные до отпуска. Налоговый итог оценочный, если фактические месяцы выплаты неизвестны. Выплаты работодателя и Tervisekassa считаются отдельно.",
  ],
};
export const helpButton = (id: string, label = "Как это работает") =>
  `<button type="button" class="help-button" data-help="${id}" aria-label="${label}">?</button>`;
export function showHelp(id: string) {
  const t = helpTexts[id];
  if (!t) return;
  const opener = document.activeElement as HTMLElement;
  let d = document.querySelector<HTMLDialogElement>("#personal-help");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "personal-help";
    d.className = "help-dialog";
    document.body.append(d);
  }
  d.innerHTML = `<h2>${esc(t[0])}</h2><p>${esc(t[1])}</p>${t[2] ? `<a href="${t[2]}" target="_blank" rel="noopener">Официальный источник ↗</a>` : ""}<button class="primary">Понятно</button>`;
  d.setAttribute("aria-label", t[0]);
  d.showModal();
  d.querySelector("button")!.focus();
  d.querySelector("button")!.onclick = () => d!.close();
  d.onclick = (e) => {
    if (e.target === d) {
      const r = d!.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d!.close();
    }
  };
  d.onclose = () => opener?.focus({ preventScroll: true });
}
export function bindHelp(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>("[data-help]").forEach(
    (b) =>
      (b.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        showHelp(b.dataset.help!);
      }),
  );
}
export type PersonalEditorHost = {
  context: () => PayrollContext;
  changed: (date?: string) => Promise<void>;
  back?: () => void;
};
export function openEventEditor(
  host: PersonalEditorHost,
  date: string,
  existing?: PersonalEvent,
  initialKind?: PersonalEvent["kind"],
) {
  const c = host.context(),
    now = Date.now();
  let draft: PersonalEvent = existing
    ? structuredClone(existing)
    : eventSchema.parse({
        id: crypto.randomUUID(),
        kind: "note",
        owner: c.config.owner,
        start: date,
        title: "Новая запись",
        status: date < todayTallinn() ? "confirmed" : "planned",
        createdAt: now,
        updatedAt: now,
      });
  if (!existing) {
    draft.title = "";
    if (initialKind) {
      draft.kind = initialKind;
      draft.title = eventLabels[initialKind];
      draft.end = date;
    }
  }
  let noteMode = existing?.startTime
    ? "time"
    : existing?.hours
      ? "hours"
      : "all";
  let showTypes = !existing;
  let dirty = false,
    saving = false,
    interrupt = false,
    timer: number | undefined;
  const dismiss = () => {
    if (saving) return;
    if (!dirty || confirm("Закрыть без сохранения изменений?")) {
      closeDialog();
      host.back?.();
    }
  };
  function read() {
    const form = document.querySelector<HTMLFormElement>("#event-form");
    if (!form) return;
    const f = new FormData(form),
      v = (k: string) => String(f.get(k) || ""),
      num = (k: string) =>
        v(k) === "" ? undefined : Number(v(k).replace(",", "."));
    const isNote = draft.kind === "note";
    draft = {
      ...draft,
      title: v("title"),
      start: v("start"),
      end: v("ongoing") ? "" : v("end"),
      owner: v("owner").toUpperCase().replace(/\s/g, ""),
      note: v("note"),
      status: (v("status") || draft.status) as PersonalEvent["status"],
      color: (v("color") || draft.color) as PersonalEvent["color"],
      startTime: v("startTime") || undefined,
      endTime: v("endTime") || undefined,
      hours: num("hours"),
      cause: (v("cause") || draft.cause) as PersonalEvent["cause"],
      absenceMode: (v("absenceMode") ||
        draft.absenceMode) as PersonalEvent["absenceMode"],
      caseStart: v("caseStart") || undefined,
      caseId: v("caseId") || undefined,
      compensation: (v("compensation") ||
        draft.compensation) as PersonalEvent["compensation"],
      baseAlreadyPaid: f.has("baseAlreadyPaid"),
      rateMode: (v("rateMode") || draft.rateMode) as PersonalEvent["rateMode"],
      daily: num("daily"),
      employerDaily: num("employerDaily"),
      total: num("total"),
      paymentDate: v("paymentDate") || undefined,
      paymentTiming: (v("paymentTiming") ||
        draft.paymentTiming) as PersonalEvent["paymentTiming"],
      paid: num("paid"),
      paidDate: v("paidDate") || undefined,
      linkConfirmed: v("linkConfirmed") === "on",
      linkedKey: v("linkedKey") || undefined,
    };
    if (!draft.end) draft.end = undefined;
    if (draft.kind === "sick" || draft.kind === "care")
      draft.status = draft.start <= todayTallinn() ? "confirmed" : "planned";
    if (isNote && noteMode !== "time") {
      draft.startTime = undefined;
      draft.endTime = undefined;
      draft.end = draft.start;
    }
    if (isNote && noteMode !== "hours") draft.hours = undefined;
    interrupt = v("interrupt") === "on";
  }
  const preview = () => {
    const el = document.querySelector<HTMLElement>("#event-preview");
    if (!el) return;
    const parsed = eventSchema.safeParse(draft);
    if (!parsed.success) {
      el.textContent = "Заполните даты и время, чтобы увидеть расчёт.";
      return;
    }
    if (draft.kind === "note") {
      el.textContent = draft.hours
        ? `+${hoursLabel(draft.hours)} в «Свои часы». На зарплату не влияет.`
        : "Личная запись. На зарплату не влияет.";
      return;
    }
    const forecast = personalForecast(
      {
        ...c,
        config: { ...c.config, owner: draft.owner },
        events: [...c.events.filter((e) => e.id !== draft.id), parsed.data],
      },
      draft.start.slice(0, 7),
    );
    const before = personalForecast(
      { ...c, config: { ...c.config, owner: draft.owner } },
      draft.start.slice(0, 7),
    );
    if (isWork(draft))
      el.textContent = `${hoursLabel((eventBounds(draft).end - eventBounds(draft).start) / 60)} · ${draft.compensation === "rest" ? "Компенсация отдыхом" : `Изменение bruto работодателя: ≈ ${euros(forecast.gross - before.gross)}`} · ${draft.status === "planned" ? "План" : "Внесённая работа"}`;
    else {
      const line = forecast.lines.find((l) => l.id === draft.id);
      el.textContent = `${draft.kind === "vacation" ? eventDates(draft).filter((d) => !holiday(d)).length + " дн. отпуска" : eventDates(draft).length + " календарных дн."} · ${line ? `Пособие/отпускные в месяце: ≈ ${euros(line.employer + (line.insurer || 0))}` : "Оплачиваемый отдых"}${forecast.unknown ? " · Есть неизвестные части" : ""}`;
    }
  };
  function render() {
    const work = isWork(draft),
      absence = isAbsence(draft),
      sick = draft.kind === "sick" || draft.kind === "care";
    const plan = personalPlan(
      c.months,
      draft.owner,
      c.events.filter((e) => e.id !== draft.id),
    );
    const bounds =
      draft.startTime && draft.endTime ? eventBounds(draft) : undefined;
    const match = bounds
      ? plan.original.find(
          (i) => i.start === bounds.start && i.end === bounds.end,
        )
      : undefined;
    if (match) draft.linkedKey = match.key;
    const overlapsVacation = sick
      ? c.events.filter(
          (e) =>
            e.kind === "vacation" &&
            eventDates(e).some((d) => d >= draft.start && d <= eventEnd(draft)),
        )
      : [];
    const commonDates =
      field("Начало", "start", draft.start, "date", "required") +
      (sick
        ? `<label class="check-line"><input name="ongoing" type="checkbox"${!draft.end ? " checked" : ""}> Ещё продолжается</label>`
        : "") +
      (draft.kind === "note" && noteMode !== "time"
        ? ""
        : field(
            absence ? "Последний день включительно" : "Окончание",
            "end",
            draft.end || draft.start,
            "date",
            sick && !draft.end ? "disabled" : "required",
          ));
    openDialog(
      `<div class="dialog-panel"><div class="dialog-head"><h2>${existing ? "Изменить запись" : "Добавить запись"}</h2><button type="button" id="event-close" aria-label="Закрыть">×</button></div><form id="event-form" class="dialog-content personal-form">
    ${existing ? `<b>${esc(eventLabels[draft.kind])}</b>` : showTypes ? `<div class="event-type-choices">${(["note", "emergency", "extra", "sick", "vacation"] as const).map((k) => `<button type="button" data-event-kind="${k}" aria-pressed="${draft.kind === k}">${eventLabels[k]}</button>`).join("")}</div>` : `<button type="button" id="change-event-type" class="type-current">${eventLabels[draft.kind]} · изменить</button>`}
    ${draft.kind === "sick" || draft.kind === "care" ? `<div class="choice-pair"><button type="button" data-absence-kind="sick" aria-pressed="${draft.kind === "sick"}">Болею сам</button><button type="button" data-absence-kind="care" aria-pressed="${draft.kind === "care"}">Ухаживаю за ребёнком</button></div>` : ""}
    ${c.config.owner ? `<input type="hidden" name="owner" value="${esc(draft.owner || c.config.owner)}"><small>Мой календарь · ${esc(c.config.owner)}</small>` : field("Личный D-номер", "owner", draft.owner, "text", 'placeholder="Например, D12" pattern="D[0-9]+" ' + (draft.kind === "note" ? "" : "required"))}
    ${
      draft.kind === "note"
        ? field(
            "Название",
            "title",
            draft.title,
            "text",
            'required maxlength="200" autofocus',
          ) +
          select("Когда", "noteMode", noteMode, [
            ["all", "Весь день"],
            ["time", "Время"],
            ["hours", "Только часы"],
          ])
        : `<input type="hidden" name="title" value="${esc(draft.title || eventLabels[draft.kind])}">`
    }
    <div class="date-fields">${commonDates}</div>
    ${work || draft.kind === "timeoff" || (draft.kind === "note" && noteMode === "time") ? `<div class="choice-pair">${field("Начало, время", "startTime", draft.startTime || "08:00", "time", "required")}${field("Окончание, время", "endTime", draft.endTime || "20:00", "time", "required")}</div>${work ? `<div class="duration-buttons">${[4, 8, 12, 24].map((n) => `<button type="button" data-duration="${n}">${n} ч</button>`).join("")}</div>` : ""}` : ""}
    ${draft.kind === "note" && noteMode === "hours" ? field("Свои часы", "hours", draft.hours || "", "text", 'inputmode="decimal" placeholder="Например, 4,5"') : ""}
    ${
      work || draft.kind === "vacation"
        ? select("Статус", "status", draft.status, [
            ["planned", "Планирую"],
            ["confirmed", work ? "Отработан" : "Подтверждён"],
          ])
        : ""
    }
    ${
      draft.kind === "sick"
        ? select("Причина листа", "cause", draft.cause, [
            ["illness", "Обычная болезнь / бытовая травма"],
            ["special", "Особая причина — ставка подтверждена отдельно"],
          ])
        : ""
    }
    ${
      draft.kind === "care"
        ? select(
            `Основание листа ${helpButton("care")}`,
            "cause",
            draft.cause === "illness" ? "14" : draft.cause,
            [
              ["14", "Больной ребёнок до 12 лет / инвалидность до 19"],
              ["12", "Больной член семьи"],
              ["13", "Заболел обычный ухаживающий"],
              ["special", "Другое основание"],
            ],
          )
        : ""
    }
    ${
      work
        ? `<div class="field-hint">${helpButton("type")} Категория определяется оформлением работодателя.</div>${
            draft.kind === "emergency"
              ? select("Компенсация", "compensation", draft.compensation, [
                  [
                    "money",
                    draft.kind === "emergency"
                      ? "Деньгами ×1,5"
                      : "Как настроено в учётном периоде",
                  ],
                  ["rest", "Отдыхом"],
                ])
              : '<p class="field-hint">Компенсация обычных сверхурочных задаётся для всего учётного периода в «Периоды и начисления».</p>'
          }`
        : ""
    }
    ${draft.kind === "emergency" ? `<details><summary>Уточнить уже оплаченную часть</summary><label class="check-line"><input type="checkbox" name="baseAlreadyPaid"${draft.baseAlreadyPaid ? " checked" : ""}> Базовая оплата этих часов ×1 уже начислена отдельно</label><small>Тогда добавляем только оставшиеся ×0,5. Связь с PDF сама по себе не подтверждает оплату.</small></details>` : ""}
    ${match ? `<label class="check-line"><input name="linkConfirmed" type="checkbox"${draft.linkConfirmed ? " checked" : ""}> Это та же смена из PDF — считать время один раз</label><input type="hidden" name="linkedKey" value="${esc(match.key)}">` : ""}
    ${work ? `<button type="button" class="text-button" id="after-shift">Начать после смены этого дня</button>` : ""}
    ${
      absence
        ? `<details><summary>Расчёт и выплата ${helpButton("rates")}</summary>
      ${
        draft.kind !== "timeoff"
          ? select(
              `Отсутствие и график ${helpButton("absence")}`,
              "absenceMode",
              draft.absenceMode,
              [
                ["schedule", "Возникло после утверждения: пропущенные часы"],
                ["calendar", "Уже было в графике: календарная норма"],
              ],
            )
          : ""
      }
      ${sick ? field("Начало исходного случая (если продолжение)", "caseStart", draft.caseStart || draft.start, "date") + select("Связать с продолжением случая", "caseId", draft.caseId || "", [["", "Новый случай / по дате начала"], ...c.events.filter((e) => e.kind === draft.kind && e.id !== draft.id).map((e) => [e.caseId || e.id, `${e.start} · ${eventLabels[e.kind]}`] as [string, string])]) : ""}
      ${
        draft.kind !== "timeoff"
          ? select("Источник дневной ставки", "rateMode", draft.rateMode, [
              ["auto", "Оценить по истории и графикам"],
              ["income", "Ввести дневной доход до процента"],
              ["benefit", "Ввести готовое пособие/отпускные за день"],
              ...(draft.kind === "vacation"
                ? ([
                    ["saved", "Сохранённая ставка отпускных"],
                    ["preserve", "Сохранение неизменного заработка"],
                  ] as Array<[string, string]>)
                : []),
            ]) +
            `<div class="rate-fields">${field("Дневная ставка, bruto €", "daily", draft.daily ?? "", "text", 'inputmode="decimal"')}${draft.kind === "sick" ? field("Средний дневной заработок работодателя до 70%, €", "employerDaily", draft.employerDaily ?? "", "text", 'inputmode="decimal"') : ""}${field(draft.kind === "vacation" ? "Подтверждённые отпускные за весь период, €" : "Подтверждённое пособие Tervisekassa за свой период, €", "total", draft.total ?? "", "text", 'inputmode="decimal"')}</div>`
          : ""
      }
      ${select("Когда выплата", "paymentTiming", draft.paymentTiming, [
        ["unknown", "Пока неизвестно"],
        ["before", "Перед отпуском"],
        ["salary", "Вместе с зарплатой"],
      ])}${field("Ожидаемая дата выплаты", "paymentDate", draft.paymentDate || "", "date")}
      ${field("Фактически получено по этой записи, €", "paid", draft.paid ?? "", "text", 'inputmode="decimal"')}${field("Дата фактического получения", "paidDate", draft.paidDate || "", "date")}
      </details>`
        : ""
    }
    ${overlapsVacation.length ? '<label class="check-line"><input name="interrupt" type="checkbox"> Прервать отпуск на указанные дни листа</label>' : ""}
    ${draft.kind === "note" ? `<div><span>Цвет</span><div class="color-choices">${["purple", "blue", "green", "orange", "pink", "grey"].map((color, i) => `<label class="color-option color-${color}"><input type="radio" name="color" value="${color}"${draft.color === color ? " checked" : ""} aria-label="${["Фиолетовый", "Синий", "Зелёный", "Оранжевый", "Розовый", "Серый"][i]}"><span></span></label>`).join("")}</div></div>` : ""}
    <label><span>Заметка</span><textarea name="note" rows="2" maxlength="5000">${esc(draft.note)}</textarea></label>
    <p id="event-preview" class="event-preview" aria-live="polite"></p><p id="event-error" class="form-error" role="alert"></p>
    ${sick ? "<small>Локальная запись не открывает официальный лист. Даты должны соответствовать haigusleht / hooldusleht.</small>" : ""}
    ${existing ? '<button type="button" class="danger" id="delete-event">Удалить запись</button>' : ""}
    </form><div class="dialog-actions"><button class="primary" type="submit" form="event-form" id="save-event">Сохранить</button></div></div>`,
      "settings",
    );
    const dialog = document.querySelector<HTMLDialogElement>("#dialog")!;
    dialog.dataset.personalEditor = "true";
    const cleanup = () => {
      delete dialog.dataset.personalEditor;
      clearTimeout(timer);
    };
    dialog.addEventListener("close", cleanup, { once: true });
    dialog.oncancel = (e) => {
      e.preventDefault();
      dismiss();
    };
    document.querySelector("#event-close")!.addEventListener("click", dismiss);
    document
      .querySelectorAll<HTMLButtonElement>(
        "[data-event-kind],[data-absence-kind]",
      )
      .forEach(
        (b) =>
          (b.onclick = () => {
            read();
            const kind = (b.dataset.eventKind ||
              b.dataset.absenceKind) as PersonalEvent["kind"];
            draft = {
              ...draft,
              kind,
              title: kind === "note" ? "" : eventLabels[kind],
              end:
                kind === "sick" || kind === "care"
                  ? undefined
                  : draft.end || draft.start,
              rateMode: "auto",
              cause: kind === "care" ? "14" : "illness",
              absenceMode: kind === "vacation" ? "calendar" : "schedule",
            };
            dirty = true;
            showTypes = false;
            render();
          }),
      );
    document
      .querySelector("#change-event-type")
      ?.addEventListener("click", () => {
        read();
        showTypes = true;
        render();
      });
    const form = document.querySelector<HTMLFormElement>("#event-form")!;
    form.addEventListener("input", () => {
      read();
      dirty = true;
      clearTimeout(timer);
      timer = window.setTimeout(preview, 180);
    });
    form.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      read();
      dirty = true;
      if (t.name === "noteMode") {
        noteMode = t.value;
        render();
      } else if (t.name === "ongoing") {
        const end = form.elements.namedItem("end") as HTMLInputElement;
        end.disabled = t.checked;
        draft.end = t.checked ? undefined : end.value;
      } else if (t.name === "caseId" && draft.caseId) {
        const source = c.events.find(
          (e) => (e.caseId || e.id) === draft.caseId,
        );
        if (source) {
          draft.caseStart = source.caseStart || source.start;
          render();
        }
      }
      preview();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-duration]").forEach(
      (b) =>
        (b.onclick = () => {
          read();
          draft.startTime = draft.startTime || "08:00";
          const finish = wall(
            minute(draft.start + "T" + draft.startTime) +
              Number(b.dataset.duration) * 60,
          );
          draft.end = finish.slice(0, 10);
          draft.endTime = finish.slice(11, 16);
          dirty = true;
          showTypes = false;
          render();
        }),
    );
    document.querySelector("#after-shift")?.addEventListener("click", () => {
      read();
      const i = plan.original
        .filter(
          (i) =>
            wall(i.start).slice(0, 10) === draft.start && i.kind === "hours",
        )
        .at(-1);
      if (i) {
        draft.start = wall(i.end).slice(0, 10);
        draft.startTime = wall(i.end).slice(11, 16);
        const end = wall(i.end + 240);
        draft.end = end.slice(0, 10);
        draft.endTime = end.slice(11, 16);
        dirty = true;
        render();
      }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (saving) return;
      read();
      const error = document.querySelector<HTMLElement>("#event-error")!;
      const parsed = eventSchema.safeParse({ ...draft, updatedAt: Date.now() });
      if (!parsed.success) {
        error.textContent = parsed.error.issues[0].message;
        return;
      }
      const next = parsed.data;
      if (
        next.owner &&
        c.config.owner &&
        next.owner !== c.config.owner &&
        next.kind !== "note" &&
        !existing &&
        !confirm(
          `Изменить мой D-номер с ${c.config.owner} на ${next.owner}? Старые рабочие записи сохранят прежнюю привязку.`,
        )
      )
        return;
      let updates: PersonalEvent[] = [];
      if (interrupt && sick)
        updates = overlapsVacation.map((e) => ({
          ...e,
          excluded: [...new Set([...e.excluded, ...eventDates(next)])],
          updatedAt: Date.now(),
        }));
      const all = [
        ...c.events.filter(
          (e) => e.id !== next.id && !updates.some((u) => u.id === e.id),
        ),
        ...updates,
        next,
      ];
      const check = personalPlan(c.months, next.owner, all);
      if (
        check.conflicts.includes(next.id) ||
        (isAbsence(next) &&
          check.blocked.some(
            (i) =>
              i.eventId && absenceRanges(next).some((r) => intersect(i, r)),
          ))
      ) {
        error.textContent =
          "Есть пересечение с работой или другим отсутствием. Уточните даты, свяжите совпавшую смену или отметьте прерывание отпуска.";
        return;
      }
      saving = true;
      (document.querySelector("#save-event") as HTMLButtonElement).disabled =
        true;
      try {
        await storage.saveEvents([...updates, next]);
        if (next.owner && !c.config.owner)
          await storage.set("personalSettings", {
            ...c.config,
            owner: next.owner,
          });
        dirty = false;
        closeDialog();
        await host.changed(next.start);
      } catch (err) {
        error.textContent =
          err instanceof Error
            ? err.message
            : "Не удалось сохранить. Повторите.";
        saving = false;
        (document.querySelector("#save-event") as HTMLButtonElement).disabled =
          false;
      }
    };
    document
      .querySelector("#delete-event")
      ?.addEventListener("click", async () => {
        if (!confirm("Удалить эту запись и пересчитать прогноз?")) return;
        try {
          await storage.removeEvent(draft.id);
          dirty = false;
          closeDialog();
          await host.changed(draft.start);
          showUndo(async () => {
            await storage.putEvent(draft);
            await host.changed(draft.start);
          });
        } catch (err) {
          document.querySelector("#event-error")!.textContent = String(err);
        }
      });
    const updateRateField = () => {
      const f = form.elements.namedItem("daily") as HTMLInputElement | null;
      if (f)
        f.disabled = ["auto", "saved", "preserve"].includes(
          (form.elements.namedItem("rateMode") as HTMLSelectElement)?.value ||
            "auto",
        );
    };
    form
      .querySelector('[name="rateMode"]')
      ?.addEventListener("change", updateRateField);
    updateRateField();
    bindHelp(dialog);
    preview();
  }
  render();
}
export function showUndo(action: () => Promise<void>) {
  document.querySelector("#personal-toast")?.remove();
  const toast = document.createElement("aside");
  toast.id = "personal-toast";
  toast.setAttribute("role", "status");
  toast.innerHTML = "Запись удалена <button>Отменить</button>";
  document.body.append(toast);
  const t = window.setTimeout(() => toast.remove(), 12000);
  toast.querySelector("button")!.onclick = async () => {
    clearTimeout(t);
    await action();
    toast.remove();
  };
}

export function openPayrollSettings(
  host: PersonalEditorHost,
  month = todayTallinn().slice(0, 7),
  back?: () => void,
) {
  const c = host.context();
  let config = structuredClone(c.config);
  const record = c.records.find((r) => r.id === month);
  openDialog(
    `<div class="dialog-panel"><div class="dialog-head"><h2>Периоды и начисления</h2><button id="payroll-back" aria-label="Назад">‹</button></div><form class="dialog-content personal-form" id="payroll-form">
    <p>Достаточно заполнить известные данные. Остальное оценивается по графикам. ${helpButton("quality")}</p>
    ${field("Мой D-номер", "owner", config.owner, "text", 'pattern="D[0-9]+" placeholder="D12"')}
    <details open><summary>Учётный период ${helpButton("period")}</summary>${field("Первый день периода (первое число месяца)", "periodStart", config.periodStart || "", "date")}${select(
      "Продолжительность",
      "periodMonths",
      String(config.periodMonths),
      [1, 2, 3, 4, 6, 12].map((n) => [String(n), n + " мес."]),
    )}${select(
      "Обычные сверхурочные",
      "overtimeCompensation",
      config.overtimeCompensation,
      [
        ["money", "Деньгами ×1,5"],
        ["rest", "Отдыхом"],
      ],
    )}<label class="check-line"><input type="checkbox" name="periodConfirmed"${config.periodConfirmed && config.confirmedPeriodStart === periodBalance(c, month)?.start ? " checked" : ""}> Подтверждаю табель периода, содержащего ${month} (не будущие периоды)</label>${field("Начало службы (для неполных 6 месяцев)", "employmentStart", config.employmentStart || "", "date")}</details>
    <details><summary>Начисления за месяц ${helpButton("rates")}</summary>
      ${field("Месяц", "recordMonth", month, "month")}
      <button type="button" id="load-payroll-month">Открыть этот месяц</button>
      ${field("Заработок за работу, bruto € (без отпускных и пособий)", "wage", record?.wage ?? "", "text", 'inputmode="decimal"')}
      ${field("Доход, облагаемый социальным налогом, €", "socialIncome", record?.socialIncome ?? "", "text", 'inputmode="decimal"')}
      ${field("Дней в базе пособия работодателя", "sickDays", record?.sickDays ?? "", "number", 'min="0" max="31"')}${field("Дней в базе отпускных (без праздников)", "vacationDays", record?.vacationDays ?? "", "number", 'min="0" max="31"')}
      ${field("Когда заработок стал причитающимся", "dueDate", record?.dueDate || "", "date")}
      <small>Введите дни, только если они известны из расчёта. Пустое поле — определить по календарю и сохранённым отсутствиям.</small>
      ${record ? '<button type="button" id="delete-payroll">Убрать введённые суммы этого месяца</button>' : ""}
    </details>
    <details><summary>Годовой доход MTA для Tervisekassa</summary>${field("Год", "incomeYear", Number(month.slice(0, 4)) - 1, "number", 'min="2000" max="2099"')}${field("Социально облагаемый доход за год, €", "annualIncome", config.annualIncome[String(Number(month.slice(0, 4)) - 1)] ?? "", "text", 'inputmode="decimal"')}<button type="button" id="load-income-year">Открыть выбранный год</button><small>Общая база MTA, не neto на карту. Готовую особую дневную ставку можно указать в самом листе.</small></details>
    <details><summary>История оклада и надбавки</summary>${config.salaryHistory.map((h) => `<p>${h.from} · ${euros(h.baseSalary)} · asendamine ${h.replacementEnabled ? h.replacementPercent + "%" : "выкл."} <button type="button" data-remove-salary="${h.from}">Убрать</button></p>`).join("")}
      ${field("Добавить ставку с даты", "salaryFrom", "", "date")}${field("Оклад с этой даты, €", "baseSalary", "", "text", 'inputmode="decimal"')}${field("Asendamise tasu, % (0 = выключена)", "replacementPercent", "", "text", 'inputmode="decimal"')}
    </details>
    <details><summary>Google Calendar</summary><label class="check-line"><input name="syncPersonal" type="checkbox"${config.syncPersonal ? " checked" : ""}> Учитывать рабочие выходы и отсутствие при синхронизации</label><small>Изменения показываются перед отправкой. Причины болезни, сведения о ребёнке и суммы не передаются. Личные заметки остаются на устройстве.</small></details>
    <p id="payroll-error" class="form-error" role="alert"></p>
    </form><div class="dialog-actions"><button form="payroll-form" type="submit" class="primary">Сохранить</button></div></div>`,
    "settings",
  );
  document.querySelector("#payroll-back")!.addEventListener("click", () => {
    if (changed && !confirm("Закрыть без сохранения?")) return;
    closeDialog();
    back?.();
  });
  const form = document.querySelector<HTMLFormElement>("#payroll-form")!;
  let changed = false;
  form.oninput = () => {
    changed = true;
  };
  document.querySelector<HTMLDialogElement>("#dialog")!.oncancel = (e) => {
    if (changed && !confirm("Закрыть без сохранения?")) e.preventDefault();
  };
  document
    .querySelector("#load-payroll-month")!
    .addEventListener("click", () => {
      if (
        changed &&
        !confirm("Открыть другой месяц без сохранения текущих изменений?")
      )
        return;
      const m = (form.elements.namedItem("recordMonth") as HTMLInputElement)
        .value;
      if (m) openPayrollSettings(host, m, back);
    });
  document.querySelector("#load-income-year")!.addEventListener("click", () => {
    const y = (form.elements.namedItem("incomeYear") as HTMLInputElement).value;
    (form.elements.namedItem("annualIncome") as HTMLInputElement).value =
      String(config.annualIncome[y] ?? "");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-remove-salary]").forEach(
    (b) =>
      (b.onclick = () => {
        config.salaryHistory = config.salaryHistory.filter(
          (h) => h.from !== b.dataset.removeSalary,
        );
        b.parentElement!.remove();
        changed = true;
      }),
  );
  document
    .querySelector("#delete-payroll")
    ?.addEventListener("click", async () => {
      if (
        confirm("Удалить введённое начисление и вернуться к оценке по PDF?")
      ) {
        await storage.removePayroll(month);
        await host.changed();
        openPayrollSettings(host, month, back);
      }
    });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form),
      v = (k: string) => String(f.get(k) || ""),
      n = (k: string) =>
        v(k) === "" ? undefined : Number(v(k).replace(",", "."));
    try {
      const start = v("periodStart");
      if (start && !start.endsWith("-01"))
        throw new Error("Период должен начинаться с первого числа месяца.");
      const year = v("incomeYear");
      if (n("annualIncome") !== undefined)
        config.annualIncome[year] = n("annualIncome")!;
      if (v("salaryFrom")) {
        if (!(n("baseSalary")! > 0))
          throw new Error("Укажите положительный оклад.");
        config.salaryHistory = config.salaryHistory.filter(
          (h) => h.from !== v("salaryFrom"),
        );
        config.salaryHistory.push({
          from: v("salaryFrom"),
          baseSalary: n("baseSalary")!,
          replacementEnabled: !!n("replacementPercent"),
          replacementPercent: n("replacementPercent") || 0,
        });
      }
      config = personalSettingsSchema.parse({
        ...config,
        owner: v("owner").toUpperCase().replace(/\s/g, ""),
        periodStart: start || undefined,
        periodMonths: Number(v("periodMonths")),
        periodConfirmed: f.has("periodConfirmed"),
        overtimeCompensation: v("overtimeCompensation"),
        employmentStart: v("employmentStart") || undefined,
        syncPersonal: f.has("syncPersonal"),
      });
      if (config.periodConfirmed && config.periodStart) {
        let first = config.periodStart.slice(0, 7);
        let guard = 0;
        while (first > month && guard++ < 600)
          first = shiftMonth(first, -config.periodMonths);
        while (shiftMonth(first, config.periodMonths) <= month && guard++ < 600)
          first = shiftMonth(first, config.periodMonths);
        config.confirmedPeriodStart = first + "-01";
      } else config.confirmedPeriodStart = undefined;
      const recordData = {
        id: v("recordMonth"),
        wage: n("wage"),
        socialIncome: n("socialIncome"),
        sickDays: n("sickDays"),
        vacationDays: n("vacationDays"),
        dueDate: v("dueDate") || undefined,
      };
      const pay = payrollRecordSchema.parse(recordData);
      await storage.savePayrollSettings(
        config,
        Object.values(recordData).some((x, i) => i > 0 && x !== undefined)
          ? pay
          : undefined,
      );
      closeDialog();
      await host.changed();
      back?.();
    } catch (err) {
      document.querySelector("#payroll-error")!.textContent =
        err instanceof Error ? err.message : "Проверьте значения";
    }
  };
  bindHelp(form);
}
