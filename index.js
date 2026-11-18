/**
 * dsh-formula-editor — host half.
 *
 * Two routes, both under the plugin's own `/plugins/dsh-formula-editor/` prefix so the
 * browser page reaches them with its own session cookie and no CORS:
 *
 *   POST /plugins/dsh-formula-editor/ocr        image -> LaTeX through a vision model
 *   GET|POST /plugins/dsh-formula-editor/settings  which model the editor uses
 *   GET  /plugins/dsh-formula-editor/assets/*   the KaTeX font files the preview needs
 *
 * Every route asks the composition's `connection` service for a rejection before it does
 * anything (`requestRejection`). That is DSH's own Host/Origin fence plus its
 * browser-session cookie: it rejects a `Host` that is not loopback or a configured
 * `trustedHosts` authority, a cross-site `sec-fetch-site`, an `Origin` that disagrees
 * with `Host`, and any request without a valid signed cookie. Comparing `Origin` with
 * `Host` alone is not enough — under DNS rebinding both carry the attacker's name.
 *
 * ## Why there is no API key here
 *
 * Recognition runs through DSH's own `llm` service, using a model the user already
 * configured in this Harness, and the picture is handed over as a normal image
 * attachment through the `attachments` service. The plugin therefore ships no endpoint,
 * no key, and no vendor: whatever the user pointed their Harness at is what reads the
 * image. That is also why nothing here can leak a credential — there is none to leak.
 *
 * The route the call uses, in order:
 *   1. this plugin's own `provider`/`model` config, when both are set;
 *   2. the Harness's current default model, when it accepts images;
 *   3. the first model in the provider catalog that accepts images.
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

/** No built-in route: an empty pair means "follow the Harness". */
const DEFAULT_PROVIDER = ''
const DEFAULT_MODEL = ''

/** Request bodies above this are refused before parsing. */
const MAX_BODY_BYTES = 24 * 1024 * 1024

/** Whole-call budget for one recognition, including queueing at the provider. */
const OCR_TIMEOUT_MS = 120_000

/** Plenty for one formula; a runaway answer is cut off rather than streamed forever. */
const MAX_OUTPUT_TOKENS = 4096

/** Image media types the `attachments` service accepts. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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

/**
 * Services required before the routes can mount.
 *
 * `connection` is not optional: it carries the only trust fence these routes have, so a
 * profile without it mounts nothing rather than mounting unguarded routes. `llm` and
 * `attachments` are reached optionally — a profile without them still serves the editor
 * and says so, instead of failing to load.
 */
export const inject = ['webServer', 'connection']

/**
 * Plain-object config: an optional `provider`/`model` override.
 *
 * Both default to the empty string, which means "use whatever this Harness is already
 * pointed at". Setting them pins recognition to one route.
 */
export const Config = {
  type: 'object',
  dict: {
    provider: { type: 'string', meta: { default: DEFAULT_PROVIDER } },
    model: { type: 'string', meta: { default: DEFAULT_MODEL } },
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
          provider: pick('provider', DEFAULT_PROVIDER),
          model: pick('model', DEFAULT_MODEL),
        },
      }
    },
  },
}

/** Resolve the settings the routes run with. */
function settingsOf(config) {
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : DEFAULT_PROVIDER
  const model = typeof config?.model === 'string' ? config.model.trim() : DEFAULT_MODEL
  return { provider, model }
}

/** Whether a resolved model advertises image input. */
function supportsImage(info) {
  const modalities = info?.inputModalities
  return Array.isArray(modalities) && modalities.includes('image')
}

/**
 * Every model in the provider catalog that accepts images.
 *
 * A catalog read is metadata only — it never calls the provider — so this is cheap
 * enough to run on a settings GET.
 */
async function listVisionModels(llm) {
  const found = []
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return found
  }
  for (const provider of Array.isArray(providers) ? providers : []) {
    let models
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of Array.isArray(models) ? models : []) {
      if (!supportsImage(model)) continue
      found.push({
        provider: provider.id,
        providerName: typeof provider.name === 'string' ? provider.name : provider.id,
        model: model.id,
        name: typeof model.name === 'string' ? model.name : model.id,
      })
    }
  }
  return found
}

/**
 * Choose the model one recognition call runs on.
 *
 * An explicit `provider`/`model` pair wins. Otherwise the Harness's current default
 * model is used when it can see images, and only then does the plugin fall back to the
 * first image-capable model in the catalog — so a user who picked a text-only model for
 * chat still gets working OCR, without configuring anything.
 *
 * @returns the chosen route plus where it came from, or a reason nothing could be chosen.
 */
async function pickRoute(ctx, settings) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) return { ok: false, error: 'llm-unavailable' }

  if (settings.provider.length > 0 && settings.model.length > 0) {
    let info
    try {
      info = await llm.resolveModelInfo(settings.provider, settings.model)
    } catch (error) {
      return {
        ok: false,
        error: 'model-unavailable',
        provider: settings.provider,
        model: settings.model,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    if (!supportsImage(info)) {
      return { ok: false, error: 'model-not-vision', provider: settings.provider, model: settings.model }
    }
    return { ok: true, provider: settings.provider, model: settings.model, source: 'config' }
  }

  let current
  try {
    current = ctx.get('agentDefaultModel')?.currentSelection?.()
  } catch {
    current = undefined
  }
  if (current !== undefined && current !== null && typeof current.provider === 'string' && typeof current.model === 'string') {
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      if (supportsImage(info)) {
        return { ok: true, provider: current.provider, model: current.model, source: 'default' }
      }
    } catch {
      /* a stale default is not an error: the catalog below may still answer */
    }
  }

  const candidates = await listVisionModels(llm)
  if (candidates.length === 0) return { ok: false, error: 'no-vision-model' }
  return { ok: true, provider: candidates[0].provider, model: candidates[0].model, source: 'auto' }
}

/**
 * The composition's `connection` service.
 *
 * Typed locally because the package is browser-side; `Reflect.get` mirrors how DSH's own
 * host routes (`@deepseek-ai/dsh-host-open-in-app`) reach the service.
 */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * Refuse a request DSH's trust fence will not admit.
 *
 * This is the plugin's whole admission story, and it is deliberately DSH's rather than a
 * hand-rolled check. `requestRejection` applies the Host/Origin fence (Host must be
 * loopback or a configured `trustedHosts` authority, `sec-fetch-site` must not be
 * cross-site, and `Origin` — when present — must agree with `Host`) and then the
 * browser-session cookie. A local `Origin === Host` comparison is not a substitute: under
 * DNS rebinding both headers carry the attacker's name, so it passes the attacker.
 *
 * @returns true when this request has been answered and the caller must stop.
 */
function rejectUntrusted(ctx, req, res) {
  const connection = connectionOf(ctx)
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    json(res, 503, { error: 'connection-unavailable' })
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  json(res, rejection, { error: rejection === 401 ? 'unauthenticated' : 'untrusted-request' })
  return true
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

/**
 * Split a `data:` URL into bytes and its media type.
 * @returns the decoded image, or undefined when the URL is not an accepted image.
 */
export function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return undefined
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/iu.exec(dataUrl)
  if (match === null) return undefined
  const mediaType = match[1].toLowerCase()
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) return undefined
  const data = Buffer.from(match[2], 'base64')
  if (data.length === 0) return undefined
  return { mediaType, data }
}

/**
 * Send one image to the chosen model through the Harness's own LLM service.
 *
 * The picture is published as a durable attachment first, so the request carries a
 * normal image block — exactly what the model would receive if the user had pasted the
 * same screenshot into a conversation. Only `text-delta` chunks are kept; a reasoning
 * model's thinking never reaches the LaTeX box.
 *
 * @returns the cleaned source, or an empty string when the model found no formula.
 */
async function recognize({ ctx, route, image }) {
  const llm = ctx.get('llm')
  const attachments = ctx.get('attachments')
  if (llm === undefined || llm === null) throw new Error('llm-unavailable')
  if (attachments === undefined || attachments === null) throw new Error('attachments-unavailable')

  const ref = await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: 'formula.png' })
  const signal = AbortSignal.timeout(OCR_TIMEOUT_MS)
  const prepared = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS }, signal)
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: OCR_PROMPT },
      { type: 'image', attachment: ref },
    ],
  }]
  let answer = ''
  let failure = ''
  for await (const chunk of prepared.stream({ ...prepared.config, messages, signal })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      answer += chunk.text
      continue
    }
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
      failure = chunk.reason.failure?.message ?? 'model-error'
    }
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') {
      failure = chunk.reason.failure?.message ?? 'aborted'
    }
  }
  if (failure.length > 0) throw new Error(failure)
  return cleanLatex(answer)
}

/**
 * Persist a chosen route into this plugin's own config.
 *
 * `configEditor` writes the profile layer, which is the same place the user would edit
 * by hand; when it is absent (a read-only profile) the choice still applies for the rest
 * of the session because the route is re-read from the returned settings.
 */
async function saveRoute(ctx, next) {
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor === undefined || editor === null || entry === undefined) return false
  try {
    await editor.edit(entry, (current) => ({ ...current, provider: next.provider, model: next.model }))
    return true
  } catch {
    return false
  }
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
 * @param ctx - plugin context carrying `webServer`, `connection`, `llm`, `attachments`.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_OCR,
      handler: (req, res) => {
        if (rejectUntrusted(ctx, req, res)) return
        if (!admitJson(req, res)) return
        void (async () => {
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch (error) {
            json(res, error instanceof Error && error.message === 'request-too-large' ? 413 : 400, { error: 'invalid-request' })
            return
          }
          const image = decodeImageDataUrl(typeof body?.image === 'string' ? body.image : '')
          if (image === undefined) {
            json(res, 400, { error: 'invalid-image' })
            return
          }
          const route = await pickRoute(ctx, settingsOf(config))
          if (route.ok !== true) {
            const detail = route.error === 'no-vision-model'
              ? '这台 DSH 里没有任何能看图的模型，请先在设置里配一个支持图片输入的模型。'
              : route.error === 'llm-unavailable'
                ? '当前 DSH 没有提供 llm 服务，无法识别图片。'
                : route.detail ?? ''
            json(res, 400, { error: route.error, detail, provider: route.provider ?? '', model: route.model ?? '' })
            return
          }
          try {
            const latex = await recognize({ ctx, route, image })
            if (latex.length === 0) {
              json(res, 200, { latex: '', empty: true, provider: route.provider, model: route.model })
              return
            }
            json(res, 200, { latex, provider: route.provider, model: route.model })
          } catch (error) {
            json(res, 502, {
              error: 'ocr-failed',
              detail: error instanceof Error ? error.message : String(error),
              provider: route.provider,
              model: route.model,
            })
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
        if (rejectUntrusted(ctx, req, res)) return
        void (async () => {
          if (req.method === 'GET') {
            const current = settingsOf(config)
            const route = await pickRoute(ctx, current)
            const llm = ctx.get('llm')
            const models = llm === undefined || llm === null ? [] : await listVisionModels(llm)
            json(res, 200, {
              ok: route.ok === true,
              error: route.ok === true ? '' : route.error,
              provider: route.ok === true ? route.provider : current.provider,
              model: route.ok === true ? route.model : current.model,
              source: route.ok === true ? route.source : 'none',
              pinned: current.provider.length > 0 && current.model.length > 0,
              models,
              llm: llm !== undefined && llm !== null,
              writable: ctx.get('configEditor') !== undefined && ctx.fiber?.entry !== undefined,
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
          /* `{ reset: true }` drops the pin and follows the Harness again. */
          const next = body?.reset === true
            ? { provider: '', model: '' }
            : {
                provider: typeof body?.provider === 'string' ? body.provider.trim() : '',
                model: typeof body?.model === 'string' ? body.model.trim() : '',
              }
          if (next.provider.length === 0 !== (next.model.length === 0)) {
            json(res, 400, { error: 'incomplete-route' })
            return
          }
          if (next.provider.length > 0) {
            const llm = ctx.get('llm')
            if (llm === undefined || llm === null) {
              json(res, 501, { error: 'llm-unavailable' })
              return
            }
            let info
            try {
              info = await llm.resolveModelInfo(next.provider, next.model)
            } catch (error) {
              json(res, 400, { error: 'model-unavailable', detail: error instanceof Error ? error.message : String(error) })
              return
            }
            if (!supportsImage(info)) {
              json(res, 400, { error: 'model-not-vision' })
              return
            }
          }
          const persisted = await saveRoute(ctx, next)
          const route = await pickRoute(ctx, next)
          json(res, 200, {
            ok: route.ok === true,
            persisted,
            provider: route.ok === true ? route.provider : '',
            model: route.ok === true ? route.model : '',
            source: route.ok === true ? route.source : 'none',
          })
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
        if (rejectUntrusted(ctx, req, res)) return
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
