/**
 * Static server for the browser harness: serves this directory at the root and
 * maps /plugins/dsh-formula-editor/* onto the plugin package, which is exactly
 * the shape the host half's asset route produces.
 *
 * It also accepts two coordination endpoints so a page under test can hand
 * artefacts to the driver script and wait for an acknowledgement:
 *   POST /__save?name=<file>   store the body under out/<file>, append to the log
 *   GET  /__state              {"log": [...]} in arrival order
 *
 * Run: node test/browser/serve.mjs
 */
import { createServer } from 'node:http'
import { promises as fsp } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const log = []

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/__save' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? ''
    if (!/^[\w.-]+$/.test(name)) {
      res.writeHead(400).end()
      return
    }
    await fsp.mkdir(OUT, { recursive: true })
    await fsp.writeFile(join(OUT, name), await readBody(req))
    log.push(name)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (pathname === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ log }))
    return
  }

  let target
  if (pathname.startsWith('/plugins/dsh-formula-editor/')) {
    target = resolve(join(PLUGIN, pathname.slice('/plugins/dsh-formula-editor/'.length)))
  } else {
    target = resolve(join(HERE, pathname === '/' ? 'index.html' : pathname.slice(1)))
  }
  if (target !== PLUGIN && !target.startsWith(PLUGIN + sep) && target !== HERE && !target.startsWith(HERE + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const body = await fsp.readFile(normalize(target))
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`not found: ${pathname}`)
  }
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  console.log(`harness: http://127.0.0.1:${port}/`)
})
