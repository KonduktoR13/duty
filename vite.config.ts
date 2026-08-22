import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => ({
  // Set VITE_BASE=/repository-name/ for GitHub Pages served below a repository path.
  base: process.env.VITE_BASE || '/',
  plugins: [VitePWA({
    registerType: 'prompt',
    includeAssets: ['icon.svg'],
    manifest: { name: 'Мои смены', short_name: 'Смены', description: 'Личный график смен — только на вашем устройстве', lang: 'ru', start_url: '.', display: 'standalone', background_color: '#f8f7fc', theme_color: '#582c76', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] },
    workbox: { navigateFallback: 'index.html', globPatterns: ['**/*.{js,mjs,css,html,svg,woff2}'], maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, cleanupOutdatedCaches: true }
  })]
}))
