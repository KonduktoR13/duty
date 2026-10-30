import { test, expect } from "@playwright/test";
import { rosterPdf } from "./fixture";

async function roster(page: import("@playwright/test").Page) {
  await page.locator("#file").setInputFiles(rosterPdf());
  await page.locator('[data-delta="D12"]').click();
  await page.locator("#confirm-import").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
}
test("personal note works without PDF, survives offline reload and keeps form state while help opens", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/");
  await page.locator("#add-personal").click();
  await page.locator('[name="title"]').fill("Обучение K-команды");
  await page.locator('[name="noteMode"]').selectOption("hours");
  await page.locator('[name="hours"]').fill("4,5");
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator(".personal-event-row")).toContainText(
    "Обучение K-команды",
  );
  await page.locator('[data-section="analysis"]').click();
  await expect(page.locator(".personal-summary")).toContainText("4,5 ч");
  await page.locator('[data-section="calendar"]').click();
  await page.locator("#add-personal").click();
  await page.locator('[data-event-kind="emergency"]').click();
  await page.locator('[name="owner"]').fill("D12");
  await page.locator('[data-help="type"]').click();
  await expect(page.locator("#personal-help")).toBeVisible();
  await page.locator("#personal-help button").click();
  await expect(page.locator('[name="owner"]')).toHaveValue("D12");
  page.once("dialog", (d) => d.accept());
  await page.locator("#event-close").click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.locator("#list-mode").click();
  await expect(page.locator(".personal-event-row")).toContainText(
    "Обучение K-команды",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("emergency and childcare update personal payouts and a matching PDF is linked once", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await roster(page);
  await page.locator('[data-day="2026-09-07"]').click();
  await page.locator("#add-day-personal").click();
  await page.locator('[data-event-kind="emergency"]').click();
  await page.locator('[data-duration="24"]').click();
  await page.locator('[name="linkConfirmed"]').check();
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await page.locator('[data-section="analysis"]').click();
  await expect(page.locator(".personal-summary")).toContainText("24 ч");
  await expect(page.locator(".personal-forecast")).toContainText(
    "Erakorraline",
  );
  await page.locator('[data-section="calendar"]').click();
  await page.locator("#add-personal").click();
  await page.locator('[data-event-kind="sick"]').click();
  await page.locator('[data-absence-kind="care"]').click();
  await page.locator('[name="start"]').fill("2026-09-10");
  await page.locator('[name="ongoing"]').uncheck();
  await page.locator('[name="end"]').fill("2026-09-19");
  await page.locator("summary").filter({ hasText: "Расчёт и выплата" }).click();
  await page.locator('[name="rateMode"]').selectOption("benefit");
  await page.locator('[name="daily"]').fill("80");
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await page.locator('[data-section="analysis"]').click();
  await expect(page.locator(".personal-forecast")).toContainText("624,00");
  await page.locator("[data-forecast-details]").click();
  await expect(page.locator("#dialog")).toContainText("Уход за ребёнком");
  expect(errors).toEqual([]);
});
test("long press opens the tapped date and explicit vacation interruption preserves both records", async ({
  page,
}) => {
  await page.goto("/");
  await roster(page);
  const cell = page.locator('[data-day="2026-09-12"]');
  const box = await cell.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(page.locator('[name="start"]')).toHaveValue("2026-09-12");
  await page.locator('[data-event-kind="vacation"]').click();
  await page.locator('[name="end"]').fill("2026-09-16");
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await page.locator("#add-personal").click();
  await page.locator('[data-event-kind="sick"]').click();
  await page.locator('[name="ongoing"]').uncheck();
  await page.locator('[name="end"]').fill("2026-09-13");
  await page.locator('[name="interrupt"]').check();
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  const data = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r, j) => {
      const q = indexedDB.open("my-shifts");
      q.onsuccess = () => r(q.result);
      q.onerror = () => j(q.error);
    });
    return await new Promise<any[]>((r, j) => {
      const q = db.transaction("events").objectStore("events").getAll();
      q.onsuccess = () => r(q.result);
      q.onerror = () => j(q.error);
    });
  });
  expect(data).toHaveLength(2);
  expect(data.find((e) => e.kind === "vacation").excluded).toEqual([
    "2026-09-12",
    "2026-09-13",
  ]);
});
