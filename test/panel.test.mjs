import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'
import { createHandler } from '../src/panel.js'

function makeRes() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body += payload ?? ''
    },
  }
}

function makeReq(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function invoke(handler, method, path, body) {
  const res = makeRes()
  await handler(makeReq(method, path, body), res)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

function harness({ llm = true } = {}) {
  const edits = []
  const editor = {
    async edit(entry, change) {
      const next = change(
        { executorProvider: 'old', custom: 1 },
        { activation: 'always', plannerPrompt: 'Inherited planner' },
      )
      edits.push({ entry, next })
    },
  }
  const model = {
    listProviders: () => [{ id: 'p', name: 'Provider P' }],
    listModels: async () => [{ id: 'm', name: 'Model M' }],
    resolveModelInfo: async () => ({
      reasoning: {
        defaultEffort: 'low',
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      },
      context: { contextWindow: 4096 },
    }),
  }
  const ctx = {
    fiber: { entry: { id: 'orchestrator-mode' } },
    get(key) {
      if (key === 'llm') return llm ? model : undefined
      if (key === 'configEditor') return editor
      return undefined
    },
  }
  const config = resolveConfig({
    executorProvider: 'p',
    executorModel: 'm',
    executorEffort: 'low',
    reviewEvery: 5,
  })
  const runtime = { ctx, config, warn() {} }
  return { handler: createHandler(runtime), edits, editor, model, runtime }
}

test('state describes the page fields, defaults and provider catalog', async () => {
  const h = harness()
  const { status, json } = await invoke(h.handler, 'GET', '/plugins/orchestrator-mode/state')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.writable, true)
  assert.deepEqual(json.config, {
    enabled: true,
    executorProvider: 'p',
    executorModel: 'm',
    executorEffort: 'low',
    reviewEvery: 5,
  })
  assert.equal(json.defaults.executorProvider, '')
  assert.equal(json.defaults.reviewEvery, 10)
  assert.deepEqual(json.route, { provider: 'p', model: 'm', effort: 'low' })
  assert.deepEqual(json.providers, [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }] }])
  assert.deepEqual(json.tools, {
    exit: 'orchestrator_exit_plan_mode',
    enter: 'orchestrator_enter_plan_mode',
  })
  assert.equal(json.plan.policy, 'deny')
  assert.ok(json.plan.deny.includes('write'))
  assert.ok(json.plan.deny.includes('apply_patch'))
  // run_code is the PTC transport: always callable, never in the deny list.
  assert.ok(!json.plan.deny.includes('run_code'))
  assert.ok(!json.plan.deny.includes('read'))
  assert.ok(!json.plan.deny.includes('pwsh'))
  assert.equal(json.plan.allow, undefined)
})

test('state degrades without an llm service', async () => {
  const h = harness({ llm: false })
  const { status, json } = await invoke(h.handler, 'GET', '/plugins/orchestrator-mode/state')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.providers, [])
  assert.equal(json.catalogError.code, 'no-llm')
  assert.equal(json.writable, true)
})

test('efforts returns the model reasoning metadata', async () => {
  const h = harness()
  const { status, json } = await invoke(
    h.handler,
    'GET',
    '/plugins/orchestrator-mode/efforts?provider=p&model=m',
  )
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(json.contextWindow, 4096)
})

test('efforts requires both a provider and a model', async () => {
  const h = harness()
  const { status, json } = await invoke(h.handler, 'GET', '/plugins/orchestrator-mode/efforts?provider=p')
  assert.equal(status, 400)
  assert.equal(json.code, 'missing-model')
})

test('saving writes the four page fields and preserves the rest of the row', async () => {
  const h = harness()
  const { status, json } = await invoke(
    h.handler,
    'POST',
    '/plugins/orchestrator-mode/config',
    JSON.stringify({
      enabled: false,
      executorProvider: 'p',
      executorModel: 'm2',
      executorEffort: 'high',
      reviewEvery: 3,
    }),
  )
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(h.edits.length, 1)
  assert.deepEqual(h.edits[0].next, {
    activation: 'always',
    plannerPrompt: 'Inherited planner',
    custom: 1,
    enabled: false,
    executorProvider: 'p',
    executorModel: 'm2',
    executorEffort: 'high',
    reviewEvery: 3,
  })
})

test('clearing the provider clears the model and effort', async () => {
  const h = harness()
  const { status, json } = await invoke(
    h.handler,
    'POST',
    '/plugins/orchestrator-mode/config',
    JSON.stringify({
      executorProvider: '',
      executorModel: 'ignored',
      executorEffort: 'ignored',
      reviewEvery: 0,
    }),
  )
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(h.edits[0].next.executorProvider, '')
  assert.equal(h.edits[0].next.executorModel, '')
  assert.equal(h.edits[0].next.executorEffort, '')
  assert.equal(h.edits[0].next.reviewEvery, 0)
})

test('a provider without a model is refused before writing', async () => {
  const h = harness()
  const { status, json } = await invoke(
    h.handler,
    'POST',
    '/plugins/orchestrator-mode/config',
    JSON.stringify({ executorProvider: 'p', executorModel: '', executorEffort: '', reviewEvery: 10 }),
  )
  assert.equal(status, 400)
  assert.equal(json.code, 'missing-model')
  assert.equal(h.edits.length, 0)
})

test('invalid JSON, review values and routes are refused', async () => {
  const h = harness()
  const bad = await invoke(h.handler, 'POST', '/plugins/orchestrator-mode/config', '{not json')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.code, 'bad-body')

  const review = await invoke(
    h.handler,
    'POST',
    '/plugins/orchestrator-mode/config',
    JSON.stringify({ executorProvider: '', executorModel: '', executorEffort: '', reviewEvery: -1 }),
  )
  assert.equal(review.status, 400)
  assert.equal(review.json.code, 'bad-review')

  const missing = await invoke(
    h.handler,
    'POST',
    '/plugins/orchestrator-mode/config',
    JSON.stringify({ executorProvider: '', executorModel: '', executorEffort: '' }),
  )
  assert.equal(missing.status, 400)
  assert.equal(missing.json.code, 'bad-review')

  const route = await invoke(h.handler, 'GET', '/plugins/orchestrator-mode/nope')
  assert.equal(route.status, 404)
  assert.equal(route.json.code, 'unknown-route')
})

test('reset writes an empty row config', async () => {
  const h = harness()
  const { status, json } = await invoke(
    h.handler,
    'POST',
    '/plugins/orchestrator-mode/config',
    JSON.stringify({ reset: true }),
  )
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.reset, true)
  assert.deepEqual(h.edits[0].next, {})
})

test('state marks the page read-only without configEditor', async () => {
  const h = harness()
  h.runtime.ctx.get = () => undefined
  const { status, json } = await invoke(h.handler, 'GET', '/plugins/orchestrator-mode/state')
  assert.equal(status, 200)
  assert.equal(json.writable, false)
})