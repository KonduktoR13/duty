import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname, sep } from 'node:path'

// Serve two worker editions without changing the workspace or other tests.
export async function updateServer() {
  let edition = 1
  const root = fileURLToPath(new URL('../dist/', import.meta.url))
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    const file = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname))
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const data = await readFile(file)
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      }
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-store')
      res.end(pathname === '/sw.js' ? data.toString() + `\n// Test edition ${edition}\n` : data)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    bump: () => edition++,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
