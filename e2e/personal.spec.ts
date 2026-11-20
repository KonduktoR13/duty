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
  await page.getByRole("radio", { name: "Зелёный" }).check();
  await page.locator('[name="noteMode"]').selectOption("hours");
  await page.locator('[name="hours"]').fill("4,5");
  const noteDate = await page.locator('[name="start"]').inputValue();
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator(".personal-event-row")).toContainText(
    "Обучение K-команды",
  );
  await expect(page.locator(`[data-day="${noteDate}"]`)).toHaveClass(/personal-day-color/);
  await page.locator("#detail-close").click();
  await expect(page.locator("#shift-details")).not.toBeVisible();
  await page.locator("#legend-toggle").click();
  const legend = page.locator("#calendar-legend");
  await expect(legend.locator(".legend-row > span:last-child")).toHaveText(["Своя запись · выбранный цвет"]);
  await expect(legend.locator(".legend-swatch")).toHaveClass(/color-green/);
  await expect(legend.locator(".legend-marker.color-green")).toHaveText("●");
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


test("manual koduvalve follows a 22-hour shift, supports arbitrary time, editing and deletion at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/");
  await page.locator("#file").setInputFiles(rosterPdf("22"));
  await page.locator('[data-delta="D12"]').click();
  await page.locator("#confirm-import").click();
  await page.locator('[data-day="2026-09-07"]').click();
  await page.locator("#add-day-personal").click();
  await page.locator('[data-event-kind="home"]').click();
  await page.locator('[name="endTime"]').fill("10:30");
  await page.locator("#after-shift").click();
  await expect(page.locator('[name="start"]')).toHaveValue("2026-09-08");
  await expect(page.locator('[name="startTime"]')).toHaveValue("06:00");
  await expect(page.locator('[name="endTime"]')).toHaveValue("08:30");
  await expect(page.locator('[data-help="type"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  const homeDay = page.locator('[data-day="2026-09-08"]');
  await expect(homeDay).toHaveClass(/home-duty/);
  await expect(homeDay).not.toHaveClass(/day-empty/);
  await expect(homeDay).toContainText('V2.5');
  await expect(homeDay).toHaveAttribute('aria-label', /06:00–08:30/);
  await expect(page.locator('.sync-card small')).toContainText('подтверждённых событий');
  await page.locator('.personal-day-content [data-edit-event]').click();
  await expect(page.locator('#dialog h2')).toHaveText("Изменить запись");
  await page.locator('[name="endTime"]').fill("09:15");
  await page.locator("#save-event").click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator(".personal-day-content [data-edit-event]")).toContainText("06:00–09:15");
  await expect(homeDay).toHaveAttribute('aria-label', /06:00–09:15/);
  await page.locator('#detail-close').click();
  await expect(page.locator('#shift-details')).not.toBeVisible();
  await page.locator('#next').click();
  await expect(page.locator('#picker')).toContainText('октябрь');
  await page.locator('#prev').click();
  await expect(homeDay).toHaveClass(/home-duty/);
  await page.reload();
  await page.locator("#list-mode").click();
  await expect(page.locator('.personal-event-row')).toHaveCount(1);
  await expect(page.locator('.personal-event-row')).toContainText("06:00–09:15");
  await page.locator('[data-section="analysis"]').click();
  await expect(page.locator('.personal-summary')).toContainText("3,25 ч");
  await page.locator("[data-forecast-details]").click();
  await expect(page.locator("#dialog")).toContainText("Koduvalve");
  await page.locator("#forecast-close").click();
  await page.locator('[data-section="calendar"]').click();
  await page.locator("#list-mode").click();
  await page.locator('.personal-event-row').click();
  page.once("dialog", d => d.accept());
  await page.locator('#delete-event').click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator('.personal-event-row')).toHaveCount(0);
});

test("stored P-et becomes vacation on startup and stays recognized after reload", async ({ page }) => {
  await page.goto("/");
  await roster(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("my-shifts");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("months", "readwrite");
      const store = tx.objectStore("months");
      const r = store.get("2026-09");
      r.onsuccess = () => {
        const m = r.result;
        const mark = { date: "2026-09-15", kind: "other", raw: "P-et" };
        m.marks.push(mark);
        m.candidates.find((c: { number: string }) => c.number === "D12").marks.push(mark);
        store.put(m);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await page.locator('[data-day="2026-09-15"]').click();
    await expect(page.locator('#shift-details')).toContainText("eriteenistuja lisapuhkus");
    await expect(page.locator('[data-day="2026-09-15"]')).toHaveClass(/leave-vacation/);
  }
});

test("manual home duty without PDF colors the day and offers ordinary Google sync", async ({ page }) => {
  await page.goto('/');
  await page.locator('#add-personal').click();
  await page.locator('[data-event-kind="home"]').click();
  await page.locator('[name="owner"]').fill('D12');
  await page.locator('[name="start"]').fill('2026-11-19');
  await page.locator('[name="end"]').fill('2026-11-19');
  await page.locator('[name="startTime"]').fill('09:15');
  await page.locator('[name="endTime"]').fill('12:30');
  await page.locator('#save-event').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  const day = page.locator('[data-day="2026-11-19"]');
  await expect(day).toHaveClass(/home-duty/);
  await expect(page.locator('#sync-month')).toBeEnabled();
  await expect(page.locator('.sync-card small')).toContainText('1 подтверждённых событий');
  await page.reload();
  await expect(day).toHaveClass(/home-duty/);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect(await day.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  }
  await day.click();
  await expect(page.locator('#shift-details')).not.toContainText('Нет смен');
  await page.locator('.personal-day-content [data-edit-event]').click();
  page.once('dialog', d => d.accept());
  await page.locator('#delete-event').click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(page.locator('[data-day].home-duty')).toHaveCount(0);
});
