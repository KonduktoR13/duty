import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => ({
  // Set VITE_BASE=/repository-name/ for GitHub Pages served below a repository path.
  base: process.env.VITE_BASE || '/',
  plugins: [
    { name: 'development-style-policy', transformIndexHtml(html) { return command === 'serve' ? html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") : html } },
    VitePWA({
    registerType: 'prompt',
    includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon-maskable.png'],
    manifest: { name: 'Мои смены', short_name: 'Смены', description: 'Личный график смен — только на вашем устройстве', lang: 'ru', start_url: '.', display: 'standalone', background_color: '#f8f7fc', theme_color: '#582c76', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] },
    workbox: { navigateFallback: 'index.html', globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'], maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, cleanupOutdatedCaches: true }
  })]
}))
