/**
 * Orchestrator mode — control routes for the plugin's configuration page.
 *
 * The Client half is a plain page in the same origin, so it talks to the Host
 * over a small JSON API instead of a generated Remote namespace. The page edits
 * only the executor route and the review cadence; everything else stays in the
 * bundle patch (or the profile override).
 *
 * Writes go through `configEditor`: the page never rewrites the profile patch
 * itself. Ordinary fields keep the Loader's normal lifecycle, so saving a new
 * executor route reloads the plugin; that is reported to the page instead of
 * being hidden.
 */

import { pageConfig, pageDefaults } from './config.js'

export const ROUTE_PREFIX = '/plugins/orchestrator-mode'

const MAX_BODY_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 200
const MODEL_TIMEOUT_MS = 8000
const CATALOG_TTL_MS = 60 * 1000

/** A route-level failure with a stable code and an untranslated detail. */
class PanelError extends Error {
  /**
   * @param {string} code
   * @param {string} [detail]
   * @param {number} [status]
   */
  constructor(code, detail, status = 400) {
    super(detail === undefined ? code : detail)
    this.name = 'PanelError'
    this.code = code
    this.detail = detail
    this.status = status
  }
}

function detailOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new PanelError('bad-body', 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new PanelError('bad-body', 'request body is not JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PanelError('bad-body', 'request body must be a JSON object')
  }
  return value
}

function textField(value, field) {
  const text = String(value ?? '').trim()
  if (text.length > MAX_TEXT_CHARS) throw new PanelError('too-long', field)
  return text
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Build the HTTP handler for one runtime generation.
 * @param {import('./runtime.js').OrchestratorRuntime} runtime
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler(runtime) {
  const defaults = pageDefaults()
  /** @type {{ at: number, value: { ok: true, providers: unknown[] } } | undefined} */
  let catalogCache

  async function buildCatalog() {
    const llm = runtime.ctx.get('llm')
    if (!llm || typeof llm.listProviders !== 'function') return { ok: false, code: 'no-llm' }
    let described
    try {
      described = llm.listProviders()
    } catch (error) {
      return { ok: false, code: 'catalog-failed', detail: detailOf(error) }
    }
    const providers = []
    for (const provider of described) {
      const id = String(provider.id)
      const entry = { id, name: String(provider.name ?? provider.id), models: [] }
      try {
        const models = await withTimeout(llm.listModels(id), MODEL_TIMEOUT_MS, `${id}: model list timed out`)
        entry.models = models.map(model => ({
          id: String(model.id),
          name: String(model.name ?? model.id),
        }))
      } catch (error) {
        entry.error = detailOf(error)
      }
      providers.push(entry)
    }
    return { ok: true, providers }
  }

  async function catalog() {
    const now = Date.now()
    if (catalogCache !== undefined && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
    const value = await buildCatalog()
    if (value.ok) catalogCache = { at: now, value }
    return value
  }

  async function state() {
    const editor = runtime.ctx.get('configEditor')
    const entry = runtime.ctx.fiber?.entry
    let providerCatalog
    try {
      providerCatalog = await catalog()
    } catch (error) {
      providerCatalog = { ok: false, code: 'catalog-failed', detail: detailOf(error) }
    }
    const route = runtime.config.executorRoute
    return {
      ok: true,
      writable: editor !== undefined && entry !== undefined,
      config: pageConfig(runtime.config),
      defaults,
      route: route === null
        ? null
        : { provider: route.provider, model: route.model, effort: route.reasoningEffort ?? '' },
      warnings: [...runtime.config.warnings],
      providers: providerCatalog.ok ? providerCatalog.providers : [],
      catalogError: providerCatalog.ok
        ? undefined
        : { code: providerCatalog.code, detail: providerCatalog.detail ?? undefined },
      tools: { exit: runtime.config.exitToolName, enter: runtime.config.enterToolName },
      plan: {
        policy: 'deny',
        deny: [...runtime.config.planDenyTools],
      },
    }
  }

  async function efforts(url) {
    const provider = textField(url.searchParams.get('provider'), 'provider')
    const model = textField(url.searchParams.get('model'), 'model')
    if (provider.length === 0 || model.length === 0) throw new PanelError('missing-model', 'provider and model are required')
    const llm = runtime.ctx.get('llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function') throw new PanelError('no-llm', undefined, 409)
    try {
      const info = await withTimeout(llm.resolveModelInfo(provider, model), MODEL_TIMEOUT_MS, 'model lookup timed out')
      return {
        ok: true,
        reasoning: info.reasoning ?? null,
        contextWindow: info.context?.contextWindow ?? null,
      }
    } catch (error) {
      return { ok: false, code: 'model-unavailable', detail: detailOf(error) }
    }
  }

  async function save(req) {
    const editor = runtime.ctx.get('configEditor')
    const entry = runtime.ctx.fiber?.entry
    if (editor === undefined) throw new PanelError('no-editor', 'this profile cannot write configuration', 409)
    if (entry === undefined) throw new PanelError('no-entry', 'this plugin has no profile entry', 409)

    const body = await readJson(req)
    if (body.reset === true) {
      try {
        await editor.edit(entry, () => ({}))
      } catch (error) {
        throw new PanelError('reset-failed', detailOf(error), 409)
      }
      return { ok: true, reset: true, reloaded: true }
    }

    const executorProvider = textField(body.executorProvider, 'executorProvider')
    const executorModel = textField(body.executorModel, 'executorModel')
    const executorEffort = textField(body.executorEffort, 'executorEffort')
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new PanelError('bad-enabled', 'enabled must be a boolean')
    }
    const enabled = body.enabled === undefined ? runtime.config.enabled : body.enabled
    if (executorProvider.length > 0 && executorModel.length === 0) {
      throw new PanelError('missing-model', 'choose a model, or clear the provider to run single-model')
    }
    const rawReview = body.reviewEvery
    if (rawReview === '' || rawReview === null || rawReview === undefined) throw new PanelError('bad-review', 'reviewEvery is required')
    const reviewEvery = Number(rawReview)
    if (!Number.isInteger(reviewEvery) || reviewEvery < 0 || reviewEvery > 1000) {
      throw new PanelError('bad-review', String(rawReview))
    }

    try {
      await editor.edit(entry, (current, inherited) => ({
        // The page owns five fields only. Carry the inherited bundle layer
        // forward so advanced options in the bundle patch survive a save.
        ...inherited,
        ...(current ?? {}),
        enabled,
        executorProvider,
        executorModel: executorProvider.length === 0 ? '' : executorModel,
        executorEffort: executorProvider.length === 0 ? '' : executorEffort,
        reviewEvery,
      }))
    } catch (error) {
      throw new PanelError('save-failed', detailOf(error), 409)
    }
    return { ok: true, saved: true, reloaded: true }
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/u, '')
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (action === 'health' && method === 'GET') {
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'state' && method === 'GET') {
        sendJson(res, 200, await state())
        return
      }
      if (action === 'models' && method === 'GET') {
        const result = await catalog()
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      if (action === 'efforts' && method === 'GET') {
        sendJson(res, 200, await efforts(url))
        return
      }
      if (action === 'config' && method === 'POST') {
        sendJson(res, 200, await save(req))
        return
      }
      throw new PanelError('unknown-route', action.length === 0 ? 'missing action' : action, 404)
    } catch (error) {
      const known = error instanceof PanelError
      if (!known) runtime.warn('plugin page route failed', error)
      sendJson(res, known ? error.status : 500, {
        ok: false,
        code: known ? error.code : 'failed',
        ...(error instanceof Error && error.message.length > 0 ? { detail: error.message } : {}),
      })
    }
  }
}