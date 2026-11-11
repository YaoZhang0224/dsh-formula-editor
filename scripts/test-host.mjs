/**
 * Host-half smoke test: mount index.js against a fake context and exercise every
 * route the browser page will call. No DSH process involved.
 *
 * Run: node scripts/test-host.mjs
 */

import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const plugin = await import('../index.js')

/* The sample screenshot ships in test/fixtures so the live OCR check works from
 * a fresh clone; OCR_SAMPLE_IMAGE overrides it. */
const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE_IMAGE = process.env.OCR_SAMPLE_IMAGE !== undefined && process.env.OCR_SAMPLE_IMAGE.length > 0
  ? process.env.OCR_SAMPLE_IMAGE
  : [join(HERE, '..', 'test', 'fixtures', 'formula.png')].find((candidate) => existsSync(candidate))

assert.equal(plugin.name, 'dsh-formula-editor')
assert.deepEqual(plugin.inject, ['webServer', 'connection'])

/* ---------------------------------------------------------------- fakes */

const routes = new Map()

/**
 * A stand-in for DSH's `connection` service, holding just the fence semantics the
 * routes rely on: reject a non-loopback `Host`, a cross-site `sec-fetch-site`, an
 * `Origin` that disagrees with `Host`, and any request without the session cookie.
 * The real service lives in `@deepseek-ai/dsh-client-connection`; this fake exists so
 * the tests can drive each rejection without a running Harness.
 */
const SESSION_COOKIE = 'dsh-auth-test=valid'
const connection = {
  requestRejection(request) {
    const headers = request.headers
    const host = headers.host
    if (typeof host !== 'string') return 403
    const hostname = host.replace(/:\d+$/u, '')
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return 403
    if (headers['sec-fetch-site'] === 'cross-site') return 403
    if (typeof headers.origin === 'string' && new URL(headers.origin).host !== host) return 403
    const cookie = typeof headers.cookie === 'string' ? headers.cookie : ''
    return cookie.includes(SESSION_COOKIE) ? undefined : 401
  },
}

const ctx = {
  effect(callback, label) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register(route) {
      const key = `${route.kind} ${route.path}`
      if (routes.has(key)) throw new Error(`duplicate ${key}`)
      routes.set(key, route)
      return () => { routes.delete(key) }
    },
  },
  get(name) {
    if (name === 'credentials') return credentials
    if (name === 'connection') return connection
    return undefined
  },
  logger: { warn() {} },
}

/* The routes reach `connection` through Reflect.get, exactly as DSH's own host routes
 * do; expose the fake there too so both lookups agree. */
Object.defineProperty(ctx, 'connection', { value: connection, enumerable: true })

const secrets = new Map()
const credentials = {
  async resolve(ref) {
    const value = secrets.get(ref)
    return value === undefined ? undefined : { value, source: 'file' }
  },
  async describe(ref) {
    return { configured: secrets.has(ref), writable: true }
  },
  async set(ref, value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('empty')
    secrets.set(ref, value)
  },
  async unset(ref) {
    secrets.delete(ref)
  },
}

/**
 * One request/response round trip against a registered route.
 *
 * The default headers carry the browser-session cookie and a loopback `Host` because
 * every route now runs behind DSH's trust fence; pass `headers` to override either and
 * drive a rejection.
 */
function call(kind, path, { method = 'GET', body, headers = {}, url } = {}) {
  const route = routes.get(`${kind} ${path}`)
  assert.ok(route !== undefined, `route ${kind} ${path} is not registered`)
  return new Promise((accept) => {
    const chunks = []
    const req = {
      method,
      url: url ?? path,
      headers: { host: '127.0.0.1:55678', cookie: SESSION_COOKIE, ...headers },
      on(event, listener) {
        if (event === 'data' && body !== undefined) listener(Buffer.from(body, 'utf8'))
        if (event === 'end') listener()
      },
      destroy() {},
    }
    const res = {
      status: 0,
      headers: {},
      body: '',
      headersSent: false,
      writeHead(status, extra) {
        this.status = status
        this.headers = extra ?? {}
        this.headersSent = true
      },
      end(chunk) {
        if (chunk !== undefined) {
          this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        }
        accept(this)
      },
    }
    route.handler(req, res)
  })
}

/* ---------------------------------------------------------------- mount */

plugin.apply(ctx, {})

assert.deepEqual(
  [...routes.keys()].sort(),
  [
    'exact /plugins/dsh-formula-editor/ocr',
    'exact /plugins/dsh-formula-editor/settings',
    'prefix /plugins/dsh-formula-editor/assets',
  ],
)
console.log('routes registered: 3')

/* ---------------------------------------------------------------- assets */

const ASSET_ROUTE = '/plugins/dsh-formula-editor/assets'

/** Request one asset path; the route key stays fixed, only the URL varies. */
const asset = (url, options = {}) =>
  call('prefix', ASSET_ROUTE, { ...options, url: `${ASSET_ROUTE}${url}` })

const css = await asset('/katex/katex.min.css')
assert.equal(css.status, 200)
assert.match(css.headers['content-type'], /text\/css/)
assert.ok(css.body.includes('.katex'))

const font = await asset('/katex/fonts/KaTeX_Main-Regular.woff2')
assert.equal(font.status, 200)
assert.equal(font.headers['content-type'], 'font/woff2')

for (const name of ['temml.min.js', 'mathml2omml.js', 'tex2typst.min.js']) {
  const hit = await asset(`/vendor/${name}`)
  assert.equal(hit.status, 200, `${name} is served`)
  assert.match(hit.headers['content-type'], /javascript/)
}

/* Encoded dots survive URL normalization, so this really reaches the traversal guard. */
const traversal = await asset('/%2e%2e/%2e%2e/package.json')
assert.ok(traversal.status === 403 || traversal.status === 404, `traversal refused (${traversal.status})`)

const missing = await asset('/nope.css')
assert.equal(missing.status, 404)

const wrongMethod = await asset('/katex/katex.min.css', { method: 'POST' })
assert.equal(wrongMethod.status, 405)
console.log('assets route: css, fonts, vendor js, traversal, 404, 405 all correct')

/* -------------------------------------------------------------- settings */

const empty = await call('exact', '/plugins/dsh-formula-editor/settings')
assert.equal(empty.status, 200)
let state = JSON.parse(empty.body)
assert.equal(state.configured, false)
assert.equal(state.ownConfigured, false)
assert.equal(state.writable, true)
assert.equal(state.baseURL, '')
assert.equal(state.model, '')
console.log('settings GET (empty):', JSON.stringify(state))

const saved = await call('exact', '/plugins/dsh-formula-editor/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: 'sk-test-1234' }),
})
assert.equal(saved.status, 200)
assert.equal(secrets.get('FORMULA_OCR_API_KEY'), 'sk-test-1234')

state = JSON.parse((await call('exact', '/plugins/dsh-formula-editor/settings')).body)
assert.equal(state.configured, true)
assert.equal(state.ownConfigured, true)
assert.equal(state.usingRef, 'FORMULA_OCR_API_KEY')
console.log('settings POST then GET:', state.source, state.usingRef)

const blank = await call('exact', '/plugins/dsh-formula-editor/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: '   ' }),
})
assert.equal(blank.status, 400)

const cleared = await call('exact', '/plugins/dsh-formula-editor/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clear: true }),
})
assert.equal(cleared.status, 200)
assert.equal(secrets.has('FORMULA_OCR_API_KEY'), false)

/* The profile's other credentials are not borrowed: a key belongs to the service
 * named by baseURL, and pairing them without the user saying so is how a DeepSeek
 * key ends up posted to an unrelated endpoint. */
secrets.set('TONGJI_AI_API_KEY', 'sk-profile')
secrets.set('DEEPSEEK_API_KEY', 'sk-profile-deepseek')
state = JSON.parse((await call('exact', '/plugins/dsh-formula-editor/settings')).body)
assert.equal(state.configured, false)
assert.equal(state.ownConfigured, false)
secrets.delete('TONGJI_AI_API_KEY')
secrets.delete('DEEPSEEK_API_KEY')
console.log('settings: save, blank refusal, clear, no cross-credential fallback all correct')

/* ------------------------------------------------------------------- ocr */

const notPost = await call('exact', '/plugins/dsh-formula-editor/ocr', { method: 'GET' })
assert.equal(notPost.status, 405)

const notJson = await call('exact', '/plugins/dsh-formula-editor/ocr', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
})
assert.equal(notJson.status, 415)

/* The trust fence runs before anything else on every route. These four cases are the
 * ones a hand-rolled `Origin === Host` check lets through: a rebound DNS name is both
 * the `Host` and the `Origin`, and a scripted request simply omits the cookie. */
const cases = [
  ['cross-site origin', { origin: 'https://evil.example' }, 403],
  ['rebound host', { host: 'evil.example:55678' }, 403],
  ['rebound host with matching origin', { host: 'evil.example:55678', origin: 'https://evil.example:55678' }, 403],
  ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }, 403],
  ['no session cookie', { cookie: '' }, 401],
]
for (const [label, headers, status] of cases) {
  for (const [kind, path] of [
    ['exact', '/plugins/dsh-formula-editor/ocr'],
    ['exact', '/plugins/dsh-formula-editor/settings'],
    ['prefix', '/plugins/dsh-formula-editor/assets'],
  ]) {
    const blocked = await call(kind, path, {
      method: kind === 'exact' ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...headers },
      body: kind === 'exact' ? '{}' : undefined,
      url: path,
    })
    assert.equal(blocked.status, status, `${label} on ${path}`)
  }
}
console.log('trust fence: 403 on rebound host / cross-site / origin mismatch, 401 without cookie, on all 3 routes')

const noImage = await call('exact', '/plugins/dsh-formula-editor/ocr', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
})
assert.equal(noImage.status, 400)
assert.equal(JSON.parse(noImage.body).error, 'invalid-image')

const noKey = await call('exact', '/plugins/dsh-formula-editor/ocr', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
})
assert.equal(noKey.status, 400)
assert.equal(JSON.parse(noKey.body).error, 'api-key-missing')

/* A key alone is not enough: without baseURL/model the plugin refuses rather than
 * inventing an endpoint to post the key to. */
secrets.set('FORMULA_OCR_API_KEY', 'sk-test-1234')
const noEndpoint = await call('exact', '/plugins/dsh-formula-editor/ocr', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
})
assert.equal(noEndpoint.status, 400)
assert.equal(JSON.parse(noEndpoint.body).error, 'endpoint-missing')
secrets.delete('FORMULA_OCR_API_KEY')
console.log('ocr route: 405, 415, invalid-image, api-key-missing, endpoint-missing all correct')

/* A live round trip only when a key and an endpoint are really configured on this
 * machine. OCR_API_KEY / OCR_BASE_URL / OCR_MODEL let CI (or anyone without a DSH
 * profile) opt in explicitly. */
const yaml = (() => {
  if (typeof process.env.OCR_API_KEY === 'string' && process.env.OCR_API_KEY.length > 0) return ''
  try {
    return readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  } catch {
    return ''
  }
})()
const liveKey = process.env.OCR_API_KEY ?? /FORMULA_OCR_API_KEY:\s*(\S+)/.exec(yaml)?.[1]
const liveBaseURL = process.env.OCR_BASE_URL ?? ''
const liveModel = process.env.OCR_MODEL ?? ''

if (liveKey === undefined || liveBaseURL.length === 0 || liveModel.length === 0) {
  console.log('ocr live call: skipped (set OCR_API_KEY + OCR_BASE_URL + OCR_MODEL to run it)')
} else if (SAMPLE_IMAGE === undefined) {
  console.log('ocr live call: skipped (sample image not found beside the workspace)')
} else {
  secrets.set('FORMULA_OCR_API_KEY', liveKey)
  const png = readFileSync(SAMPLE_IMAGE).toString('base64')
  const started = Date.now()
  const live = await call('exact', '/plugins/dsh-formula-editor/ocr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: `data:image/png;base64,${png}` }),
  })
  const elapsed = Date.now() - started
  assert.equal(live.status, 200, `live OCR answered ${live.status}: ${live.body.slice(0, 300)}`)
  const answer = JSON.parse(live.body)
  assert.ok(typeof answer.latex === 'string' && answer.latex.length > 0, 'live OCR returned LaTeX')
  assert.ok(!/\$\$|```/.test(answer.latex), 'live OCR answer carries no delimiters')
  console.log(`ocr live call: ${elapsed}ms -> ${answer.latex}`)
}

console.log('\nHOST OK')
