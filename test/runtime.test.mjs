/**
 * Runtime checks with an in-memory fake of the DSH surfaces the plugin uses.
 * These do not prove UI behavior, but they exercise registration, the hand-off
 * tools, the gate, model switching and the forced-review wake path.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'
import { OrchestratorRuntime } from '../src/runtime.js'

function makeHarness(options = {}) {
  const sections = new Map()
  const contexts = new Map()
  const registrations = []
  const knownTools = new Set([
    'read', 'read_image', 'grep', 'glob', 'web_fetch', 'web_search', 'pwsh',
    'terminal_read', 'terminal_list', 'job_output', 'job_list', 'todo_write',
    'present', 'ask_user_question', 'skill', 'load_workspace_dependencies',
    'get_goal', 'schedule_list', 'schedule_view', 'user_terminal_list',
    'user_terminal_read', 'list_agents', 'list_subagent_models', 'wait_agent',
    'team_task_list', 'team_task_get', 'cordis_inspect_list', 'cordis_inspect_query',
    'write', 'edit', 'apply_patch', 'multi_edit', 'run_code', 'memory',
    'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close',
    'job_kill', 'workflow', 'subagent', 'subagent_fork', 'send_message',
    'session_manager', 'plugin_manager', 'schedule_create', 'schedule_edit',
    'create_goal', 'update_goal', 'team_task_create', 'team_task_update',
  ])
  const commands = []
  let guardFn = () => undefined
  const planMode = {
    value: options.planMode ?? { active: false, pending: false },
    get() {
      return this.value
    },
  }
  const logger = { warn: () => {}, info: () => {} }

  function fakeCtx() {
    return {
      effect(fn) {
        const disposer = fn()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      on() {
        return () => {}
      },
      get(name) {
        if (name === 'planMode') return planMode
        if (name === 'llm') return { listProviders: () => [{ id: 'magpie' }, { id: 'other' }] }
        return undefined
      },
      inject(_names, callback) {
        callback(commandCtx)
      },
      logger,
      tools: {
        guard(fn) {
          guardFn = fn
          return () => {}
        },
      },
      systemPrompt: {
        section(entry) {
          sections.set(entry.name, entry)
          return () => sections.delete(entry.name)
        },
        context(entry) {
          contexts.set(entry.name, entry)
          return () => contexts.delete(entry.name)
        },
      },
    }
  }

  const commandCtx = {
    effect(fn) {
      fn()
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
  }

  const agentCtx = {
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on() {
      return () => {}
    },
    tools: {
      register(definition, opts) {
        registrations.push({ definition, opts })
        return () => {
          const index = registrations.findIndex(entry => entry.definition === definition)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
      get(name) {
        return knownTools.has(name) ? { name } : undefined
      },
    },
  }

  let current = options.planner ?? { provider: 'magpie', model: 'strong' }
  const selections = []
  const steered = []
  const session = { id: 'session-1', header: { origin: 'root' } }
  const agent = {
    session,
    ctx: agentCtx,
    inbox: { nextStep: [], nextTurn: [] },
    model: {
      current: () => (current ? { ...current } : undefined),
      select: (selection) => {
        current = { ...selection }
        selections.push({ ...selection })
      },
    },
    steer: (message) => {
      steered.push(message)
    },
  }

  const ctx = fakeCtx()
  const config = resolveConfig({
    executorProvider: 'magpie',
    executorModel: 'fast',
    reviewEvery: 2,
        ...options.config,
  })
  const runtime = new OrchestratorRuntime(ctx, config)
  runtime.start()
  const state = runtime.attach(agent)

  return {
    runtime,
    state,
    agent,
    session,
    sections,
    contexts,
    registrations,
    commands,
    selections,
    steered,
    planMode,
    guard: exec => guardFn(exec),
    setCurrent(selection) {
      current = selection
    },
    current: () => current,
  }
}

test('start registers the phase section, hidden context, command and guard', () => {
  const h = makeHarness()
  assert.ok(h.sections.has('orchestrator:phase'))
  assert.ok(h.contexts.has('orchestrator:notice'))
  assert.equal(h.commands.length, 1)
  assert.equal(h.commands[0].name, 'orchestrate')
  assert.equal(h.registrations.length, 0, 'tools stay unregistered until enabled')
  assert.equal(h.guard({ agent: h.agent, name: 'write' }), undefined)
})

test('planning refuses the deny list and lets every other tool through', () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  // The gate is the only planning restriction: no tool-table filtering.
  assert.equal(h.guard({ agent: h.agent, name: 'pwsh' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'read' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'job_kill' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'subagent' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'team_task_create' }), undefined)
  assert.match(h.guard({ agent: h.agent, name: 'write' }), /^Plan mode is on, and write changes the workspace\./)
  assert.match(h.guard({ agent: h.agent, name: 'apply_patch' }), /changes the workspace/)
  assert.match(h.guard({ agent: h.agent, name: 'run_code' }), /changes the workspace/)
  assert.match(h.guard({ agent: h.agent, name: 'memory' }), /changes the workspace/)

  h.runtime.disable(h.state)
  assert.equal(h.guard({ agent: h.agent, name: 'write' }), undefined)
})

test('enabling on the executor model is refused instead of silently degrading', () => {
  // The session is on the executor model (a reload during execution, or a DSH
  // restart). Adopting it as the planner would turn both hand-offs into no-ops.
  const h = makeHarness({ planner: { provider: 'magpie', model: 'fast' } })
  const result = h.runtime.enable(h.state)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'planner-same-as-executor')
  assert.equal(h.state.active, false)
  assert.equal(h.state.plannerSelection, null)
  assert.equal(h.registrations.length, 0)

  const status = h.runtime.handleCommand({ agent: h.agent, rawInput: 'status', attachments: [] })
  assert.match(status.text, /当前模型就是执行模型/)

  const start = h.runtime.handleCommand({ agent: h.agent, rawInput: '', attachments: [] })
  assert.equal(start.kind, 'error')
  assert.match(start.text, /当前模型就是执行模型/)
  assert.match(start.text, /executorProvider/)
})

test('enable registers the two phase-scoped tools and switches phases', async () => {
  const h = makeHarness()
  const enabled = h.runtime.enable(h.state)
  assert.equal(enabled.ok, true)
  assert.equal(h.state.phase, 'plan')
  assert.equal(h.registrations.length, 2)
  assert.deepEqual(h.registrations.map(entry => entry.definition.name).sort(), [
    'orchestrator_enter_plan_mode',
    'orchestrator_exit_plan_mode',
  ])

  const exit = h.registrations.find(entry => entry.definition.name === 'orchestrator_exit_plan_mode')
  const enter = h.registrations.find(entry => entry.definition.name === 'orchestrator_enter_plan_mode')
  assert.equal(exit.opts.when({ agent: h.agent }), true)
  assert.equal(enter.opts.when({ agent: h.agent }), false)
  assert.match(h.sections.get('orchestrator:phase').text({ agent: h.agent }), /planning model/i)
  assert.match(h.guard({ agent: h.agent, name: 'write' }), /changes the workspace/)
  assert.equal(h.guard({ agent: h.agent, name: 'pwsh' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'read' }), undefined)

  const result = await exit.definition.execute({ plan: '# Plan\n\n1. do the thing' }, { agent: h.agent })
  assert.equal(result.ok, true)
  assert.match(result.message, /\[plan mode off\]/)
  assert.equal(h.state.phase, 'execute')
  assert.deepEqual(h.selections.at(-1), { provider: 'magpie', model: 'fast' })
  assert.equal(h.guard({ agent: h.agent, name: 'write' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'team_task_create' }), undefined)
  assert.equal(enter.opts.when({ agent: h.agent }), true)
  assert.match(h.sections.get('orchestrator:phase').text({ agent: h.agent }), /execution model/i)

  const back = await enter.definition.execute({ reason: 'test failed twice on step 2' }, { agent: h.agent })
  assert.equal(back.ok, true)
  assert.match(back.message, /\[plan review\]/)
  assert.match(back.message, /Editing tools are refused until orchestrator_exit_plan_mode is called/)
  assert.match(back.message, /<report>\ntest failed twice on step 2\n<\/report>/)
  assert.equal(h.state.phase, 'plan')
  assert.match(h.guard({ agent: h.agent, name: 'write' }), /changes the workspace/)
  assert.equal(h.guard({ agent: h.agent, name: 'team_task_create' }), undefined)
  assert.deepEqual(h.selections.at(-1), { provider: 'magpie', model: 'strong' })
})

test('gate blocks everything but the hand-off while a review is pending', () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  h.runtime.onSessionEvent(h.session, { type: 'turn/start' })
  h.state.phase = 'execute'
  h.runtime.onSessionEvent(h.session, { type: 'step/start' })
  h.runtime.onSessionEvent(h.session, { type: 'step/start' })
  h.runtime.onSessionEvent(h.session, { type: 'step/end' })
  assert.equal(h.state.pendingReview, true)
  assert.match(h.guard({ agent: h.agent, name: 'read' }), /plan review is due/)
  assert.match(h.guard({ agent: h.agent, name: 'write' }), /plan review is due/)
  assert.equal(h.guard({ agent: h.agent, name: 'orchestrator_enter_plan_mode' }), undefined)
  assert.match(h.contexts.get('orchestrator:notice').text({ agent: h.agent }), /\[plan review due\]/)
})

test('forced review wakes the executor and is bounded', () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  h.runtime.onSessionEvent(h.session, { type: 'turn/start' })
  h.state.phase = 'execute'
  h.runtime.onSessionEvent(h.session, { type: 'step/start' })
  h.runtime.onSessionEvent(h.session, { type: 'step/start' })
  h.runtime.onSessionEvent(h.session, { type: 'step/end' })

  const signal = new AbortController().signal
  h.runtime.onTurnStopping(h.state, { signal })
  assert.equal(h.steered.length, 1)
  assert.match(h.steered[0].content[0].text, /A plan review is due/)
  assert.equal(h.steered[0].source.kind, 'orchestrator')
  h.runtime.onTurnStopping(h.state, { signal })
  assert.equal(h.steered.length, 2)
  h.runtime.onTurnStopping(h.state, { signal })
  assert.equal(h.steered.length, 2, 'max two forced steers')

  h.agent.inbox.nextStep.push({ id: 'pending' })
  h.state.forcedSteers = 0
  h.runtime.onTurnStopping(h.state, { signal })
  assert.equal(h.steered.length, 2, 'no wake while input is already pending')
})

test('a user message during execution becomes a pending interruption', () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  h.runtime.onSessionEvent(h.session, { type: 'turn/start' })
  h.state.phase = 'execute'
  h.runtime.onSessionEvent(h.session, {
    type: 'agent/inbox/spliced',
    data: { target: 'next-step', inserted: [{ source: { kind: 'user' } }] },
  })
  assert.equal(h.state.pendingInterruption, true)
  assert.match(h.guard({ agent: h.agent, name: 'read' }), /plan review is due/)
})

test('a picker change during execution is recorded and corrected off the executor step', async () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  h.runtime.onSessionEvent(h.session, { type: 'turn/start' })

  // The tool result hands back; now execution runs on the executor.
  const exit = h.registrations.find(entry => entry.definition.name === 'orchestrator_exit_plan_mode')
  await exit.definition.execute({ plan: '# Plan' }, { agent: h.agent })
  assert.equal(h.current().model, 'fast')

  // A user pick is recorded as the next planner and the executor is restored.
  const pick = { provider: 'other', model: 'picker' }
  h.setCurrent(pick)
  h.runtime.onSessionEvent(h.session, { type: 'model/selection', data: pick })
  assert.deepEqual(h.state.plannerSelection, pick)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(h.selections.at(-1), { provider: 'magpie', model: 'fast' })
  assert.deepEqual(h.current(), { provider: 'magpie', model: 'fast' })
})

test('turn end resets the round and restores the planner model', async () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  const exit = h.registrations.find(entry => entry.definition.name === 'orchestrator_exit_plan_mode')
  await exit.definition.execute({ plan: '# Plan' }, { agent: h.agent })
  assert.equal(h.state.phase, 'execute')
  assert.equal(h.current().model, 'fast')

  h.runtime.onSessionEvent(h.session, { type: 'turn/end' })
  assert.equal(h.state.phase, 'plan')
  assert.equal(h.state.pendingReview, false)
  assert.match(h.guard({ agent: h.agent, name: 'write' }), /changes the workspace/)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.current().model, 'strong')
})

test('status and off restore the planner selection', () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  const status = h.runtime.handleCommand({ agent: h.agent, rawInput: 'status', attachments: [] })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /编排模式：已开启/)

  const off = h.runtime.handleCommand({ agent: h.agent, rawInput: 'off', attachments: [] })
  assert.equal(off.kind, 'success')
  assert.equal(h.state.active, false)
  assert.deepEqual(h.selections.at(-1), { provider: 'magpie', model: 'strong' })
  assert.equal(h.registrations.length, 0)
  assert.equal(h.sections.get('orchestrator:phase').text({ agent: h.agent }), '')
})

test('enabling while DSH plan mode is active is refused; the guard yields while suspended', () => {
  const h = makeHarness({ planMode: { active: true, pending: false } })
  const result = h.runtime.enable(h.state)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'plan-mode')

  // Simulate a running session that enters plan mode after enabling.
  h.planMode.value = { active: false, pending: false }
  h.runtime.enable(h.state)
  h.planMode.value = { active: true, pending: false }
  assert.equal(h.guard({ agent: h.agent, name: 'write' }), undefined)
  assert.equal(h.sections.get('orchestrator:phase').text({ agent: h.agent }), '')
  assert.equal(h.contexts.get('orchestrator:notice').text({ agent: h.agent }), '')

  // A picker change while suspended is remembered, but no model switch happens.
  const pick = { provider: 'other', model: 'suspended-pick' }
  h.runtime.onSessionEvent(h.session, { type: 'model/selection', data: pick })
  assert.deepEqual(h.state.plannerSelection, pick)
  assert.equal(h.selections.length, 0)

  // Leaving plan mode lets the normal pre-step backstop apply it.
  h.planMode.value = { active: false, pending: false }
  h.runtime.enforcePhaseModel(h.agent)
  assert.deepEqual(h.current(), pick)
})

test('single-model mode still gates, hands off and never switches models', async () => {
  const h = makeHarness({ config: { executorProvider: '', executorModel: '' } })
  h.runtime.enable(h.state)
  assert.equal(h.state.plannerSelection.model, 'strong')
  const exit = h.registrations.find(entry => entry.definition.name === 'orchestrator_exit_plan_mode')
  const result = await exit.definition.execute({ plan: '# Plan' }, { agent: h.agent })
  assert.equal(result.ok, true)
  assert.equal(h.selections.length, 0)
  assert.equal(h.current().model, 'strong')
  assert.equal(h.state.phase, 'execute')
  assert.equal(h.guard({ agent: h.agent, name: 'write' }), undefined)
})

test('invalid arguments and phase misuse are rejected without changing state', async () => {
  const h = makeHarness()
  h.runtime.enable(h.state)
  const exit = h.registrations.find(entry => entry.definition.name === 'orchestrator_exit_plan_mode')
  const enter = h.registrations.find(entry => entry.definition.name === 'orchestrator_enter_plan_mode')

  await assert.rejects(exit.definition.execute({ plan: '   ' }, { agent: h.agent }), /non-empty/)
  await assert.rejects(enter.definition.execute({ reason: 'x' }, { agent: h.agent }), /execution phase/)
  assert.equal(h.state.phase, 'plan')

  await exit.definition.execute({ plan: '# Plan' }, { agent: h.agent })
  await assert.rejects(exit.definition.execute({ plan: '# Again' }, { agent: h.agent }), /planning phase/)
  await assert.rejects(enter.definition.execute({ reason: ' ' }, { agent: h.agent }), /non-empty/)
  assert.equal(h.state.phase, 'execute')
})