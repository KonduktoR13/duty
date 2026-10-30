import { z } from "zod";

export function validDay(value: string) {
  return (
    /^20\d\d-\d\d-\d\d$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}
export const dateSchema = z
  .string()
  .refine(validDay, "Укажите существующую дату");
const money = z.number().finite().min(0).max(10_000_000);
export const eventSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum([
      "note",
      "emergency",
      "extra",
      "sick",
      "care",
      "vacation",
      "timeoff",
    ]),
    owner: z.string().regex(/^(D\d+)?$/),
    start: dateSchema,
    end: dateSchema.optional(),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    title: z.string().max(200),
    note: z.string().max(5000).default(""),
    color: z
      .enum(["purple", "blue", "green", "orange", "pink", "grey"])
      .default("purple"),
    hours: z.number().finite().min(0).max(1000).optional(),
    status: z.enum(["planned", "confirmed"]).default("planned"),
    compensation: z.enum(["money", "rest"]).default("money"),
    baseAlreadyPaid: z.boolean().default(false),
    absenceMode: z.enum(["schedule", "calendar"]).default("schedule"),
    cause: z.enum(["illness", "14", "12", "13", "special"]).default("illness"),
    caseStart: dateSchema.optional(),
    caseId: z.string().max(100).optional(),
    rateMode: z
      .enum(["auto", "income", "benefit", "saved", "preserve"])
      .default("auto"),
    employerDaily: money.optional(),
    daily: money.optional(),
    total: money.optional(),
    paid: money.optional(),
    paidDate: dateSchema.optional(),
    paymentDate: dateSchema.optional(),
    paymentTiming: z.enum(["unknown", "before", "salary"]).default("unknown"),
    linkedKey: z.string().max(150).optional(),
    linkConfirmed: z.boolean().default(false),
    // Exclusions are actual dates: illness interrupting a vacation is an explicit action.
    excluded: z.array(dateSchema).max(1000).default([]),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (e.end && e.end < e.start) fail("Окончание раньше начала");
    if (e.end && (Date.parse(e.end) - Date.parse(e.start)) / 86400000 > 3650)
      fail("Период длиннее 10 лет: проверьте даты");
    if (
      e.startTime &&
      e.endTime &&
      e.end &&
      e.start + "T" + e.startTime >= e.end + "T" + e.endTime
    )
      fail("Окончание должно быть позже начала");
    if (e.caseStart && e.caseStart > e.start)
      fail("Исходный случай начинается позже вашего листа");
    const work = e.kind === "extra" || e.kind === "emergency";
    if (
      work &&
      (!e.startTime ||
        !e.endTime ||
        !e.end ||
        e.start + "T" + e.startTime >= e.end + "T" + e.endTime)
    )
      fail("Укажите начало и окончание рабочего выхода");
    if (
      work &&
      Date.parse(e.end + "T" + e.endTime + "Z") -
        Date.parse(e.start + "T" + e.startTime + "Z") >
        48 * 3600000
    )
      fail("Разделите выход длиннее 48 ч на отдельные интервалы");
    if ((e.kind === "vacation" || e.kind === "timeoff") && !e.end)
      fail("Укажите последний день периода");
    if (
      (e.rateMode === "income" || e.rateMode === "benefit") &&
      e.daily === undefined
    )
      fail("Укажите дневную ставку");
    if (e.kind === "note" && !e.title.trim()) fail("Добавьте название записи");
    if (e.startTime && (!e.end || !e.endTime)) fail("Укажите окончание");
  });
export type PersonalEvent = z.infer<typeof eventSchema>;
export const payrollRecordSchema = z.object({
  id: z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/),
  wage: money.optional(),
  socialIncome: money.optional(),
  sickDays: z.number().int().min(0).max(31).optional(),
  vacationDays: z.number().int().min(0).max(31).optional(),
  excludedDays: z.number().int().min(0).max(31).optional(),
  dueDate: dateSchema.optional(),
  source: z.string().max(300).default("Введено из palgateatis"),
});
export type PayrollRecord = z.infer<typeof payrollRecordSchema>;
export const personalSettingsSchema = z.object({
  owner: z
    .string()
    .regex(/^(D\d+)?$/)
    .default(""),
  employmentStart: dateSchema.optional(),
  periodStart: dateSchema.optional(),
  periodMonths: z.number().int().min(1).max(12).default(4),
  periodConfirmed: z.boolean().default(false),
  confirmedPeriodStart: dateSchema.optional(),
  overtimeCompensation: z.enum(["money", "rest"]).default("money"),
  salaryHistory: z
    .array(
      z.object({
        from: dateSchema,
        baseSalary: money,
        replacementEnabled: z.boolean(),
        replacementPercent: z.number().min(0).max(100),
      }),
    )
    .max(200)
    .default([]),
  annualIncome: z.record(z.string().regex(/^20\d\d$/), money).default({}),
  syncPersonal: z.boolean().default(false),
});
export type PersonalSettings = z.infer<typeof personalSettingsSchema>;
export const defaultPersonalSettings = () => personalSettingsSchema.parse({});
