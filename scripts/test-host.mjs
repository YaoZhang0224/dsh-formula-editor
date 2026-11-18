/**
 * Host-half smoke test: mount index.js against a fake context and exercise every
 * route the browser page will call. No DSH process involved.
 *
 * The fake exposes what the real Host does: `llm` (provider catalog + one streaming
 * call), `attachments` (image publishing), `agentDefaultModel` (the Harness default),
 * and `configEditor` (persisting a chosen route). The OCR path is therefore tested
 * end to end against a stub model, with no key and no network.
 *
 * Run: node scripts/test-host.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/* ------------------------------------------------------- model catalog */

const MODEL_REPLY = '\\int_{0}^{\\infty} \\frac{x^3}{e^x - 1} \\, dx = \\frac{\\pi^4}{15}'

const CATALOG = {
  'vision-ai': [
    { id: 'text-only', name: 'Text Only', inputModalities: ['text'] },
    { id: 'sees-images', name: 'Sees Images', inputModalities: ['text', 'image'] },
  ],
  'plain-ai': [
    { id: 'chat', name: 'Chat', inputModalities: ['text'] },
  ],
}

/** Every streamed call this run made, so the tests can assert on the request. */
const calls = []
let streamReply = MODEL_REPLY
let streamFailure = ''

function info(provider, id) {
  const found = (CATALOG[provider] ?? []).find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no such model ${provider}/${id}`)
  return { provider, ...found }
}

const llm = {
  listProviders() {
    return [{ id: 'vision-ai', name: 'Vision AI' }, { id: 'plain-ai', name: 'Plain AI' }]
  },
  async listModels(provider) {
    return (CATALOG[provider] ?? []).map((entry) => ({ provider, ...entry }))
  },
  async resolveModelInfo(provider, model) {
    return info(provider, model)
  },
  async prepareCall(config) {
    info(config.provider, config.model)
    const resolved = { ...config }
    return {
      config: resolved,
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      adapterDefaults: {},
      stream(options) {
        calls.push({ config: resolved, options })
        return (async function* chunks() {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          if (streamFailure.length > 0) {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: streamFailure, code: 'stub' } } }
            return
          }
          yield { type: 'text-delta', index: 0, text: streamReply }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: streamReply } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  },
}

/** Images published through `attachments`, keyed by the id handed back. */
const stored = new Map()
let nextAttachment = 1

const attachments = {
  async saveImage(input) {
    const attachmentId = `att-${nextAttachment++}`
    const ref = { attachmentId, mediaType: input.mediaType, bytes: input.data.length, width: 100, height: 40, name: input.name }
    stored.set(attachmentId, { ...ref, data: input.data })
    return ref
  },
}

let defaultSelection = { provider: 'vision-ai', model: 'sees-images' }
const agentDefaultModel = {
  currentSelection() { return { ...defaultSelection } },
}

const edits = []
const configEditor = {
  async edit(entry, change) {
    edits.push({ entry, change })
  },
}

const ctx = {
  effect(callback) {
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
  fiber: { entry: { id: 'include:dsh-formula-editor' } },
  get(name) {
    if (name === 'connection') return connection
    if (name === 'llm') return llm
    if (name === 'attachments') return attachments
    if (name === 'agentDefaultModel') return agentDefaultModel
    if (name === 'configEditor') return configEditor
    return undefined
  },
  logger: { warn() {} },
}

/* The routes reach `connection` through Reflect.get, exactly as DSH's own host routes
 * do; expose the fake there too so both lookups agree. */
Object.defineProperty(ctx, 'connection', { value: connection, enumerable: true })

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

const config = {}
plugin.apply(ctx, config)

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

const SETTINGS = '/plugins/dsh-formula-editor/settings'
const OCR = '/plugins/dsh-formula-editor/ocr'

let state = JSON.parse((await call('exact', SETTINGS)).body)
assert.equal(state.ok, true)
assert.equal(state.source, 'default', 'the Harness default model is followed with no configuration')
assert.equal(state.provider, 'vision-ai')
assert.equal(state.model, 'sees-images')
assert.equal(state.pinned, false)
assert.equal(state.writable, true)
assert.deepEqual(
  state.models.map((entry) => `${entry.provider}/${entry.model}`),
  ['vision-ai/sees-images'],
  'only image-capable models are offered',
)
console.log('settings GET (unconfigured):', state.provider, state.model, `(${state.models.length} vision model)`)

/* A text-only default falls back to the catalog instead of failing. */
defaultSelection = { provider: 'plain-ai', model: 'chat' }
state = JSON.parse((await call('exact', SETTINGS)).body)
assert.equal(state.ok, true)
assert.equal(state.source, 'auto')
assert.equal(state.provider, 'vision-ai')
assert.equal(state.model, 'sees-images')

/* No vision model anywhere is reported, not guessed. */
const savedCatalog = { ...CATALOG }
CATALOG['vision-ai'] = [{ id: 'text-only', name: 'Text Only', inputModalities: ['text'] }]
state = JSON.parse((await call('exact', SETTINGS)).body)
assert.equal(state.ok, false)
assert.equal(state.error, 'no-vision-model')
CATALOG['vision-ai'] = savedCatalog['vision-ai']
console.log('settings: follows the default, falls back to the catalog, reports an empty catalog')

/* Pinning a route persists through configEditor; a text-only pin is refused. */
let pinned = await call('exact', SETTINGS, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'vision-ai', model: 'sees-images' }),
})
assert.equal(pinned.status, 200)
assert.equal(edits.length, 1, 'the pin was written through configEditor')
assert.deepEqual(edits[0].change({}), { provider: 'vision-ai', model: 'sees-images' })

pinned = await call('exact', SETTINGS, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'plain-ai', model: 'chat' }),
})
assert.equal(pinned.status, 400)
assert.equal(JSON.parse(pinned.body).error, 'model-not-vision')

pinned = await call('exact', SETTINGS, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'vision-ai', model: 'nope' }),
})
assert.equal(pinned.status, 400)
assert.equal(JSON.parse(pinned.body).error, 'model-unavailable')

pinned = await call('exact', SETTINGS, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'vision-ai' }),
})
assert.equal(pinned.status, 400)
assert.equal(JSON.parse(pinned.body).error, 'incomplete-route')
console.log('settings POST: pin persists, text-only and unknown models and half a route are refused')

/* `{ reset: true }` drops the pin, so the config is empty again. The fake
 * `configEditor` only records the write, so the test clears the live config the way a
 * real profile reload would. */
config.provider = 'vision-ai'
config.model = 'sees-images'
defaultSelection = { provider: 'vision-ai', model: 'sees-images' }
pinned = await call('exact', SETTINGS, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reset: true }),
})
assert.equal(pinned.status, 200)
assert.deepEqual(edits.at(-1).change({}), { provider: '', model: '' })
config.provider = ''
config.model = ''
assert.equal(JSON.parse(pinned.body).source, 'default', 'reset follows the Harness again')
console.log('settings POST: reset drops the pin and follows the Harness again')

/* ------------------------------------------------------------------- ocr */

const notPost = await call('exact', OCR, { method: 'GET' })
assert.equal(notPost.status, 405)

const notJson = await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{}',
})
assert.equal(notJson.status, 415)

/* The trust fence runs before anything else on every route. These five cases are the
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
    ['exact', OCR],
    ['exact', SETTINGS],
    ['prefix', ASSET_ROUTE],
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

const noImage = await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
})
assert.equal(noImage.status, 400)
assert.equal(JSON.parse(noImage.body).error, 'invalid-image')

/* A `data:` URL that is not one of the four accepted image types is refused before
 * anything is written to the attachment store. */
const storedBefore = stored.size
const notAnImage = await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: 'data:text/plain;base64,aGk=' }),
})
assert.equal(notAnImage.status, 400)
assert.equal(JSON.parse(notAnImage.body).error, 'invalid-image')
assert.equal(stored.size, storedBefore, 'a refused image writes nothing')

/* A live round trip through the stub model: the picture is published as an attachment
 * and the request carries a normal image block, exactly as a pasted screenshot would. */
const png = SAMPLE_IMAGE === undefined
  ? Buffer.from('89504e470d0a1a0a', 'hex')
  : readFileSync(SAMPLE_IMAGE)
const dataUrl = `data:image/png;base64,${png.toString('base64')}`
const started = Date.now()
const recognised = await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: dataUrl }),
})
const elapsed = Date.now() - started
assert.equal(recognised.status, 200, `OCR answered ${recognised.status}: ${recognised.body.slice(0, 300)}`)
const answer = JSON.parse(recognised.body)
assert.equal(answer.latex, MODEL_REPLY)
assert.equal(answer.provider, 'vision-ai')
assert.equal(answer.model, 'sees-images')
assert.equal(calls.length, 1, 'exactly one model call')
assert.equal(calls[0].config.maxTokens, 4096)
const content = calls[0].options.messages[0].content
assert.equal(content.length, 2, 'a text instruction and one image')
assert.equal(content[0].type, 'text')
assert.ok(content[0].text.includes('LaTeX'))
assert.equal(content[1].type, 'image')
const published = stored.get(content[1].attachment.attachmentId)
assert.ok(published !== undefined, 'the image was published through attachments')
assert.equal(published.mediaType, 'image/png')
assert.deepEqual([...published.data], [...png], 'the published bytes are the uploaded bytes')
assert.ok(!('apiKey' in calls[0].config), 'no credential is involved anywhere')
console.log(`ocr: ${elapsed}ms -> ${answer.latex}`)

/* `NONE` from the model means "no formula", not an error. */
streamReply = 'NONE'
const none = JSON.parse((await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: dataUrl }),
})).body)
assert.equal(none.empty, true)
assert.equal(none.latex, '')

/* Fenced and delimited answers are unwrapped. */
streamReply = '```latex\n\\frac{a}{b}\n```'
const fenced = JSON.parse((await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: dataUrl }),
})).body)
assert.equal(fenced.latex, '\\frac{a}{b}')

/* A model-side failure is a 502 that names the model, not a silent empty answer. */
streamFailure = 'the model fell over'
const failed = await call('exact', OCR, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image: dataUrl }),
})
assert.equal(failed.status, 502)
assert.equal(JSON.parse(failed.body).error, 'ocr-failed')
assert.ok(JSON.parse(failed.body).detail.includes('the model fell over'))
streamFailure = ''
streamReply = MODEL_REPLY
console.log('ocr route: 405, 415, invalid-image, NONE, fenced answer, model failure all correct')

/* A profile without `llm` says so instead of pretending the image was unreadable. */
const bare = {
  effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
  webServer: ctx.webServer,
  fiber: { entry: { id: 'bare' } },
  get(name) { return name === 'connection' ? connection : undefined },
  logger: { warn() {} },
}
Object.defineProperty(bare, 'connection', { value: connection, enumerable: true })
const bareRoutes = new Map()
bare.webServer = { register(route) { bareRoutes.set(`${route.kind} ${route.path}`, route); return () => {} } }
plugin.apply(bare, {})
const bareOcr = await new Promise((accept) => {
  const route = bareRoutes.get(`exact ${OCR}`)
  const req = {
    method: 'POST',
    url: OCR,
    headers: { host: '127.0.0.1:55678', cookie: SESSION_COOKIE, 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(JSON.stringify({ image: dataUrl }), 'utf8'))
      if (event === 'end') listener()
    },
    destroy() {},
  }
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); accept(this) },
  }
  route.handler(req, res)
})
assert.equal(bareOcr.status, 400)
assert.equal(JSON.parse(bareOcr.body).error, 'llm-unavailable')
console.log('ocr route: a profile without llm is reported as llm-unavailable')

console.log('\nHOST OK')
