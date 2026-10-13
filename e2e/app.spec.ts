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

test('header D-number picker closes on selection, repeated selection and cancel', async ({page}) => {
  await page.goto('/')
  await importRoster(page)
  await page.locator('#header-delta').click()
  await page.locator('[data-select-delta="D40"]').click()
  await expect(page.locator('#header-delta')).toHaveText('D40 ▾')
  await expect(page.locator('#dialog')).not.toBeVisible()
  await page.locator('#header-delta').click()
  await page.locator('[data-select-delta="D40"]').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
  await page.locator('#header-delta').click()
  await page.locator('#cancel').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
  await expect(page.locator('#header-delta')).toBeFocused()
})

test('settings picker returns to settings and closing stays accessible when scrolled', async ({page}) => {
  await page.setViewportSize({width:360,height:480})
  await page.emulateMedia({colorScheme:'dark'})
  await page.goto('/')
  await importRoster(page)
  await page.locator('#settings').click()
  await page.locator('#delta-settings').click()
  await page.locator('[data-select-delta="D40"]').click()
  await expect(page.locator('#dialog h2')).toHaveText('Настройки')
  await expect(page.locator('#delta-settings')).toContainText('D40')
  await page.locator('#delta-settings').click()
  await page.locator('#cancel').click()
  await expect(page.locator('#dialog h2')).toHaveText('Настройки')
  await page.locator('.dialog-content').evaluate(el=>el.scrollTop=el.scrollHeight)
  await expect(page.locator('#dialog #close')).toBeInViewport()
  await expect(page.locator('#wipe')).not.toBeVisible()
  await page.locator('#dialog #close').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
  await page.locator('#header-delta').click()
  await page.locator('[data-select-delta="D12"]').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
})

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

test('employee workload is collapsed, changes with the month and fits a narrow screen in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/')
  await page.locator('#file').setInputFiles(rosterPdf('24', 'August'))
  await page.locator('[data-delta="D12"]').click()
  await page.locator('#confirm-import').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
  await importRoster(page)
  await page.locator('[data-section="analysis"]').click()
  const ranking = page.locator('#employee-workload')
  await expect(ranking).not.toHaveAttribute('open')
  await expect(ranking.locator('summary')).toContainText('D12: 1 из 2')
  await ranking.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(ranking).toHaveAttribute('open')
  const own = ranking.locator('.employee-workload-own')
  await expect(own.locator('th')).toContainText('D12')
  await expect(own.locator('td').nth(1)).toHaveText('48')
  await expect(own.locator('td').nth(2)).toHaveText('88')
  await expect(ranking.locator('tbody tr')).toHaveCount(2)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    expect(await ranking.locator('table').evaluate(el => {
      const parent = el.closest('.employee-workload')!.getBoundingClientRect()
      return [...el.querySelectorAll('th, td')].every(cell => {
        const rect = cell.getBoundingClientRect()
        return rect.left >= parent.left && rect.right <= parent.right
      })
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  // A background network-status render must not collapse the open ranking.
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(ranking).toHaveAttribute('open')
  await page.locator('#prev').click()
  await expect(ranking).not.toHaveAttribute('open')
  await ranking.locator('summary').click()
  await expect(own.locator('td').nth(1)).toHaveText('40')
  await expect(own.locator('td').nth(2)).toHaveText('88')
  await page.locator('#header-delta').click()
  await page.locator('[data-select-delta="D40"]').click()
  await expect(ranking.locator('summary')).toContainText('D40: 2 из 2')
  await expect(own.locator('th')).toContainText('D40')
  await expect(own.locator('td').nth(1)).toHaveText('8')
  await expect(own.locator('td').nth(2)).toHaveText('16')
  await page.locator('[data-section="calendar"]').click()
  await page.locator('[data-section="analysis"]').click()
  await expect(ranking).not.toHaveAttribute('open')
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
    // Returning online checks the deployed worker without requiring a reload.
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(page.locator('#update-notice')).toBeVisible({ timeout: 15000 })
    await page.locator('#file').setInputFiles(rosterPdf('12'))
    await expect(page.locator('#confirm-import')).toBeVisible()
    // The modal makes the update control inaccessible until the user completes it.
    await expect(page.locator('#dialog')).toBeVisible()
    await page.locator('#confirm-import').click()
    await page.locator('#update-notice button').click()
    await expect(page.locator('[data-day="2026-09-07"]')).toContainText('12')
    await expect(page.locator('#header-delta')).toHaveText('D12 ▾')
    await page.locator('#settings').click()
    await expect(page.locator('.settings-version')).toHaveText('Версия 0.2.0')
  } finally {
    server.close()
  }
})
