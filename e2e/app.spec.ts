import { test, expect, type Page } from '@playwright/test'
import { rosterPdf } from './fixture'
import { updateServer } from './update-server'

async function importRoster(page: Page, code = '24') {
  await page.locator('#file').setInputFiles(rosterPdf(code))
  const choice = page.locator('[data-delta="D12"]')
  await expect(choice.or(page.locator('#confirm-import'))).toBeVisible()
  if (await choice.isVisible()) await choice.click()
  await page.locator('#confirm-import').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
}

test('empty start, navigation, import and unique boundary shift', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Анализ', exact: true }).click()
  await expect(page.getByText('Сначала добавьте график')).toBeVisible()
  await importRoster(page)
  await page.locator('[data-section="calendar"]').click()
  await expect(page.locator('#header-delta')).toHaveText('D12 ▾')
  await expect(page.locator('[data-day="2026-09-30"]')).toContainText('24')
  await page.locator('#list-mode').click()
  await expect(page.locator('.agenda-row')).toHaveCount(2)
  await page.reload()
  await expect(page.locator('.agenda-row')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('offline preserves dialog and cold offline launch can import PDF', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await importRoster(page)
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await page.locator('#settings').click()
  await context.setOffline(true)
  await expect(page.locator('#dialog')).toBeVisible()
  await expect(page.locator('#dialog')).toContainText('Нет сети')
  await page.locator('#dialog #close').click()
  await page.reload()
  await expect(page.locator('#header-delta')).toHaveText('D12 ▾')
  await importRoster(page, '12')
  await expect(page.locator('[data-day="2026-09-07"]')).toContainText('12')
})

test('replacement preview, rollback and backup round trip', async ({ page }) => {
  await page.goto('/')
  await importRoster(page)
  await page.locator('#file').setInputFiles(rosterPdf('12'))
  await expect(page.locator('#dialog')).toContainText('24 → 12')
  await page.locator('#confirm-import').click()
  await page.locator('[data-section="documents"]').click()
  await page.locator('[data-restore-month]').click()
  await page.locator('#confirm-revision').click()
  await expect(page.locator('[data-restore-month]')).toHaveCount(0)
  const downloadPromise = page.waitForEvent('download')
  await page.locator('#export-backup').click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).toBeTruthy()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('#import-backup').click()
  await (await chooserPromise).setFiles(path!)
  await expect(page.locator('#dialog')).toContainText('Месяцев: 1')
  await page.locator('#restore-backup').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
  await page.locator('[data-section="calendar"]').click()
  await expect(page.locator('[data-day="2026-09-07"]')).toContainText('24')
})

test('production CSP, keyboard focus and narrow layout', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('violates') && message.text().includes('Content Security Policy'))
      violations.push(message.text())
  })
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/')
  await importRoster(page)
  const clipped = await page
    .locator('.day')
    .evaluateAll((elements) =>
      elements.some(
        (el) =>
          el.getBoundingClientRect().right >
          document.querySelector('.calendar-viewport')!.getBoundingClientRect().right + 1,
      ),
    )
  expect(clipped).toBe(false)
  await page.locator('[data-day="2026-09-07"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-day="2026-09-07"]')).toBeFocused()
  await page.locator('[data-section="analysis"]').click()
  const width = await page
    .locator('.hours-bar i')
    .evaluate(
      (el) => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width,
    )
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThan(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(violations).toEqual([])
})

test('PWA update waits for the import confirmation and retains saved data', async ({ page }) => {
  const server = await updateServer()
  try {
    await page.goto(server.url)
    await importRoster(page)
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await page.reload()
    await page.waitForLoadState('networkidle')
    server.bump()
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update()
    })
    await expect(page.locator('#update-notice')).toBeVisible({ timeout: 15000 })
    await page.locator('#file').setInputFiles(rosterPdf('12'))
    await expect(page.locator('#confirm-import')).toBeVisible()
    // The modal makes the update control inaccessible until the user completes it.
    await expect(page.locator('#dialog')).toBeVisible()
    await page.locator('#confirm-import').click()
    await page.locator('#update-notice button').click()
    await expect(page.locator('[data-day="2026-09-07"]')).toContainText('12')
    await expect(page.locator('#header-delta')).toHaveText('D12 ▾')
  } finally {
    server.close()
  }
})
