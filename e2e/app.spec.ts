import { test, expect, type Page } from '@playwright/test'
import { rosterPdf } from './fixture'
import { updateServer } from './update-server'
import { readFileSync } from 'node:fs'

const appVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

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
  await expect(ranking.locator(':scope > summary')).toContainText('D12: 1 из 2')
  await ranking.locator(':scope > summary').focus()
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
  // A background render retains both the ranking and an opened explanation.
  const explanation = ranking.locator('.workload-explanation')
  await expect(explanation).not.toHaveAttribute('open')
  await explanation.locator('summary').click()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(ranking).toHaveAttribute('open')
  await expect(explanation).toHaveAttribute('open')
  await page.locator('#prev').click()
  await expect(ranking).not.toHaveAttribute('open')
  await ranking.locator(':scope > summary').click()
  await expect(own.locator('td').nth(1)).toHaveText('40')
  await expect(own.locator('td').nth(2)).toHaveText('88')
  await page.locator('#header-delta').click()
  await page.locator('[data-select-delta="D40"]').click()
  await expect(ranking.locator(':scope > summary')).toContainText('D40: 2 из 2')
  await expect(own.locator('th')).toContainText('D40')
  await expect(own.locator('td').nth(1)).toHaveText('8')
  await expect(own.locator('td').nth(2)).toHaveText('16')
  await page.locator('[data-section="calendar"]').click()
  await page.locator('[data-section="analysis"]').click()
  await expect(ranking).not.toHaveAttribute('open')
})

test('workload headers switch the ranking, preserve focus and remember the selected sort', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/')
  await page.locator('#file').setInputFiles(rosterPdf('24', 'August', ['24', '24', '24', '24']))
  await page.locator('[data-delta="D12"]').click()
  await page.locator('#confirm-import').click()
  await expect(page.locator('#dialog')).not.toBeVisible()
  await importRoster(page)
  await page.locator('[data-section="analysis"]').click()
  const ranking = page.locator('#employee-workload')
  await ranking.locator(':scope > summary').click()
  const total = page.locator('#employee-workload-sort-total')
  const month = page.locator('#employee-workload-sort-month')
  const names = ranking.locator('tbody th')
  const monthlyOrder = ['D12Вы', 'D40']
  const totalOrder = ['D40', 'D12Вы']
  await expect(names).toHaveText(monthlyOrder)
  await expect(month.locator('..')).toHaveAttribute('aria-sort', 'descending')
  await total.focus()
  await page.keyboard.press('Enter')
  await expect(names).toHaveText(totalOrder)
  await expect(total).toBeFocused()
  await expect(ranking).toHaveAttribute('open')
  await expect(total.locator('..')).toHaveAttribute('aria-sort', 'descending')
  await expect(month.locator('..')).toHaveAttribute('aria-sort', 'none')
  await expect(total).toContainText('↓')
  await expect(ranking.locator(':scope > summary')).toContainText('D12: 2 из 2 · Всего')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    expect(await total.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    expect(await ranking.locator('table').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  // Repeated clicks retain descending order; selecting the other header switches the metric.
  await total.click()
  await expect(names).toHaveText(totalOrder)
  await month.click()
  await expect(names).toHaveText(monthlyOrder)
  await expect(ranking.locator(':scope > summary')).toContainText('D12: 1 из 2 · За месяц')
  await total.click()
  await expect(names).toHaveText(totalOrder)
  await page.locator('#prev').click()
  await expect(ranking).not.toHaveAttribute('open')
  await ranking.locator(':scope > summary').click()
  await expect(names).toHaveText(totalOrder)
  await expect(total.locator('..')).toHaveAttribute('aria-sort', 'descending')
  await page.reload()
  await page.locator('[data-section="analysis"]').click()
  await expect(ranking).not.toHaveAttribute('open')
  await ranking.locator(':scope > summary').click()
  await expect(names).toHaveText(totalOrder)
  await expect(total.locator('..')).toHaveAttribute('aria-sort', 'descending')
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
    await expect(page.locator('.settings-version')).toHaveText('Версия ' + appVersion)
  } finally {
    server.close()
  }
})

test('swiping from a calendar day never opens day details or the add editor', async ({ page }) => {
  await page.goto('/')
  await importRoster(page)
  const day = page.locator('[data-day="2026-09-16"]')
  await day.scrollIntoViewIfNeeded()
  const box = (await day.boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  // The first small move starts the month transition and replaces its cells.
  // Subsequent move/up events must still cancel the original day's hold timer.
  await page.mouse.move(x + 9, y)
  await page.mouse.move(x + 110, y, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('#picker')).toContainText('август', { ignoreCase: true })
  await page.waitForTimeout(750)
  await expect(page.locator('#dialog')).not.toBeVisible()
  await expect(page.locator('#shift-details')).toHaveCount(0)
  // An intentional tap on the new month still works normally.
  await page.locator('[data-day="2026-08-16"]').click()
  await expect(page.locator('#shift-details')).toBeVisible()
})

test('a slow cancelled calendar drag cancels long press without opening a day', async ({ page }) => {
  await page.goto('/')
  await importRoster(page)
  const day = page.locator('[data-day="2026-09-16"]')
  await day.scrollIntoViewIfNeeded()
  const box = (await day.boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 9, y)
  await page.mouse.move(x + 25, y)
  await page.waitForTimeout(600)
  await page.mouse.up()
  await page.waitForTimeout(750)
  await expect(page.locator('#picker')).toContainText('сентябрь', { ignoreCase: true })
  await expect(page.locator('#dialog')).not.toBeVisible()
  await expect(page.locator('#shift-details')).toHaveCount(0)
  const restored = (await page.locator('[data-day="2026-09-16"]').boundingBox())!
  await page.mouse.move(restored.x + restored.width / 2, restored.y + restored.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(600)
  await page.mouse.up()
  await expect(page.locator('[name="start"]')).toHaveValue('2026-09-16')
})

test.describe('touch calendar gestures', () => {
  test.use({ hasTouch: true, isMobile: true })
  test('touch swipes across day cells in both directions do not activate a day', async ({ page, context }) => {
    await page.goto('/')
    await importRoster(page)
    const input = await context.newCDPSession(page)
    for (const [date, delta, target] of [['2026-09-16', 110, 'август'], ['2026-08-19', -110, 'сентябрь']] as const) {
      const day = page.locator('[data-day="' + date + '"]')
      await day.scrollIntoViewIfNeeded()
      const box = (await day.boundingBox())!
      const x = box.x + box.width / 2, y = box.y + box.height / 2
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (const distance of [9, 35, Math.abs(delta)]) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.sign(delta) * distance, y }] })
        await page.waitForTimeout(25)
      }
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(page.locator('#picker')).toContainText(target, { ignoreCase: true })
      await page.waitForTimeout(750)
      await expect(page.locator('#dialog')).not.toBeVisible()
      await expect(page.locator('#shift-details')).toHaveCount(0)
    }
    await page.locator('[data-day="2026-09-16"]').tap()
    await expect(page.locator('#shift-details')).toBeVisible()
  })
})
