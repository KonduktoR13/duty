import type {
  CalendarEventDraft,
  DayMark,
  MonthRecord,
  SalarySettings,
} from "./types";
import type {
  PersonalEvent,
  PersonalSettings,
  PayrollRecord,
} from "./personal-types";
import { allMarksForDelta, candidateForMonth } from "./roster";
import { workIntervals, tallinnWallTime } from "./intervals";
import {
  monthlyWorkNorm,
  isEstonianPublicHoliday,
  roundMoney,
  salaryForecast,
} from "./salary-calculation";

export const PERSONAL_RULE_EDITION = "2026-10-30";
export const eventLabels: Record<PersonalEvent["kind"], string> = {
  note: "Своя запись",
  emergency: "Erakorraline",
  extra: "Дополнительный выход",
  sick: "Больничный",
  care: "Уход за ребёнком",
  vacation: "Отпуск",
  timeoff: "Компенсационный отдых",
};
export const todayTallinn = () => tallinnWallTime().slice(0, 10);
export const minute = (s: string) =>
  Date.parse(
    s.length === 10 ? s + "T00:00:00Z" : s + (s.endsWith("Z") ? "" : "Z"),
  ) / 60000;
export const wall = (n: number) =>
  new Date(n * 60000).toISOString().slice(0, 19);
export const shiftDay = (date: string, n: number) =>
  wall(minute(date) + n * 1440).slice(0, 10);
export function shiftMonth(month: string, n: number) {
  const d = new Date(month + "-01T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
export function dates(start: string, end: string) {
  const result: string[] = [];
  for (let d = start; d <= end && result.length < 4000; d = shiftDay(d, 1))
    result.push(d);
  return result;
}
export const monthDays = (m: string) =>
  dates(m + "-01", shiftDay(shiftMonth(m, 1) + "-01", -1));
export const holiday = (d: string) => isEstonianPublicHoliday(d);
export function eventEnd(e: PersonalEvent, today = todayTallinn()) {
  return e.end || (today < e.start ? e.start : today);
}
export const isWork = (e: PersonalEvent) =>
  e.kind === "extra" || e.kind === "emergency";
export const isAbsence = (e: PersonalEvent) =>
  ["sick", "care", "vacation", "timeoff"].includes(e.kind);
export function eventDates(e: PersonalEvent, today = todayTallinn()) {
  return dates(e.start, eventEnd(e, today)).filter(
    (d) => !e.excluded.includes(d),
  );
}
export function eventTouches(
  e: PersonalEvent,
  d: string,
  today = todayTallinn(),
) {
  return e.start <= d && eventEnd(e, today) >= d && !e.excluded.includes(d);
}
export function belongs(e: PersonalEvent, owner: string) {
  return e.kind === "note" || !e.owner || e.owner === owner;
}
export type PersonalInterval = {
  key: string;
  start: number;
  end: number;
  kind: "hours" | "home";
  raw: string;
  source: "pdf" | "extra" | "emergency";
  eventId?: string;
  incomplete?: boolean;
};
export type Plan = {
  original: PersonalInterval[];
  work: PersonalInterval[];
  blocked: PersonalInterval[];
  conflicts: string[];
  events: PersonalEvent[];
};
export function eventBounds(e: PersonalEvent) {
  return {
    start: minute(e.start + "T" + (e.startTime || "00:00")),
    end: e.endTime
      ? minute((e.end || e.start) + "T" + e.endTime)
      : minute(shiftDay(eventEnd(e), 1)),
  };
}
export function intersect(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}
export function clip(i: PersonalInterval, start: number, end: number) {
  const a = Math.max(i.start, start),
    b = Math.min(i.end, end);
  return b > a ? { ...i, start: a, end: b } : null;
}
function subtract(
  i: PersonalInterval,
  ranges: Array<{ start: number; end: number }>,
) {
  let parts = [i];
  for (const r of ranges)
    parts = parts.flatMap((p) =>
      intersect(p, r)
        ? [
            p.start < r.start ? { ...p, end: r.start } : null,
            p.end > r.end ? { ...p, start: r.end } : null,
          ].filter((x): x is PersonalInterval => x !== null)
        : [p],
    );
  return parts;
}
export function absenceRanges(e: PersonalEvent, today = todayTallinn()) {
  return e.kind === "timeoff" && e.startTime && e.endTime
    ? [eventBounds(e)]
    : eventDates(e, today).map((d) => ({
        start: minute(d),
        end: minute(shiftDay(d, 1)),
      }));
}
export function clockChange(e: PersonalEvent) {
  if (!isWork(e)) return false;
  return eventDates(e).some((d) => {
    const n = new Date(d + "T12:00:00Z");
    return (
      [2, 9].includes(n.getUTCMonth()) &&
      n.getUTCDay() === 0 &&
      new Date(shiftDay(d, 7) + "T12:00:00Z").getUTCMonth() !==
        n.getUTCMonth() &&
      intersect(eventBounds(e), {
        start: minute(d + "T03:00"),
        end: minute(d + "T04:00"),
      }) > 0
    );
  });
}
export function personalPlan(
  months: MonthRecord[],
  owner: string,
  all: PersonalEvent[],
  today = todayTallinn(),
): Plan {
  const events = all.filter((e) => belongs(e, owner));
  const original: PersonalInterval[] = workIntervals(
    allMarksForDelta(months, owner),
  ).map((i) => ({
    key: i.key,
    start: minute(i.start.dateTime),
    end: minute(i.end.dateTime),
    kind: i.kind,
    raw: i.raw,
    source: "pdf",
    incomplete: i.incomplete,
  }));
  let work = [...original];
  const conflicts: string[] = [];
  for (const e of events
    .filter(isWork)
    .sort((a, b) => a.createdAt - b.createdAt)) {
    const b = eventBounds(e);
    const overlaps = work.filter((i) => intersect(i, b));
    if (
      e.linkConfirmed &&
      !original.some(
        (i) => i.key === e.linkedKey && i.start === b.start && i.end === b.end,
      )
    )
      conflicts.push(e.id);
    const linked =
      overlaps.length === 1 &&
      overlaps[0].source === "pdf" &&
      overlaps[0].key === e.linkedKey &&
      e.linkConfirmed &&
      b.start === overlaps[0].start &&
      b.end === overlaps[0].end;
    if (overlaps.length && !linked) {
      conflicts.push(e.id);
      continue;
    }
    if (linked) work = work.filter((i) => i !== overlaps[0]);
    work.push({
      ...b,
      key: linked ? overlaps[0].key : "manual:" + e.id,
      raw: e.kind === "emergency" ? "Erakorraline" : "+",
      kind: "hours",
      source: e.kind as "extra" | "emergency",
      eventId: e.id,
    });
  }
  const absences = events.filter(isAbsence);
  const ranges = absences.flatMap((e) =>
    absenceRanges(e, today).map((r) => ({ ...r, id: e.id })),
  );
  for (let i = 0; i < ranges.length; i++)
    for (let j = i + 1; j < ranges.length; j++)
      if (ranges[i].id !== ranges[j].id && intersect(ranges[i], ranges[j]))
        conflicts.push(ranges[i].id, ranges[j].id);
  const blocked = work.flatMap((i) =>
    ranges
      .map((r) => clip(i, r.start, r.end))
      .filter((p): p is PersonalInterval => p !== null),
  );
  for (const i of blocked) if (i.eventId) conflicts.push(i.eventId);
  work = work
    .flatMap((i) => subtract(i, ranges))
    .sort((a, b) => a.start - b.start);
  return {
    original,
    work,
    blocked,
    conflicts: [...new Set(conflicts)],
    events,
  };
}
export function intervalStats(values: PersonalInterval[], month?: string) {
  const start = month ? minute(month + "-01") : -Infinity,
    end = month ? minute(shiftMonth(month, 1) + "-01") : Infinity;
  let work = 0,
    home = 0,
    night = 0,
    festive = 0,
    emergency = 0,
    extra = 0;
  for (const i of values) {
    const c = clip(i, start, end);
    if (!c) continue;
    if (i.kind === "home") {
      home += c.end - c.start;
      continue;
    }
    work += c.end - c.start;
    if (i.source === "emergency") emergency += c.end - c.start;
    if (i.source === "extra") extra += c.end - c.start;
    for (let cursor = c.start; cursor < c.end; ) {
      const d = wall(cursor).slice(0, 10),
        dayStart = minute(d),
        mod = cursor - dayStart;
      const bound = mod < 360 ? 360 : mod < 1320 ? 1320 : 1440;
      const next = Math.min(c.end, dayStart + bound);
      if (mod < 360 || mod >= 1320) night += next - cursor;
      if (holiday(d)) festive += next - cursor;
      cursor = next;
    }
  }
  return {
    work: work / 60,
    home: home / 60,
    night: night / 60,
    festive: festive / 60,
    emergency: emergency / 60,
    extra: extra / 60,
  };
}
export function ownHours(events: PersonalEvent[], month: string) {
  return events
    .filter((e) => e.kind === "note")
    .reduce((sum, e) => {
      if (e.startTime && e.endTime)
        return (
          sum +
          Math.max(
            0,
            Math.min(eventBounds(e).end, minute(shiftMonth(month, 1) + "-01")) -
              Math.max(eventBounds(e).start, minute(month + "-01")),
          ) /
            60
        );
      return sum + (e.start.startsWith(month) ? e.hours || 0 : 0);
    }, 0);
}
export function vacationAnchor(start: string) {
  let d = start,
    count = 0;
  while (count < 2) {
    d = shiftDay(d, -1);
    const w = new Date(d + "T12:00:00Z").getUTCDay();
    if (w !== 0 && w !== 6 && !holiday(d)) count++;
  }
  return d;
}
export function applicableSalary(
  settings: SalarySettings,
  config: PersonalSettings,
  date: string,
) {
  const h = config.salaryHistory
    .filter((h) => h.from <= date)
    .sort((a, b) => b.from.localeCompare(a.from))[0];
  return h
    ? {
        ...settings,
        baseSalary: h.baseSalary,
        replacementEnabled: h.replacementEnabled,
        replacementPercent: h.replacementPercent,
      }
    : settings;
}
export type PayrollContext = {
  months: MonthRecord[];
  events: PersonalEvent[];
  settings: SalarySettings;
  config: PersonalSettings;
  records: PayrollRecord[];
  today?: string;
};
function contextEvents(c: PayrollContext) {
  return c.events.filter((e) => belongs(e, c.config.owner));
}
export function absenceReduction(
  c: PayrollContext,
  month: string,
  plan = personalPlan(c.months, c.config.owner, c.events, c.today),
) {
  const ds = monthDays(month),
    norm = monthlyWorkNorm(month).hours;
  const manualDays = new Set(
    plan.events
      .filter(isAbsence)
      .flatMap((e) => eventDates(e, c.today))
      .filter((d) => d.startsWith(month)),
  );
  const pdfP = new Set(
    allMarksForDelta(c.months, c.config.owner)
      .filter(
        (m) => m.date.startsWith(month) && m.kind === "leave" && m.raw === "P",
      )
      .map((m) => m.date),
  );
  let hours = 0;
  for (const d of ds) {
    const e = plan.events.find(
      (e) => isAbsence(e) && eventTouches(e, d, c.today),
    );
    if (e?.kind === "timeoff") continue; // Paid compensatory rest preserves base salary.
    if (e)
      hours +=
        e.absenceMode === "calendar" ||
        !c.months.some(
          (m) => m.id === month && candidateForMonth(m, c.config.owner),
        )
          ? norm / ds.length
          : plan.original.reduce(
              (s, i) =>
                s +
                (i.kind === "hours"
                  ? intersect(i, {
                      start: minute(d),
                      end: minute(shiftDay(d, 1)),
                    }) / 60
                  : 0),
              0,
            );
    else if (pdfP.has(d) && !manualDays.has(d) && !holiday(d))
      hours += norm / ds.length;
  }
  return {
    hours: Math.min(norm, hours),
    days: new Set([...manualDays, ...pdfP]),
  };
}
function earnedMonth(c: PayrollContext, month: string) {
  const settings = applicableSalary(c.settings, c.config, month + "-01");
  const plan = personalPlan(c.months, c.config.owner, c.events, c.today);
  const stat = intervalStats(plan.work, month),
    reduction = absenceReduction(c, month, plan);
  const legacy = salaryForecast(month, stat.night, settings, {
    homeDutyHours: stat.home,
    publicHolidayHours: stat.festive,
  });
  let base = roundMoney(
    Math.max(0, settings.baseSalary - legacy.hourlyRate * reduction.hours),
  );
  let replacement = settings.replacementEnabled
    ? roundMoney((base * settings.replacementPercent) / 100)
    : 0;
  const emergencyHours = plan.work.filter(
    (i) =>
      i.source === "emergency" &&
      plan.events.find((e) => e.id === i.eventId)?.compensation === "money",
  );
  let emergency = roundMoney(
    emergencyHours.reduce(
      (sum, i) =>
        sum +
        intervalStats([i], month).work *
          legacy.hourlyRate *
          (plan.events.find((e) => e.id === i.eventId)?.baseAlreadyPaid
            ? 0.5
            : 1.5),
      0,
    ),
  );
  if (
    c.config.salaryHistory.some(
      (h) => h.from.startsWith(month) && !h.from.endsWith("-01"),
    )
  ) {
    let dailyBase = 0,
      dailyReplacement = 0,
      night = 0,
      home = 0,
      festive = 0,
      extraPay = 0;
    const ds = monthDays(month),
      norm = monthlyWorkNorm(month).hours;
    for (const d of ds) {
      const st = applicableSalary(c.settings, c.config, d),
        rate = st.baseSalary / norm;
      const current = plan.work
        .map((i) => clip(i, minute(d), minute(shiftDay(d, 1))))
        .filter((i): i is PersonalInterval => !!i);
      const stats = intervalStats(current);
      const absence = plan.events.find(
        (e) => isAbsence(e) && eventTouches(e, d, c.today),
      );
      const p = allMarksForDelta(c.months, c.config.owner).some(
        (m) => m.date === d && m.kind === "leave" && m.raw === "P",
      );
      const missed =
        absence?.kind === "timeoff"
          ? 0
          : absence
            ? absence.absenceMode === "calendar" ||
              !c.months.some(
                (m) => m.id === month && candidateForMonth(m, c.config.owner),
              )
              ? norm / ds.length
              : plan.original.reduce(
                  (s, i) =>
                    s +
                    (i.kind === "hours"
                      ? intersect(i, {
                          start: minute(d),
                          end: minute(shiftDay(d, 1)),
                        }) / 60
                      : 0),
                  0,
                )
            : p && !holiday(d)
              ? norm / ds.length
              : 0;
      const dayBase = st.baseSalary / ds.length - rate * missed;
      dailyBase += dayBase;
      dailyReplacement += st.replacementEnabled
        ? (dayBase * st.replacementPercent) / 100
        : 0;
      night += roundMoney(rate * 0.25) * stats.night;
      home += roundMoney((rate * st.homeDutyPercent) / 100) * stats.home;
      festive += roundMoney(rate) * stats.festive;
      extraPay += current
        .filter(
          (i) =>
            i.source === "emergency" &&
            plan.events.find((e) => e.id === i.eventId)?.compensation ===
              "money",
        )
        .reduce(
          (s, i) =>
            s +
            ((i.end - i.start) / 60) *
              rate *
              (plan.events.find((e) => e.id === i.eventId)?.baseAlreadyPaid
                ? 0.5
                : 1.5),
          0,
        );
    }
    base = roundMoney(Math.max(0, dailyBase));
    replacement = roundMoney(Math.max(0, dailyReplacement));
    emergency = roundMoney(extraPay);
    legacy.nightPremium = roundMoney(night);
    legacy.homeDutyPremium = roundMoney(home);
    legacy.publicHolidayPremium = roundMoney(festive);
  }
  const wage = roundMoney(
    base +
      replacement +
      legacy.nightPremium +
      legacy.homeDutyPremium +
      legacy.publicHolidayPremium +
      emergency,
  );
  return {
    wage,
    variable: roundMoney(wage - base - replacement),
    settings,
    plan,
    stat,
    reduction,
    base,
    replacement,
    legacy,
    emergency,
  };
}
export type RateEstimate = {
  value?: number;
  period: string[];
  facts: number;
  graphs: number;
  estimated: number;
  notes: string[];
  preservedWage?: number;
};
export function averageRate(
  c: PayrollContext,
  anchor: string,
  vacation: boolean,
): RateEstimate {
  let period = Array.from({ length: 6 }, (_, i) =>
    shiftMonth(anchor.slice(0, 7), i - 6),
  );
  if (c.config.employmentStart)
    period = period.filter((m) => m >= c.config.employmentStart!.slice(0, 7));
  const data = period.map((m) => ({
    m,
    record: c.records.find((r) => r.id === m),
    graph: !!candidateForMonth(
      (c.months.find((x) => x.id === m) as MonthRecord) || {
        id: m,
        shifts: [],
        deltaNumber: "",
      },
      c.config.owner,
    ),
    estimate: earnedMonth(c, m),
  }));
  const usable = data.filter((x) => x.record?.wage !== undefined || x.graph);
  const variable = usable.length
    ? usable.reduce(
        (s, x) =>
          s +
          (x.record?.wage !== undefined
            ? Math.max(
                0,
                x.record.wage - x.estimate.base - x.estimate.replacement,
              )
            : x.estimate.variable),
        0,
      ) / usable.length
    : undefined;
  const notes = [
    "PDF показывает план, не фактический табель. Неизвестные премии и отсутствия не учтены.",
  ];
  let total = 0,
    divisor = 0,
    facts = 0,
    graphs = 0,
    estimated = 0;
  for (const x of data) {
    let ds = monthDays(x.m).filter(
      (d) => !c.config.employmentStart || d >= c.config.employmentStart,
    );
    const excluded = x.estimate.reduction.days;
    ds = ds.filter((d) => !excluded.has(d) && (!vacation || !holiday(d)));
    // Optional confirmed denominators avoid guessing which excluded days were holidays.
    const confirmedDivisor = vacation
      ? x.record?.vacationDays
      : x.record?.sickDays;
    divisor +=
      confirmedDivisor ??
      Math.max(0, ds.length - (x.record?.excludedDays || 0));
    if (x.record?.dueDate && x.record.dueDate > anchor) {
      notes.push(
        `${x.m}: начисление ещё не стало причитающимся; оценка неполна.`,
      );
      estimated++;
      continue;
    }
    if (x.record?.wage !== undefined) {
      total += x.record.wage;
      facts++;
    } else if (x.graph) {
      total += x.estimate.wage;
      graphs++;
    } else {
      total += x.estimate.base + x.estimate.replacement + (variable || 0);
      estimated++;
    }
  }
  if (estimated)
    notes.push(
      `${estimated} мес. оценены по известному окладу${variable !== undefined ? " и средним доступным надбавкам" : ", без неизвестных надбавок"}.`,
    );
  if (!c.config.salaryHistory.length)
    notes.push("Предполагается сохранение текущего оклада в прошлых месяцах.");
  const fixed =
    vacation &&
    data.length > 0 &&
    facts === data.length &&
    data.every(
      (x) =>
        x.record?.wage === data[0].record?.wage &&
        x.estimate.reduction.days.size === 0,
    )
      ? data[0].record?.wage
      : undefined;
  if (fixed !== undefined)
    notes.push(
      "Введён неизменный заработок за весь период: сохранение заработка вместо среднего.",
    );
  return {
    value: divisor > 0 && period.length ? total / divisor : undefined,
    period,
    facts,
    graphs,
    estimated,
    notes,
    preservedWage: fixed,
  };
}
export function insurerRate(c: PayrollContext, e: PersonalEvent): RateEstimate {
  const year = String(Number((e.caseStart || e.start).slice(0, 4)) - 1);
  const period = Array.from(
    { length: 12 },
    (_, i) => year + "-" + String(i + 1).padStart(2, "0"),
  );
  if (c.config.annualIncome[year] !== undefined) {
    const income = c.config.annualIncome[year] / 365;
    const opening = e.caseStart || e.start;
    const minimum = opening >= "2026-04-01" ? 946 / 30 : 886 / 30;
    return {
      value: income >= minimum ? income : undefined,
      period,
      facts: 12,
      graphs: 0,
      estimated: 0,
      notes: [
        income >= minimum
          ? "База из введённого дохода MTA. После родительского отпуска проверьте более выгодную ставку."
          : "Низкий/нулевой прошлогодний доход: применяется особое правило минимума и текущей зарплаты. Введите подтверждённую дневную ставку Tervisekassa; ноль не считается нулевым правом на пособие.",
      ],
    };
  }
  const rows = period.map((m) => ({
    m,
    record: c.records.find((r) => r.id === m),
    graph: c.months.some(
      (r) => r.id === m && !!candidateForMonth(r, c.config.owner),
    ),
    earned: earnedMonth(c, m),
  }));
  if (!rows.some((x) => x.graph || x.record?.socialIncome !== undefined))
    return {
      period,
      facts: 0,
      graphs: 0,
      estimated: 12,
      notes: [
        `Нет базы за ${year} год. Введите годовой доход MTA или дневную ставку пособия.`,
      ],
    };
  const known = rows.filter((x) => x.graph);
  const variable = known.length
    ? known.reduce((s, x) => s + x.earned.variable, 0) / known.length
    : 0;
  let income = 0,
    facts = 0,
    graphs = 0,
    estimated = 0;
  for (const x of rows) {
    if (x.record?.socialIncome !== undefined) {
      income += x.record.socialIncome;
      facts++;
    } else {
      const vacationDays = x.earned.plan.events
        .filter((e) => e.kind === "vacation")
        .flatMap((e) => eventDates(e, c.today))
        .filter((d) => d.startsWith(x.m) && !holiday(d)).length;
      income += x.graph
        ? x.earned.wage + vacationDays * c.settings.vacationDailyRate
        : x.earned.base + x.earned.replacement + variable;
      if (x.graph) graphs++;
      else estimated++;
    }
  }
  return {
    value: income / 365,
    period,
    facts,
    graphs,
    estimated,
    notes: [
      "Оценка годового дохода по графикам; другие работодатели и неизвестные начисления не включены. Отпускные при отсутствии факта оценены по сохранённой ставке.",
    ],
  };
}
export type PaymentLine = {
  id: string;
  label: string;
  employer: number;
  insurer?: number;
  days: number;
  rate?: RateEstimate;
  notes: string[];
  paymentDate?: string;
};
export type PersonalForecast = ReturnType<typeof earnedMonth> & {
  vacation: number;
  employerBenefit: number;
  insurer?: number;
  gross: number;
  net: number;
  insurerNet?: number;
  totalNet: number;
  unknown: boolean;
  lines: PaymentLine[];
  ownHours: number;
  period?: PeriodBalance;
};
export type PeriodBalance = {
  start: string;
  end: string;
  hours: number;
  norm: number;
  balance: number;
  complete: boolean;
  confirmed: boolean;
  overtime: number;
  pay: number;
  rest: number;
};
export function periodBalance(
  c: PayrollContext,
  month: string,
): PeriodBalance | undefined {
  if (!c.config.periodStart) return;
  const length = c.config.periodMonths;
  let start = c.config.periodStart.slice(0, 7),
    safety = 0;
  while (start > month && safety++ < 600) start = shiftMonth(start, -length);
  while (shiftMonth(start, length) <= month && safety++ < 600)
    start = shiftMonth(start, length);
  const end = shiftDay(shiftMonth(start, length) + "-01", -1);
  const ms = Array.from({ length }, (_, i) => shiftMonth(start, i));
  const plan = personalPlan(c.months, c.config.owner, c.events, c.today);
  let hours = 0,
    norm = 0,
    salary = 0;
  for (const m of ms) {
    const stats = intervalStats(plan.work, m);
    const restRanges = plan.events
      .filter((e) => e.kind === "timeoff")
      .flatMap((e) =>
        e.startTime && e.endTime
          ? [eventBounds(e)]
          : eventDates(e, c.today).map((d) => ({
              start: minute(d),
              end: minute(shiftDay(d, 1)),
            })),
      );
    const credited = plan.original
      .filter((i) => i.kind === "hours")
      .reduce(
        (s, i) =>
          s +
          restRanges.reduce((a, r) => {
            const x = clip(
              i,
              Math.max(r.start, minute(m + "-01")),
              Math.min(r.end, minute(shiftMonth(m, 1) + "-01")),
            );
            return a + (x ? (x.end - x.start) / 60 : 0);
          }, 0),
        0,
      );
    hours += stats.work - stats.emergency + credited;
    norm += Math.max(
      0,
      monthlyWorkNorm(m).hours - absenceReduction(c, m, plan).hours,
    );
    salary += earnedMonth(c, m).base;
  }
  const complete =
    ms.every((m) =>
      c.months.some(
        (r) => r.id === m && !!candidateForMonth(r, c.config.owner),
      ),
    ) && !plan.conflicts.length;
  const balance = hours - norm,
    overtime = Math.max(0, balance);
  const confirmed =
    complete &&
    c.config.periodConfirmed &&
    c.config.confirmedPeriodStart === start + "-01" &&
    end <= (c.today || todayTallinn());
  return {
    start: start + "-01",
    end,
    hours,
    norm,
    balance,
    complete,
    confirmed,
    overtime,
    pay:
      confirmed &&
      month === end.slice(0, 7) &&
      c.config.overtimeCompensation === "money" &&
      norm
        ? roundMoney((salary / norm) * overtime * 1.5)
        : 0,
    rest: c.config.overtimeCompensation === "rest" ? overtime : 0,
  };
}
export function personalForecast(
  c: PayrollContext,
  month: string,
): PersonalForecast {
  const earned = earnedMonth(c, month),
    es = contextEvents(c),
    ds = monthDays(month);
  let vacation = 0,
    employerBenefit = 0,
    insurer = 0,
    unknown = false;
  const lines: PaymentLine[] = [];
  const handled = new Set<string>();
  for (const e of es
    .filter(isAbsence)
    .sort((a, b) => a.createdAt - b.createdAt)) {
    const all = eventDates(e, c.today),
      eventDays = all.filter((d) => d.startsWith(month) && !handled.has(d));
    all.forEach((d) => handled.add(d));
    if (!eventDays.length || e.kind === "timeoff") continue;
    const notes: string[] = [];
    if (e.status === "planned")
      notes.push(
        "Запланированное событие: сумма входит в сценарный прогноз, а не в подтверждённую выплату.",
      );
    let rate: RateEstimate | undefined,
      emp = 0,
      tk = 0,
      paidDays = 0;
    if (e.kind === "vacation") {
      const paid = eventDays.filter((d) => !holiday(d));
      paidDays = paid.length;
      rate =
        e.rateMode === "auto"
          ? averageRate(c, vacationAnchor(e.start), true)
          : undefined;
      const daily =
        e.rateMode === "saved"
          ? c.settings.vacationDailyRate
          : e.rateMode === "auto"
            ? rate?.value
            : e.daily;
      if (e.rateMode === "preserve" || rate?.preservedWage !== undefined) {
        emp =
          ((rate?.preservedWage ?? earned.settings.baseSalary) / ds.length) *
          eventDays.length;
        notes.push(
          "Сохранение заработка выбрано вручную; сумма за период отсутствия. Проверьте постоянные надбавки.",
        );
      } else if (e.total !== undefined)
        emp =
          (e.total * paidDays) /
          Math.max(1, all.filter((d) => !holiday(d)).length);
      else if (daily !== undefined) emp = daily * paidDays;
      else unknown = true;
      vacation += roundMoney(emp);
      notes.push("Праздники не расходуют дни ежегодного отпуска.");
    } else {
      const caseStart = e.caseStart || e.start;
      const caseYear = Number(caseStart.slice(0, 4));
      const percent = e.kind === "care" ? 0.8 : 0.7;
      rate = e.rateMode === "auto" ? insurerRate(c, e) : undefined;
      const basis = e.rateMode === "auto" ? rate?.value : e.daily;
      const employerEstimate = averageRate(c, caseStart, false);
      const employerRate = e.employerDaily ?? employerEstimate.value;
      if (e.kind === "sick")
        notes.push(
          `База работодателя: ${employerRate?.toFixed(4) ?? "неизвестно"} €/день до 70%; ${employerEstimate.period[0] || "—"} — ${employerEstimate.period.at(-1) || "—"}. ${e.employerDaily !== undefined ? "Ставка введена вручную." : `Введено ${employerEstimate.facts}; графики ${employerEstimate.graphs}; оценено ${employerEstimate.estimated} мес.`}`,
        );
      const limit =
        e.kind === "care"
          ? e.cause === "12"
            ? 7
            : e.cause === "13"
              ? 10
              : 60
          : 182;
      for (const d of eventDays) {
        const day = (minute(d) - minute(caseStart)) / 1440 + 1;
        if (e.cause === "special") {
          paidDays++;
          if (e.rateMode === "benefit" && basis !== undefined) tk += basis;
          else if (e.total === undefined) unknown = true;
          continue;
        }
        if (e.kind === "sick" && day >= 4 && day <= 8) {
          if (employerRate !== undefined) emp += employerRate * 0.7;
          else unknown = true;
        }
        if ((e.kind === "care" || day >= 9) && day <= limit && day >= 1) {
          paidDays++;
          if (basis === undefined) {
            if (e.total === undefined) unknown = true;
            continue;
          }
          const daily = e.rateMode === "benefit" ? basis : basis * percent;
          // Never silently extend a published 2026 ceiling into an unknown future year.
          if (
            caseYear >= 2026 &&
            d.slice(0, 4) !== "2026" &&
            e.rateMode !== "benefit"
          ) {
            unknown = true;
            notes.push(
              "Нужен подтверждённый предел/готовая ставка пособия для этого года.",
            );
            continue;
          }
          tk +=
            caseYear >= 2026 && d.slice(0, 4) === "2026"
              ? Math.min(126.87, daily)
              : daily;
        }
      }
      if (e.total !== undefined) {
        tk = (e.total * eventDays.length) / Math.max(1, all.length);
        notes.push("Введённая общая сумма распределена по вашим дням.");
      }
      employerBenefit += roundMoney(emp);
      insurer += roundMoney(tk);
      if (!e.end) {
        unknown = true;
        notes.push(
          "Лист открыт: расчёт по текущую дату; итог месяца зависит от окончания.",
        );
      }
      notes.push(
        e.cause === "special"
          ? "Особая причина: применена только введённая подтверждённая ставка/сумма; стандартная схема ожидания не используется."
          : e.kind === "care"
            ? "Tervisekassa с первого дня; общий срок случая не начинается заново при смене ухаживающего."
            : "Дни 1–3 без обязательного пособия, 4–8 работодатель, с 9-го Tervisekassa.",
      );
    }
    lines.push({
      id: e.id,
      label: eventLabels[e.kind],
      employer: roundMoney(emp),
      insurer:
        e.kind === "sick" || e.kind === "care" ? roundMoney(tk) : undefined,
      days: paidDays,
      rate,
      notes,
      paymentDate: e.paymentDate,
    });
  }
  for (const e of es.filter(isWork)) {
    const hours = intervalStats(
      earned.plan.work.filter((i) => i.eventId === e.id),
      month,
    ).work;
    if (!hours) continue;
    const ambiguous = clockChange(e);
    if (ambiguous) unknown = true;
    lines.push({
      id: e.id,
      label: eventLabels[e.kind],
      employer:
        e.kind === "emergency" && e.compensation === "money"
          ? roundMoney(
              hours *
                earned.legacy.hourlyRate *
                (e.baseAlreadyPaid ? 0.5 : 1.5),
            )
          : 0,
      days: 0,
      notes: [
        `${hours} ч по местному времени; ${e.status === "planned" ? "запланирован" : "внесён как отработанный"}.`,
        e.kind === "extra"
          ? "Итоговая компенсация определяется по всему учётному периоду."
          : e.compensation === "rest"
            ? "Выбрана компенсация отдыхом; денежные ×1,5 не начисляются."
            : e.baseAlreadyPaid
              ? "Базовая часть уже оплачена: добавлено только ×0,5."
              : "Часы × ставка месяца ×1,5; ночные и праздничная надбавка отдельно.",
        ...(ambiguous
          ? [
              "Интервал пересекает перевод часов. Показаны плановые местные часы; фактические оплаченные часы уточните по табелю.",
            ]
          : []),
      ],
      paymentDate: e.paymentDate,
    });
  }
  // Imported vacation is already in the legacy source. Only unmatched P dates use the saved rate.
  const coveredVacation = new Set(
    es
      .filter((e) => e.kind === "vacation")
      .flatMap((e) => eventDates(e, c.today)),
  );
  const sourceP = allMarksForDelta(c.months, c.config.owner).filter(
    (m) =>
      m.date.startsWith(month) &&
      m.kind === "leave" &&
      m.raw === "P" &&
      !holiday(m.date) &&
      !handled.has(m.date) &&
      !coveredVacation.has(m.date),
  );
  if (c.settings.vacationEnabled)
    vacation += roundMoney(sourceP.length * c.settings.vacationDailyRate);
  const period = periodBalance(c, month);
  const actualWage = c.records.find((r) => r.id === month)?.wage;
  const gross = roundMoney(
    (actualWage ?? earned.wage) +
      vacation +
      (actualWage === undefined ? period?.pay || 0 : 0) +
      employerBenefit,
  );
  const contributionBase = roundMoney(gross - employerBenefit);
  const unemployment = roundMoney(
      (contributionBase * c.settings.unemploymentPercent) / 100,
    ),
    pension = roundMoney(
      (contributionBase * c.settings.fundedPensionPercent) / 100,
    );
  const tax = roundMoney(
    (Math.max(0, gross - unemployment - pension - c.settings.taxFreeAllowance) *
      c.settings.incomeTaxPercent) /
      100,
  );
  const net = roundMoney(gross - unemployment - pension - tax);
  if (earned.plan.conflicts.length) unknown = true;
  const insurerNet = roundMoney(insurer * 0.78);
  return {
    ...earned,
    vacation,
    employerBenefit,
    insurer,
    gross,
    net,
    insurerNet,
    totalNet: roundMoney(net + insurerNet),
    unknown,
    lines,
    ownHours: ownHours(es, month),
    period,
  };
}
export function personalDrafts(
  plan: Plan,
  month: string,
  owner: string,
  old: CalendarEventDraft[],
): CalendarEventDraft[] {
  const result: CalendarEventDraft[] = [];
  const counts = new Map<string, number>();
  for (const i of plan.work.filter((i) =>
    (
      i.key.match(/^20\d\d-\d\d-\d\d/)?.[0] ||
      plan.events.find((e) => e.id === i.eventId)?.start ||
      wall(i.start).slice(0, 10)
    ).startsWith(month),
  )) {
    if (i.incomplete) continue;
    const original = old.find((d) => d.key === i.key);
    const raw = i.raw;
    const index = counts.get(i.key) || 0;
    counts.set(i.key, index + 1);
    result.push({
      key: index ? i.key + ":part:" + wall(i.start) : i.key,
      date: wall(i.start).slice(0, 10),
      kind: i.kind,
      raw,
      hours: (i.end - i.start) / 60,
      start: { dateTime: wall(i.start), timeZone: "Europe/Tallinn" },
      end: { dateTime: wall(i.end), timeZone: "Europe/Tallinn" },
      summary:
        i.source === "emergency"
          ? "Erakorraline"
          : original?.summary ||
            (i.kind === "home" ? "Koduvalve" : "Дополнительный выход"),
      description:
        original?.description || `Создано PWA «Мои смены». ${owner}.`,
    });
  }
  return result;
}
