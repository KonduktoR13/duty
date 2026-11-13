import { describe, expect, it } from "vitest";
import {
  eventSchema,
  defaultPersonalSettings,
  validDay,
} from "../src/personal-types";
import type { PersonalEvent } from "../src/personal-types";
import type { MonthRecord, DayMark } from "../src/types";
import { DEFAULT_SALARY_SETTINGS } from "../src/salary-calculation";
import {
  personalPlan,
  personalForecast,
  averageRate,
  vacationAnchor,
  periodBalance,
  intervalStats,
  personalDrafts,
  type PayrollContext,
} from "../src/personal";
const event = (data: Partial<PersonalEvent>) =>
  eventSchema.parse({
    id: Math.random().toString(),
    kind: "note",
    owner: "D12",
    start: "2026-10-01",
    title: "Test",
    createdAt: 1,
    updatedAt: 1,
    ...data,
  });
const month = (id: string, marks: DayMark[] = []): MonthRecord => ({
  id,
  fileName: "demo.pdf",
  hash: id,
  importedAt: 1,
  deltaNumber: "D12",
  status: "local",
  shifts: [],
  marks,
});
const ctx = (
  events: PersonalEvent[] = [],
  months: MonthRecord[] = [],
): PayrollContext => ({
  months,
  events,
  settings: DEFAULT_SALARY_SETTINGS,
  config: {
    ...defaultPersonalSettings(),
    owner: "D12",
    annualIncome: { "2025": 36500 },
  },
  records: [],
  today: "2026-10-30",
});

describe("personal work and payroll", () => {
  it("validates real dates, positive working intervals and typed benefit rates", () => {
    expect(validDay("2026-02-30")).toBe(false);
    expect(validDay("2024-02-29")).toBe(true);
    expect(() =>
      event({
        kind: "extra",
        startTime: "08:00",
        endTime: "08:00",
        end: "2026-10-01",
      }),
    ).toThrow();
    expect(() => event({ kind: "care", rateMode: "benefit" })).toThrow();
  });
  it("notes do not change wage, contribution base or work", () => {
    const a = personalForecast(ctx(), "2026-10"),
      b = personalForecast(ctx([event({ hours: 4 })]), "2026-10");
    expect(b.gross).toBe(a.gross);
    expect(b.stat.work).toBe(0);
    expect(b.ownHours).toBe(4);
  });
  it("pays emergency, night and holiday premiums additively without duplicating base", () => {
    const e = event({
      kind: "emergency",
      start: "2026-01-01",
      end: "2026-01-01",
      startTime: "00:00",
      endTime: "04:00",
    });
    const result = personalForecast(ctx([e]), "2026-01");
    const hourly = result.settings.baseSalary / result.legacy.normHours;
    expect(result.emergency).toBe(Math.round(4 * hourly * 1.5 * 100) / 100);
    expect(result.stat.night).toBe(4);
    expect(result.stat.festive).toBe(4);
    expect(result.gross).toBeCloseTo(
      2170 +
        result.emergency +
        result.legacy.nightPremium +
        result.legacy.publicHolidayPremium,
      2,
    );
  });
  it("does not double work when a reimport matches and requires an explicit link", () => {
    const m = month("2026-10", [
      { date: "2026-10-01", kind: "hours", raw: "12", hours: 12 },
    ]);
    const e = event({
      kind: "extra",
      end: "2026-10-01",
      startTime: "08:00",
      endTime: "20:00",
    });
    const p = personalPlan([m], "D12", [e]);
    expect(p.conflicts).toEqual([e.id]);
    expect(intervalStats(p.work).work).toBe(12);
    const linked = { ...e, linkedKey: p.original[0].key, linkConfirmed: true };
    expect(intervalStats(personalPlan([m], "D12", [linked]).work).work).toBe(
      12,
    );
    expect(personalPlan([m], "D12", [linked]).conflicts).toEqual([]);
  });
  it("clips a cross-month emergency to exact minutes", () => {
    const e = event({
      kind: "emergency",
      start: "2026-09-30",
      end: "2026-10-01",
      startTime: "23:45",
      endTime: "01:15",
    });
    const p = personalPlan([], "D12", [e]);
    expect(intervalStats(p.work, "2026-09").work).toBe(0.25);
    expect(intervalStats(p.work, "2026-10").work).toBe(1.25);
  });
  it("uses 3 waiting, 5 employer and 2 insurer days for ordinary ten-day illness", () => {
    const e = event({
      kind: "sick",
      end: "2026-10-10",
      rateMode: "income",
      daily: 100,
      employerDaily: 100,
    });
    const f = personalForecast(ctx([e]), "2026-10");
    expect(f.employerBenefit).toBe(350);
    expect(f.insurer).toBe(140);
    expect(f.insurerNet).toBe(109.2);
  });
  it("pays childcare 80% from day one with no employer waiting scheme", () => {
    const f = personalForecast(
      ctx([event({ kind: "care", end: "2026-10-10", cause: "14" })]),
      "2026-10",
    );
    expect(f.employerBenefit).toBe(0);
    expect(f.insurer).toBe(800);
    expect(f.insurerNet).toBe(624);
  });
  it("never applies 80% to an already calculated daily benefit", () => {
    expect(
      personalForecast(
        ctx([
          event({
            kind: "care",
            end: "2026-10-10",
            cause: "14",
            rateMode: "benefit",
            daily: 80,
          }),
        ]),
        "2026-10",
      ).insurer,
    ).toBe(800);
  });
  it("applies the ceiling after percentage and uses the original case for continuation limits", () => {
    expect(
      personalForecast(
        ctx([
          event({
            kind: "care",
            end: "2026-10-01",
            cause: "14",
            rateMode: "income",
            daily: 200,
          }),
        ]),
        "2026-10",
      ).insurer,
    ).toBe(126.87);
    const e = event({
      kind: "care",
      start: "2026-10-01",
      end: "2026-10-10",
      caseStart: "2026-08-01",
      cause: "14",
    });
    expect(personalForecast(ctx([e]), "2026-10").insurer).toBe(0);
    expect(
      personalForecast(
        ctx([event({ kind: "care", end: "2026-10-10", cause: "12" })]),
        "2026-10",
      ).insurer,
    ).toBe(560);
  });
  it("does not deduct base salary for sickness on a graph free day", () => {
    const f = personalForecast(
      ctx([event({ kind: "sick", end: "2026-10-01" })], [month("2026-10")]),
      "2026-10",
    );
    expect(f.base).toBe(2170);
  });
  it("subtracts missed work, keeps original PDF and does not export medical data", () => {
    const m = month("2026-10", [
      { date: "2026-10-01", kind: "hours", raw: "12", hours: 12 },
    ]);
    const e = event({
      kind: "sick",
      end: "2026-10-01",
      note: "Private medical note",
    });
    const p = personalPlan([m], "D12", [e]);
    expect(p.original).toHaveLength(1);
    expect(p.work).toHaveLength(0);
    expect(personalDrafts(p, "2026-10", "D12", [])).toEqual([]);
    expect(m.marks).toHaveLength(1);
  });
  it("uses a single vacation base and excludes national holidays from paid days", () => {
    const e = event({
      kind: "vacation",
      start: "2026-06-22",
      end: "2026-06-28",
      rateMode: "benefit",
      daily: 100,
      absenceMode: "calendar",
    });
    expect(personalForecast(ctx([e]), "2026-06").vacation).toBe(500);
    expect(vacationAnchor("2026-10-01")).toBe("2026-09-29");
    expect(averageRate(ctx(), "2026-09-29", true).period).toEqual([
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
  });
  it("does not duplicate imported P when a manual vacation covers the same dates", () => {
    const m = month("2026-06", [
      { date: "2026-06-22", kind: "leave", raw: "P" },
    ]);
    const e = event({
      kind: "vacation",
      start: "2026-06-22",
      end: "2026-06-22",
      rateMode: "benefit",
      daily: 100,
      absenceMode: "calendar",
    });
    expect(personalForecast(ctx([e], [m]), "2026-06").vacation).toBe(100);
  });
  it("distinguishes unknown prior-year income from zero and respects entered zero", () => {
    const c = ctx([event({ kind: "care", end: "2026-10-02" })]);
    c.config.annualIncome = {};
    expect(personalForecast(c, "2026-10").unknown).toBe(true);
    c.config.annualIncome["2025"] = 0;
    // Zero entered income needs the statutory low-income fallback, not an assumed zero entitlement.
    expect(personalForecast(c, "2026-10").lines[0].rate?.facts).toBe(12);
  });
  it("uses the whole accounting period rather than paying every extra hour immediately", () => {
    const c = ctx(
      [
        event({
          kind: "extra",
          end: "2026-10-01",
          startTime: "08:00",
          endTime: "12:00",
        }),
      ],
      [month("2026-10")],
    );
    c.config.periodStart = "2026-10-01";
    c.config.periodMonths = 4;
    expect(periodBalance(c, "2026-10")?.pay).toBe(0);
    expect(periodBalance(c, "2026-10")?.complete).toBe(false);
  });
});
it("uses confirmed denominators and preserves fully evidenced constant pay for vacation", () => {
  const c = ctx([
    event({
      kind: "vacation",
      start: "2026-10-01",
      end: "2026-10-07",
      absenceMode: "calendar",
    }),
  ]);
  c.records = [
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
  ].map((id) => ({
    id,
    wage: 2170,
    source: "pal gateatis",
    sickDays: 30,
    vacationDays: 25,
  }));
  expect(averageRate(c, "2026-09-29", true).preservedWage).toBe(2170);
  const f = personalForecast(c, "2026-10");
  expect(f.base + f.vacation).toBe(2170);
});
it("keeps original ownership month and distinct keys for multiple exported pieces", () => {
  const m = month("2026-10", [
    { date: "2026-10-01", kind: "hours", raw: "24", hours: 24 },
  ]);
  const e = event({ kind: "sick", end: "2026-10-01" });
  const p = personalPlan([m], "D12", [e]);
  const drafts = personalDrafts(p, "2026-10", "D12", []);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].start.dateTime).toBe("2026-10-02T00:00:00");
  expect(drafts[0].description).not.toContain("Больничный");
});
it("zero income uses an unknown special-floor entitlement instead of pretending no benefit is due", () => {
  const c = ctx([event({ kind: "care", end: "2026-10-05" })]);
  c.config.annualIncome["2025"] = 0;
  expect(personalForecast(c, "2026-10").unknown).toBe(true);
});
it("requires a special sickness amount instead of applying the ordinary 3/5 day scheme", () => {
  const c = ctx([
    event({
      kind: "sick",
      cause: "special",
      end: "2026-10-05",
      rateMode: "benefit",
      daily: 100,
    }),
  ]);
  const f = personalForecast(c, "2026-10");
  expect(f.employerBenefit).toBe(0);
  expect(f.insurer).toBe(500);
});
it("never pays the base twice if the base was already paid separately", () => {
  const e = event({
    kind: "emergency",
    start: "2026-10-01",
    end: "2026-10-01",
    startTime: "08:00",
    endTime: "12:00",
    baseAlreadyPaid: true,
  });
  const f = personalForecast(ctx([e]), "2026-10");
  expect(f.emergency).toBe(
    Math.round(f.legacy.hourlyRate * 4 * 0.5 * 100) / 100,
  );
});
it("uses dated salary history without changing earlier months and supports mid-month rates", () => {
  const c = ctx();
  c.config.salaryHistory = [
    {
      from: "2026-10-16",
      baseSalary: 3100,
      replacementEnabled: false,
      replacementPercent: 0,
    },
  ];
  expect(personalForecast(c, "2026-09").base).toBe(2170);
  expect(personalForecast(c, "2026-10").base).toBeCloseTo(
    (2170 * 15 + 3100 * 16) / 31,
    2,
  );
});
it("missing PDF is an unknown schedule and uses calendar reduction, not a free-day assumption", () => {
  const e = event({ kind: "sick", start: "2026-10-01", end: "2026-10-31" });
  expect(personalForecast(ctx([e]), "2026-10").base).toBe(0);
});
it("confirmation of one accounting period cannot automatically confirm the following period", () => {
  const c = ctx([], [month("2026-01"), month("2026-02")]);
  c.config.periodStart = "2026-01-01";
  c.config.periodMonths = 1;
  c.config.periodConfirmed = true;
  c.config.confirmedPeriodStart = "2026-01-01";
  expect(periodBalance(c, "2026-01")?.confirmed).toBe(true);
  expect(periodBalance(c, "2026-02")?.confirmed).toBe(false);
});


describe("manual koduvalve", () => {
  const home = () => event({ kind: "home", start: "2026-12-15", end: "2026-12-15", startTime: "06:00", endTime: "08:00" });
  const source = () => month("2026-12", [{ date: "2026-12-14", kind: "hours", raw: "22", hours: 22 }]);
  it("adds a separate paid home interval after 22 hours without overtime or night premiums", () => {
    const a = personalForecast(ctx([], [source()]), "2026-12");
    const b = personalForecast(ctx([home()], [source()]), "2026-12");
    expect(b.plan.conflicts).toEqual([]);
    expect(b.stat.work).toBe(22);
    expect(b.stat.home).toBe(2);
    expect(b.stat.night).toBe(a.stat.night);
    expect(b.stat.extra).toBe(0);
    expect(b.legacy.homeDutyPremium).toBe(Math.round(b.legacy.homeDutyHourlyPremium * 2 * 100) / 100);
    expect(b.gross - a.gross).toBeCloseTo(b.legacy.homeDutyPremium, 2);
    expect(b.lines.find(l => l.id === b.plan.events[0].id)?.employer).toBe(b.legacy.homeDutyPremium);
    expect(personalDrafts(b.plan, "2026-12", "D12", []).find(d => d.kind === "home")).toMatchObject({ hours: 2, start: { dateTime: "2026-12-15T06:00:00" } });
  });
  it("splits arbitrary minutes at month boundary and excludes holiday and night premiums", () => {
    const e = event({ kind: "home", start: "2026-12-31", end: "2027-01-01", startTime: "23:30", endTime: "01:15" });
    const a = personalForecast(ctx([e]), "2026-12"), b = personalForecast(ctx([e]), "2027-01");
    expect(a.stat.home).toBe(.5);
    expect(b.stat.home).toBe(1.25);
    expect(b.stat.night).toBe(0);
    expect(b.stat.festive).toBe(0);
    expect(b.stat.work).toBe(0);
  });
  it("rejects overlaps with onsite work and prevents duplicate imported home hours", () => {
    const e = home();
    const m = month("2026-12", [{ date: e.start, kind: "home", raw: "V8", hours: 8 }]);
    const overlap = event({ ...e, startTime: "06:00", endTime: "08:00" });
    expect(personalPlan([m], "D12", [overlap]).conflicts).toEqual([overlap.id]);
    const exact = event({ ...e, startTime: "00:00", endTime: "08:00", linkConfirmed: true, linkedKey: personalPlan([m], "D12", []).original[0].key });
    expect(intervalStats(personalPlan([m], "D12", [exact]).work).home).toBe(8);
    expect(personalPlan([source()], "D12", [event({ ...e, startTime: "05:00" })]).conflicts).toEqual([e.id]);
  });
  it("validates manual home times, owner and maximum duration with the work schema", () => {
    expect(() => event({ kind: "home" })).toThrow();
    expect(() => event({ ...home(), end: "2026-12-18" })).toThrow();
    const e = home();
    expect(personalPlan([], "D40", [e]).work).toEqual([]);
  });
  it("treats P-et as paid vacation and avoids double payment with a manual vacation", () => {
    const m = month("2026-12", [{ date: "2026-12-31", kind: "leave", raw: "P-et" }]);
    expect(personalForecast(ctx([], [m]), "2026-12").vacation).toBe(DEFAULT_SALARY_SETTINGS.vacationDailyRate);
    const e = event({ kind: "vacation", start: "2026-12-31", end: "2026-12-31", rateMode: "benefit", daily: 100, absenceMode: "calendar" });
    expect(personalForecast(ctx([e], [m]), "2026-12").vacation).toBe(100);
  });
});


it("manual home pay details follow salary changes inside the month", () => {
  const e = event({ kind: "home", start: "2026-10-15", end: "2026-10-16", startTime: "23:00", endTime: "01:00" });
  const c = ctx([e]);
  c.config.salaryHistory = [{ from: "2026-10-16", baseSalary: 3000, replacementEnabled: false, replacementPercent: 0 }];
  const f = personalForecast(c, "2026-10");
  const rounded = (x: number) => Math.round(x * 100) / 100;
  const expected = rounded(rounded(DEFAULT_SALARY_SETTINGS.baseSalary / f.legacy.normHours * .12) + rounded(3000 / f.legacy.normHours * .12));
  expect(f.legacy.homeDutyPremium).toBe(expected);
  expect(f.lines.find(l => l.id === e.id)?.employer).toBe(expected);
});
