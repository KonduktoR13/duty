import { chromium } from '@playwright/test'
import { readFile } from 'node:fs/promises'
const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch()
for (const [name, size, padding] of [
  ['icon-192', 192, 0],
  ['icon-512', 512, 0],
  ['apple-touch-icon', 180, 0],
  ['icon-maskable', 512, 90],
]) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })
  await page.setContent(
    `<style>body{margin:0;padding:${padding}px;background:#582c76}svg{display:block;width:100%;height:100%}</style>${svg}`,
  )
  await page.screenshot({ path: new URL(`../public/${name}.png`, import.meta.url).pathname })
  await page.close()
}
await browser.close()
