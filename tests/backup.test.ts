import { it, expect } from "vitest";
import { readBackup } from "../src/backup";
const base = {
  format: "my-shifts-backup",
  version: 1,
  createdAt: "2026-09-05",
  months: [],
  pdfs: [],
  settings: [],
  syncs: [],
  revisions: [],
};
it("rejects unsupported versions and malformed imported records before storage is touched", async () => {
  await expect(
    readBackup(new Blob([JSON.stringify({ ...base, version: 2 })])),
  ).rejects.toThrow("Формат");
  await expect(
    readBackup(
      new Blob([
        JSON.stringify({
          ...base,
          months: [{ id: "<img src=x onerror=alert(1)>" }],
        }),
      ]),
    ),
  ).rejects.toThrow("Формат");
  await expect(readBackup(new Blob(["{broken"]))).rejects.toBeDefined();
});
it("preserves the installation ID and account history without OAuth tokens", async () => {
  const result = await readBackup(
    new Blob([
      JSON.stringify({
        ...base,
        settings: [
          ["installationId", "installation-1"],
          [
            "googleIntegration",
            {
              enabled: true,
              accountProfileId: "p1",
              accountEmail: "test@example.com",
              access_token: "discard-me",
            },
          ],
        ],
      }),
    ]),
  );
  expect(result.settings[0]).toEqual(["installationId", "installation-1"]);
  expect(result.settings[1][1]).not.toHaveProperty("access_token");
});
it("accepts local salary forecast settings in a backup", async () => {
  const salary = {
    baseSalary: 2170,
    replacementEnabled: true,
    replacementPercent: 16.0184,
  };
  const result = await readBackup(
    new Blob([
      JSON.stringify({ ...base, settings: [["salarySettings", salary]] }),
    ]),
  );
  expect(result.settings).toEqual([["salarySettings", salary]]);
});
it("preserves the workload sort and legend preferences in a backup", async () => {
  const settings = [["employeeWorkloadSort", "total"], ["legendMonthOnly", false]];
  const result = await readBackup(
    new Blob([
      JSON.stringify({
        ...base,
        settings,
      }),
    ]),
  );
  expect(result.settings).toEqual(settings);
});
it("reads v2 personal data, rejects impossible dates, and never silently strips new records", async () => {
  const event = {
    id: "note-1",
    kind: "note",
    owner: "D12",
    start: "2026-10-28",
    title: "Training",
    createdAt: 1,
    updatedAt: 1,
  };
  const file = (data: unknown) => new Blob([JSON.stringify(data)]);
  const v2 = {
    ...base,
    version: 2,
    events: [event],
    payroll: [{ id: "2026-09", wage: 2170 }],
    settings: [
      ["personalSettings", { owner: "D12", annualIncome: { "2025": 36500 } }],
    ],
  };
  const parsed = await readBackup(file(v2));
  expect(parsed.events?.[0].title).toBe("Training");
  expect(parsed.payroll?.[0].wage).toBe(2170);
  await expect(
    readBackup(file({ ...v2, events: [{ ...event, start: "2026-02-30" }] })),
  ).rejects.toThrow("Формат");
  await expect(
    readBackup(file({ ...v2, events: [event, event] })),
  ).rejects.toThrow("повторяются");
});


it("restores supplementary leave and manual koduvalve without dropping their types", async () => {
  const m = { id: "2026-12", fileName: "demo.pdf", importedAt: 1, hash: "x", shifts: [], deltaNumber: "D12", status: "local", marks: [{ date: "2026-12-31", kind: "leave", raw: "P-et" }], leaveDates: ["2026-12-31"], leaveCodes: { "2026-12-31": "P-et" } };
  const e = { id: "home-1", kind: "home", owner: "D12", start: "2026-12-15", end: "2026-12-15", startTime: "06:00", endTime: "08:00", title: "Koduvalve", createdAt: 1, updatedAt: 1 };
  const result = await readBackup(new Blob([JSON.stringify({ ...base, version: 2, months: [m], events: [e], payroll: [] })]));
  expect(result.months[0].leaveCodes?.["2026-12-31"]).toBe("P-et");
  expect(result.events?.[0]).toMatchObject(e);
});
