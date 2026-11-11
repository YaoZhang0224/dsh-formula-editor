/**
 * dsh-formula-editor — host half.
 *
 * Three same-origin routes, all under the plugin's own `/plugins/dsh-formula-editor/`
 * prefix so the browser page reaches them with its own session cookie and no CORS:
 *
 *   POST /plugins/dsh-formula-editor/ocr       image -> LaTeX through a vision model
 *   GET|POST /plugins/dsh-formula-editor/settings  read / write the OCR API key
 *   GET  /plugins/dsh-formula-editor/assets/*  the KaTeX font files the preview needs
 *
 * The key lives in the `credentials` seam under `FORMULA_OCR_API_KEY`, and the endpoint
 * and model come from this plugin's own config. Neither has a built-in default: the key
 * is posted to `baseURL` as a Bearer token together with the screenshot, so only the
 * user can say which service both of them belong to.
 */
import { promises as fsp } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(PKG_DIR, 'assets')

const ROUTE_OCR = '/plugins/dsh-formula-editor/ocr'
const ROUTE_SETTINGS = '/plugins/dsh-formula-editor/settings'
/**
 * No trailing slash: `webServer.match` accepts a prefix request only when the pathname
 * equals the prefix or continues with `/`, so the bare directory form is the one that
 * matches `/plugins/dsh-formula-editor/assets/katex/katex.min.js`.
 */
const ROUTE_ASSETS = '/plugins/dsh-formula-editor/assets'

/** The ref this plugin owns. */
const KEY_REF = 'FORMULA_OCR_API_KEY'

/**
 * No default endpoint and no default model.
 *
 * Both have to name the service the user's key belongs to, and only the user knows
 * that. A built-in default is not a convenience: the key is sent as a Bearer token
 * to whatever `baseURL` says, together with the screenshot, so a default pointing at
 * one particular vendor sends every unconfigured install's key to that vendor. The
 * plugin asks for the two values instead of guessing them.
 */
const DEFAULT_BASE_URL = ''
const DEFAULT_MODEL = ''

/** Request bodies above this are refused before parsing. */
const MAX_BODY_BYTES = 24 * 1024 * 1024

const MIME = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** The OCR instruction. The model is asked for the source only, so the reply needs no parsing. */
const OCR_PROMPT = [
  'You convert images of mathematical formulas into LaTeX.',
  'Return ONLY the LaTeX source for the formula in the image.',
  'Rules:',
  '- No markdown fences, no $$ delimiters, no explanation, no leading or trailing blank text.',
  '- Use standard LaTeX math commands (\\frac, \\sqrt, \\int, \\sum, \\begin{pmatrix} ... \\end{pmatrix}, ...).',
  '- Preserve subscripts, superscripts, limits, accents and delimiters exactly as drawn.',
  '- If the image holds several formulas, join them with \\\\ on one display line.',
  '- If the image holds no formula, return exactly: NONE',
].join('\n')

/** Stable Cordis plugin name. */
export const name = 'dsh-formula-editor'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/**
 * Plain-object config: `baseURL` / `model` / `apiKeyRef` are the only knobs.
 *
 * `apiKeyRef` defaults to the ref this plugin owns. `baseURL` and `model` default to
 * the empty string on purpose — they name the service the key belongs to, so the user
 * sets them; see {@link DEFAULT_BASE_URL}.
 */
export const Config = {
  type: 'object',
  dict: {
    baseURL: { type: 'string', meta: { default: DEFAULT_BASE_URL } },
    model: { type: 'string', meta: { default: DEFAULT_MODEL } },
    apiKeyRef: { type: 'string', meta: { default: KEY_REF } },
  },
  meta: { default: {} },
  '~standard': {
    version: 1,
    vendor: 'dsh-formula-editor',
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const pick = (key, fallback) => {
        const raw = source[key]
        return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback
      }
      return {
        value: {
          baseURL: pick('baseURL', DEFAULT_BASE_URL),
          model: pick('model', DEFAULT_MODEL),
          apiKeyRef: pick('apiKeyRef', KEY_REF),
        },
      }
    },
  },
}

/** Resolve the settings the routes run with. */
function settingsOf(config) {
  const baseURL = typeof config?.baseURL === 'string' && config.baseURL.length > 0 ? config.baseURL : DEFAULT_BASE_URL
  const model = typeof config?.model === 'string' && config.model.length > 0 ? config.model : DEFAULT_MODEL
  const apiKeyRef = typeof config?.apiKeyRef === 'string' && config.apiKeyRef.length > 0 ? config.apiKeyRef : KEY_REF
  return { baseURL: baseURL.replace(/\/+$/u, ''), model, apiKeyRef }
}

/**
 * Read the API key: only the ref this plugin owns.
 *
 * It deliberately does not fall back to the profile's other credentials. A key names
 * one service; the request goes to `baseURL`, which is a different value the user sets
 * independently. Borrowing `TONGJI_AI_API_KEY` or `DEEPSEEK_API_KEY` meant that a
 * profile holding only a DeepSeek key would have it sent to whichever endpoint the
 * config named — the user never agreed to that pairing.
 *
 * @returns the key and where it came from, or an empty value when nothing is configured.
 */
async function resolveKey(ctx, apiKeyRef) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return { value: '', source: 'unavailable' }
  try {
    const resolved = await credentials.resolve(apiKeyRef)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (value.length > 0) return { value, source: resolved.source ?? 'file', ref: apiKeyRef }
  } catch {
    /* a ref outside the grammar has no value to miss */
  }
  return { value: '', source: 'none' }
}

/** Whether a request came from the page this server serves. */
function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return true
  return origin === `http://${host}` || origin === `https://${host}`
}

/** Write one JSON reply. */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read a request body, refusing anything above the cap. */
function readBody(req) {
  return new Promise((accept, refuse) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        refuse(new Error('request-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      accept(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', refuse)
  })
}

/** Reject a non-POST or non-JSON request before reading it. */
function admitJson(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method-not-allowed' })
    return false
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    json(res, 415, { error: 'json-required' })
    return false
  }
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'origin-rejected' })
    return false
  }
  return true
}

/** Strip the wrappers a chat model adds around a bare source answer. */
export function cleanLatex(raw) {
  let text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  text = text.replace(/^```[a-zA-Z]*\s*/u, '').replace(/```$/u, '').trim()
  text = text.replace(/^\\\[/u, '').replace(/\\\]$/u, '').trim()
  text = text.replace(/^\\\(/u, '').replace(/\\\)$/u, '').trim()
  text = text.replace(/^\$\$/u, '').replace(/\$\$$/u, '').trim()
  text = text.replace(/^\$/u, '').replace(/\$$/u, '').trim()
  text = text.replace(/^latex\s*[:：]\s*/iu, '').trim()
  if (/^none$/iu.test(text)) return ''
  return text
}

/** Pull the assistant text out of an OpenAI-compatible completion. */
function completionText(payload) {
  const message = payload?.choices?.[0]?.message
  if (message === undefined || message === null) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

/**
 * Send one image to the vision model and return the LaTeX it reads.
 * @returns the cleaned source, or an empty string when the model found no formula.
 */
async function recognize({ baseURL, model, apiKey, dataUrl }) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`vision model answered ${String(response.status)}: ${text.slice(0, 400)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`vision model returned non-JSON: ${text.slice(0, 200)}`)
  }
  return cleanLatex(completionText(payload))
}

/** Answer one asset request out of the package's own `assets/` directory. */
async function serveAsset(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let relative
  try {
    relative = decodeURIComponent(pathname.slice(ROUTE_ASSETS.length + 1))
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (relative.length === 0) {
    res.writeHead(404)
    res.end()
    return
  }
  const target = resolve(normalize(join(ASSETS_DIR, relative)))
  if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body
  try {
    body = await fsp.readFile(target)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

/**
 * Mount the plugin's three routes.
 * @param ctx - plugin context carrying `webServer` (and, when present, `credentials`).
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_OCR,
      handler: (req, res) => {
        if (!admitJson(req, res)) return
        void (async () => {
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch (error) {
            json(res, error instanceof Error && error.message === 'request-too-large' ? 413 : 400, { error: 'invalid-request' })
            return
          }
          const dataUrl = typeof body?.image === 'string' ? body.image : ''
          if (!/^data:image\/[a-z0-9.+-]+;base64,/iu.test(dataUrl)) {
            json(res, 400, { error: 'invalid-image' })
            return
          }
          const key = await resolveKey(ctx, settings.apiKeyRef)
          if (key.value.length === 0) {
            json(res, 400, { error: 'api-key-missing', detail: 'Set the OCR API key in this plugin’s settings.' })
            return
          }
          if (settings.baseURL.length === 0 || settings.model.length === 0) {
            json(res, 400, {
              error: 'endpoint-missing',
              detail: 'Set the vision endpoint and model in this plugin’s settings: the key is sent to that endpoint, so the plugin does not pick one for you.',
            })
            return
          }
          try {
            const latex = await recognize({
              baseURL: settings.baseURL,
              model: settings.model,
              apiKey: key.value,
              dataUrl,
            })
            if (latex.length === 0) {
              json(res, 200, { latex: '', empty: true })
              return
            }
            json(res, 200, { latex })
          } catch (error) {
            json(res, 502, { error: 'ocr-failed', detail: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    }),
    'dsh-formula-editor: OCR route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_SETTINGS,
      handler: (req, res) => {
        void (async () => {
          const credentials = ctx.get('credentials')
          if (req.method === 'GET') {
            const key = await resolveKey(ctx, settings.apiKeyRef)
            let ownConfigured = false
            try {
              ownConfigured = (await credentials?.describe(settings.apiKeyRef))?.configured === true
            } catch {
              ownConfigured = false
            }
            json(res, 200, {
              configured: key.value.length > 0,
              ownConfigured,
              source: key.source,
              ref: settings.apiKeyRef,
              usingRef: key.ref ?? settings.apiKeyRef,
              baseURL: settings.baseURL,
              model: settings.model,
              writable: credentials !== undefined,
            })
            return
          }
          if (!admitJson(req, res)) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            json(res, 400, { error: 'invalid-request' })
            return
          }
          if (credentials === undefined) {
            json(res, 501, { error: 'credentials-unavailable' })
            return
          }
          try {
            if (body?.clear === true) {
              await credentials.unset(settings.apiKeyRef)
            } else {
              const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
              if (apiKey.length === 0) {
                json(res, 400, { error: 'empty-key' })
                return
              }
              await credentials.set(settings.apiKeyRef, apiKey)
            }
          } catch (error) {
            json(res, 500, { error: 'write-failed', detail: error instanceof Error ? error.message : String(error) })
            return
          }
          json(res, 200, { ok: true })
        })()
      },
    }),
    'dsh-formula-editor: settings route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_ASSETS,
      handler: (req, res) => {
        void serveAsset(req, res, new URL(req.url ?? '/', 'http://x').pathname).catch((error) => {
          ctx.logger?.warn?.(error)
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      },
    }),
    'dsh-formula-editor: KaTeX asset route',
  )
}
