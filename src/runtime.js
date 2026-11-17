/**
 * Orchestrator mode — Host runtime.
 *
 * One per profile. It owns the per-Agent phase state, switch the session model at
 * hand-offs, registers the two hand-off tools on the Agent scope, gates tools
 * while planning or during a forced review, and turns the two tool results into
 * the hidden steps the reference protocol expects.
 */

import { randomUUID } from 'node:crypto'
import * as machine from './state.js'
import * as prompts from './prompts.js'

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
  },
  required: ['ok', 'message'],
})

const SUMMARY_MAX = 120

/** @param {string} text */
function summaryOf(text) {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`
}

export class OrchestratorRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {ReturnType<import('./config.js').resolveConfig>} config
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<unknown, machine.OrchestratorState>} */
    this.states = new Map()
    /** @type {Map<string, machine.OrchestratorState>} */
    this.bySession = new Map()
    /** @type {Array<() => void>} */
    this.disposers = []
    this.closed = false
    this.adoptReport = null
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start() {
    const ctx = this.ctx

    this.disposers.push(ctx.effect(
      () => ctx.tools.guard(exec => this.guard(exec)),
      'orchestrator-mode: phase gate',
    ))

    this.disposers.push(ctx.effect(
      () => ctx.systemPrompt.section({
        name: 'orchestrator:phase',
        order: this.config.sectionOrder,
        interpolate: false,
        text: (context) => {
          const state = this.stateOfAgent(context?.agent)
          if (!state || !state.active || this.isSuspended(state)) return ''
          const labels = this.labels(state)
          return state.phase === 'plan'
            ? prompts.plannerSection(this.config, labels)
            : prompts.executorSection(this.config, labels)
        },
      }),
      'orchestrator-mode: phase section',
    ))

    this.disposers.push(ctx.effect(
      () => ctx.systemPrompt.context({
        name: 'orchestrator:notice',
        order: this.config.contextOrder,
        interpolate: false,
        text: (context) => {
          const state = this.stateOfAgent(context?.agent)
          if (!state || !state.active || this.isSuspended(state)) return ''
          return prompts.noticeText(this.config, state, this.labels(state))
        },
      }),
      'orchestrator-mode: notice context',
    ))

    this.disposers.push(ctx.on('agent/created', payload => this.attach(payload?.agent)))
    this.disposers.push(ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)))
    // Selection changes must never happen inside a session/event publication
    // (Session.append refuses reentry). This waterfall runs outside publication
    // and is a backstop: the loop captured this step's selection before calling
    // it, so it can only correct the following step. The real switches happen in
    // the hand-off tools, in the turn/end microtask, and after a picker change.
    this.disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent
      if (agent && !this.states.has(agent)) this.attach(agent)
      this.enforcePhaseModel(agent)
      return next()
    }))

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(
        () => commandCtx.commands.register({
          definitionId: '@local/dsh-orchestrator-mode',
          name: 'orchestrate',
          description: 'Enter or leave Orchestrator mode (two-model planning/execution in one conversation)',
          input: { hint: '[off|status|message]', attachments: true },
          handler: payload => this.handleCommand(payload),
        }),
        'orchestrator-mode: command',
      )
    })

    this.adoptReport = this.adoptLiveAgents()
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    for (const state of this.states.values()) this.disposeTools(state)
    this.states.clear()
    this.bySession.clear()
    for (const dispose of this.disposers.splice(0).reverse()) {
      if (typeof dispose !== 'function') continue
      try {
        dispose()
      } catch {
        /* a disposed scope may already have removed the registration */
      }
    }
  }

  /**
   * Adopt agents that already exist when the plugin activates (profile reload).
   * @returns {{ available: boolean, listed?: number, attached?: number }}
   */
  adoptLiveAgents() {
    const agents = this.ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') return { available: false }
    let list
    try {
      list = agents.list()
    } catch {
      return { available: true, listed: 0, attached: 0, error: 'list failed' }
    }
    let attached = 0
    for (const agent of list) {
      if (this.attach(agent)) attached += 1
    }
    return { available: true, listed: list.length, attached }
  }

  /**
   * Attach one Agent. Runs synchronously from agent/created so prompt
   * registrations and activation are in place before the first assembly.
   *
   * @param {unknown} agent
   * @returns {machine.OrchestratorState | undefined}
   */
  attach(agent) {
    if (this.closed || !agent || this.states.has(agent)) return this.states.get(agent)
    const session = agent.session
    if (!session) return undefined
    if (!this.config.includeSubagents && session.header?.origin === 'subagent') return undefined

    const state = machine.createState(agent, session.id)
    this.states.set(agent, state)
    this.bySession.set(session.id, state)

    try {
      this.disposers.push(agent.ctx.effect(
        () => agent.ctx.on('agent/turn-stopping', payload => this.onTurnStopping(state, payload)),
        'orchestrator-mode: turn stopping',
      ))
    } catch (error) {
      this.warn('failed to register turn-stopping listener', error)
    }

    try {
      this.disposers.push(agent.ctx.effect(
        () => () => {
          this.disposeTools(state)
          this.states.delete(agent)
          if (this.bySession.get(session.id) === state) this.bySession.delete(session.id)
        },
        'orchestrator-mode: state cleanup',
      ))
    } catch (error) {
      this.warn('failed to register state cleanup', error)
    }

    if (this.config.activation === 'always') {
      const result = this.enable(state)
      if (!result.ok) this.warn(`automatic enable skipped (${result.reason})`, result.error)
    }
    return state
  }

  // ── activation ────────────────────────────────────────────────────────────

  /**
   * @param {machine.OrchestratorState} state
   * @returns {{ ok: true, already?: boolean } | { ok: false, reason: string, error?: string, providers?: string[] }}
   */
  enable(state) {
    if (this.closed) return { ok: false, reason: 'closed' }
    if (!this.config.enabled) return { ok: false, reason: 'disabled' }
    if (this.isSuspended(state)) return { ok: false, reason: 'plan-mode' }
    if (state.active) return { ok: true, already: true }

    const route = this.config.executorRoute
    const current = this.modelOf(state)
    // A reload or a restart leaves the session on the executor model. Adopting
    // it as the planner would make both hand-offs no-ops with no error, so the
    // mode refuses to start and the command explains how to recover.
    if (route && current && machine.sameSelection(current, route)) {
      return { ok: false, reason: 'planner-same-as-executor', error: machine.routeLabel(route) }
    }
    if (route) {
      const llm = this.ctx.get('llm')
      if (llm && typeof llm.listProviders === 'function') {
        let providers = []
        try {
          providers = llm.listProviders().map(provider => provider.id).filter(id => typeof id === 'string')
        } catch {
          providers = []
        }
        if (providers.length > 0 && !providers.includes(route.provider)) {
          return {
            ok: false,
            reason: 'provider',
            error: `unknown provider "${route.provider}"`,
            providers,
          }
        }
      }
    }

    machine.activate(state, current, route)
    const failure = this.registerTools(state)
    if (failure) {
      machine.deactivate(state)
      this.disposeTools(state)
      return { ok: false, reason: 'tools', error: failure }
    }
    return { ok: true }
  }

  /**
   * @param {machine.OrchestratorState} state
   * @returns {{ already?: boolean, restored: machine.ModelSelection | null }}
   */
  disable(state) {
    if (!state.active) return { already: true, restored: null }
    const restore = machine.copySelection(state.plannerSelection) ?? this.modelOf(state)
    machine.deactivate(state)
    this.disposeTools(state)
    state.plannerSelection = null
    if (restore) this.selectRoute(state, restore)
    return { restored: restore }
  }

  /**
   * @param {machine.OrchestratorState} state
   * @returns {string | null} registration failure, or null
   */
  registerTools(state) {
    if (state.toolDisposers.length > 0) return null
    const definitions = [this.exitTool(state), this.enterTool(state)]
    const disposers = []
    try {
      for (const definition of definitions) {
        const dispose = state.agent.ctx.tools.register(definition, {
          when: (activation) => {
            if (activation?.agent !== undefined && activation.agent !== state.agent) return false
            return machine.toolAvailable(state, definition.name, this.config, this.isSuspended(state))
          },
        })
        disposers.push(dispose)
      }
      state.toolDisposers.push(...disposers)
      return null
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** @param {machine.OrchestratorState} state */
  disposeTools(state) {
    for (const dispose of state.toolDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }

  // ── model selection ───────────────────────────────────────────────────────

  /** @param {machine.OrchestratorState} state */
  modelOf(state) {
    try {
      return machine.copySelection(state.agent.model?.current?.())
    } catch {
      return null
    }
  }

  /**
   * The session-selected model, unless it is the configured executor route.
   * Handing control to the executor as the "planner" would make the next
   * hand-back a no-op, so it is never recorded as a planner selection.
   *
   * @param {machine.OrchestratorState} state
   * @returns {machine.ModelSelection | null}
   */
  plannerCandidate(state) {
    const current = this.modelOf(state)
    const route = this.config.executorRoute
    if (!current) return null
    if (route && machine.sameSelection(current, route)) return null
    return current
  }

  /**
   * Select a route without letting the model-selection listener treat it as a
   * user pick.
   *
   * @param {machine.OrchestratorState} state
   * @param {machine.ModelSelection} selection
   * @returns {boolean}
   */
  selectRoute(state, selection) {
    if (!selection) return false
    state.internalSelection = true
    try {
      state.agent.model.select(selection)
      return true
    } catch (error) {
      this.warn(`failed to select ${machine.routeLabel(selection)}`, error)
      return false
    } finally {
      state.internalSelection = false
    }
  }

  /**
   * @param {machine.OrchestratorState} state
   * @param {unknown} selection
   */
  onModelSelection(state, selection) {
    if (this.closed || !state.active || state.internalSelection) return
    // Record the pick even while DSH plan mode suspends the protocol: the user's
    // planner choice must survive the suspension. Only the corrective switch is
    // deferred.
    const { correctTo } = machine.applyModelSelection(state, selection, this.config.executorRoute)
    if (correctTo && !this.isSuspended(state)) this.scheduleCorrection(state)
  }

  /**
   * Restore the configured executor after a model-picker change during
   * execution. Runs after the `model/selection` publication closes.
   *
   * @param {machine.OrchestratorState} state
   */
  scheduleCorrection(state) {
    const token = state.correction
    const route = this.config.executorRoute
    if (!token || !route) return
    queueMicrotask(() => {
      if (this.closed || !state.active || state.phase !== 'execute') return
      if (state.correction !== token) return
      if (this.isSuspended(state)) return
      const current = this.modelOf(state)
      if (!machine.sameSelection(current, token.selection)) return
      this.selectRoute(state, route)
    })
  }

  /**
   * Defensive backstop run in `agent/pre-step`. The loop captured the step's
   * selection before this waterfall, so this can only correct the *following*
   * step; the real switches happen in the hand-off tools, at turn end, and in
   * the picker-change microtask above.
   *
   * @param {unknown} agent
   */
  enforcePhaseModel(agent) {
    if (this.closed || !agent) return
    const state = this.states.get(agent)
    if (!state || !state.active || this.isSuspended(state)) return
    const current = this.modelOf(state)
    if (!current) return

    if (state.phase === 'plan') {
      const planner = machine.copySelection(state.plannerSelection)
      if (planner && !machine.sameSelection(current, planner)) this.selectRoute(state, planner)
      return
    }

    const route = this.config.executorRoute
    if (route && !machine.sameSelection(current, route)) this.selectRoute(state, route)
  }

  // ── events ────────────────────────────────────────────────────────────────

  /**
   * @param {unknown} session
   * @param {{ type: string, data: unknown }} event
   */
  onSessionEvent(session, event) {
    if (this.closed || !session || !event) return
    const state = this.bySession.get(session.id)
    if (!state) return
    switch (event.type) {
      case 'turn/start':
        this.onTurnStart(state)
        break
      case 'agent/inbox/spliced':
        this.onInboxSpliced(state, event.data)
        break
      case 'step/start':
        if (!this.isSuspended(state)) machine.recordStepStart(state)
        break
      case 'step/end':
        if (!this.isSuspended(state)) machine.recordStepEnd(state, this.config.reviewEvery)
        break
      case 'turn/end':
        this.onTurnEnd(state)
        break
      case 'model/selection':
        this.onModelSelection(state, event.data)
        break
      default:
        break
    }
  }

  /**
   * @param {machine.OrchestratorState} state
   * @param {{ target?: string, inserted?: ReadonlyArray<{ source?: { kind?: string } }> }} data
   */
  onInboxSpliced(state, data) {
    const target = data?.target
    const inserted = Array.isArray(data?.inserted) ? data.inserted : []
    const human = inserted.some(message => message?.source?.kind === 'user')
    if (target === 'next-step' && human && state.active && !this.isSuspended(state)) {
      machine.recordUserMessage(state)
    }
  }

  /** @param {machine.OrchestratorState} state */
  onTurnStart(state) {
    machine.resetRound(state)
    if (!state.active || this.isSuspended(state)) return
    // No selection append from inside the turn/start publication. The turn/end
    // microtask normally restored the planner already; the pre-step backstop
    // covers the remaining case (for example a suspension that skipped it).
    machine.adoptPlanner(state, this.modelOf(state), this.config.executorRoute)
  }

  /** @param {machine.OrchestratorState} state */
  onTurnEnd(state) {
    machine.resetRound(state)
    if (!state.active || this.isSuspended(state)) return
    const planner = machine.copySelection(state.plannerSelection)
    if (!planner) return
    // turn/end is published synchronously; a microtask runs after the append
    // closes, where selecting a model is safe again. The pre-step hook is the
    // backstop if the next turn starts first.
    queueMicrotask(() => {
      if (this.closed || !state.active || state.phase !== 'plan') return
      if (this.isSuspended(state)) return
      const current = this.modelOf(state)
      if (!current || machine.sameSelection(current, planner)) return
      this.selectRoute(state, planner)
    })
  }

  /**
   * @param {machine.OrchestratorState} state
   * @param {{ signal?: AbortSignal }} payload
   */
  onTurnStopping(state, payload) {
    if (this.closed || !state.active || this.isSuspended(state)) return
    if (payload?.signal?.aborted) return
    if (!state.pendingReview && !state.pendingInterruption) return
    if (state.forcedSteers >= 2) return
    if ((state.agent.inbox?.nextStep?.length ?? 0) > 0) return

    state.forcedSteers += 1
    const labels = this.labels(state)
    const text = state.pendingReview
      ? `A plan review is due. Call ${labels.enterTool} now with a status report as its reason; other tools are refused until you hand back.`
      : `The user wrote while you were working. Call ${labels.enterTool} now with a status report as its reason; do not act on the message yourself. Other tools are refused until you hand back.`
    try {
      state.agent.steer(this.wakeMessage(text))
    } catch (error) {
      this.warn('failed to wake the executor for a forced review', error)
    }
  }

  /** @param {string} text */
  wakeMessage(text) {
    return {
      id: `orchestrator-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'orchestrator',
        form: 'notice',
        summary: summaryOf(text),
      },
    }
  }

  /** @param {unknown} exec */
  guard(exec) {
    if (this.closed || !exec) return undefined
    const state = this.stateOfAgent(exec.agent)
    if (!state) return undefined
    if (this.isSuspended(state)) return undefined
    return machine.gateDecision(state, exec.name, this.config, false) ?? undefined
  }

  // ── hand-off tools ────────────────────────────────────────────────────────

  /**
   * @param {machine.OrchestratorState} state
   * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
   */
  exitTool(state) {
    const name = this.config.exitToolName
    const labels = this.labels(state)
    return {
      name,
      description: `Turn plan mode off and hand the plan to the execution model, ${labels.executor}. This phase ends and the conversation continues on that model in this same conversation, which sees everything so far, including the plan given here. Call it once the plan is complete.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: {
            type: 'string',
            description: 'The complete plan the execution model will carry out: ordered steps, the files and symbols each one touches, the exact changes, how to verify, and the pitfalls you found. It is the hand-off; nothing you know that is not in it or already in the conversation survives it.',
          },
        },
        required: ['plan'],
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value.message) }],
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Plan handed to the execution model',
        kind: 'other',
        content: typeof args?.plan === 'string' ? [{ type: 'text', text: args.plan }] : [],
        rawInput: { planChars: typeof args?.plan === 'string' ? args.plan.length : 0 },
      }),
      execute: async (rawArgs, exec) => {
        if (exec?.agent !== undefined && exec.agent !== state.agent) {
          throw new Error(`${name} was invoked for a different agent`)
        }
        if (this.closed || !state.active) throw new Error(`${name} is only available while Orchestrator mode is active`)
        if (this.isSuspended(state)) throw new Error(`${name} is not available while DSH plan mode is on`)
        if (state.phase !== 'plan') throw new Error(`${name} is only available in the planning phase`)

        const plan = typeof rawArgs?.plan === 'string' ? rawArgs.plan.trim() : ''
        if (!plan) throw new Error(`${name} requires a non-empty "plan" string`)

        if (!state.plannerSelection) state.plannerSelection = this.plannerCandidate(state)
        const route = this.config.executorRoute
        if (route && !this.selectRoute(state, route)) {
          throw new Error(`could not select the configured execution model ${machine.routeLabel(route)}`)
        }
        machine.handoffToExecution(state)
        return { ok: true, message: prompts.exitResultText(this.labels(state)) }
      },
    }
  }

  /**
   * @param {machine.OrchestratorState} state
   * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
   */
  enterTool(state) {
    const name = this.config.enterToolName
    const labels = this.labels(state)
    return {
      name,
      description: `Turn plan mode back on and hand back to the planning model. This phase ends and the conversation continues on the planning model in this same conversation, which sees everything so far. Use it when carrying out the plan needs a design decision the plan did not make, and whenever a hidden "[plan review due]" message asks you to, with a status report as the reason. A new user message starts in plan mode on its own.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: {
            type: 'string',
            description: 'What needs a decision from the planning model: what you found, what the plan assumed, and the options you see.',
          },
        },
        required: ['reason'],
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value.message) }],
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: 'Hand back to the planning model',
        kind: 'other',
        content: typeof args?.reason === 'string' ? [{ type: 'text', text: args.reason }] : [],
        rawInput: { reportChars: typeof args?.reason === 'string' ? args.reason.length : 0 },
      }),
      execute: async (rawArgs, exec) => {
        if (exec?.agent !== undefined && exec.agent !== state.agent) {
          throw new Error(`${name} was invoked for a different agent`)
        }
        if (this.closed || !state.active) throw new Error(`${name} is only available while Orchestrator mode is active`)
        if (this.isSuspended(state)) throw new Error(`${name} is not available while DSH plan mode is on`)
        if (state.phase !== 'execute') throw new Error(`${name} is only available in the execution phase`)

        const reason = typeof rawArgs?.reason === 'string' ? rawArgs.reason.trim() : ''
        if (!reason) throw new Error(`${name} requires a non-empty "reason" string`)

        const planner = machine.copySelection(state.plannerSelection)
        if (planner && !this.selectRoute(state, planner)) {
          throw new Error(`could not select the planning model ${machine.routeLabel(planner)}`)
        }
        machine.handoffToPlanning(state)
        return { ok: true, message: prompts.enterResultText(this.labels(state), reason, this.config.maxReportChars) }
      },
    }
  }

  // ── command ───────────────────────────────────────────────────────────────

  /** @param {{ agent?: unknown, rawInput?: string, attachments?: unknown[] }} payload */
  handleCommand(payload) {
    if (this.closed) return { kind: 'error', text: '编排模式插件已卸载。' }
    const agent = payload?.agent
    if (!agent) return { kind: 'error', text: '当前没有可用的 Agent。' }
    let state = this.states.get(agent)
    if (!state) state = this.attach(agent)
    if (!state) return { kind: 'error', text: '子代理会话默认不启用编排模式（includeSubagents=false）。' }

    const input = String(payload?.rawInput ?? '').trim()
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : []

    if (input === 'status') {
      if (attachments.length > 0) return { kind: 'error', text: '/orchestrate status 不接受附件。' }
      return { kind: 'success', text: this.statusText(state) }
    }

    if (input === 'off') {
      if (attachments.length > 0) return { kind: 'error', text: '/orchestrate off 不接受附件。' }
      if (!state.active) return { kind: 'success', text: '编排模式已经是关闭状态。' }
      const result = this.disable(state)
      return {
        kind: 'success',
        text: result.restored
          ? `编排模式已关闭。模型选择已恢复为 ${machine.routeLabel(result.restored)}。`
          : '编排模式已关闭。',
      }
    }

    if (!state.active) {
      const result = this.enable(state)
      if (!result.ok) {
        let text
        if (result.reason === 'plan-mode') {
          text = 'DSH plan mode 正在开启。请先执行 /plan off，再开启编排模式。'
        } else if (result.reason === 'disabled') {
          text = '插件配置 enabled=false，编排模式不可用。'
        } else if (result.reason === 'provider') {
          text = `执行模型 provider 不存在：${result.error ?? ''}。可用的 provider：${(result.providers ?? []).join(', ')}。请检查插件的 executorProvider/executorModel 配置。`
        } else if (result.reason === 'planner-same-as-executor') {
          text = `当前模型就是执行模型（${result.error ?? ''}），交接不会切换模型。`
            + '请先在模型选择器里换一个规划模型，再 /orchestrate；'
            + '或者把插件的 executorProvider/executorModel 清空，让两个阶段共用当前模型。'
            + '（插件重载或 DSH 重启后，会话可能停在执行模型上，这是这条提示最常见的原因。）'
        } else {
          text = `编排模式开启失败：${result.error ?? result.reason}`
        }
        return { kind: 'error', text }
      }
    }

    const content = [
      ...attachments,
      ...(input ? [{ type: 'text', text: input }] : []),
    ]
    if (content.length > 0) {
      try {
        agent.steer({
          id: `orchestrator-user-${randomUUID()}`,
          role: 'user',
          content,
          source: { kind: 'user' },
        })
      } catch (error) {
        return {
          kind: 'error',
          text: `编排模式已开启，但消息注入失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    const lines = ['编排模式已开启。']
    if (this.config.executorRoute) {
      lines.push(`执行模型：${machine.routeLabel(this.config.executorRoute)}。`)
    } else {
      lines.push('执行模型未配置：两阶段共用当前模型；配置 executorProvider/executorModel 后才会切换。')
    }
    lines.push('规划模型就是你在模型选择器里选中的模型。规划阶段结束时插件会切到执行模型，交回时切回你的选择。')
    lines.push('规划阶段用黑名单 gate：编辑类工具（write/edit/apply_patch/run_code 等）会被拒绝，其余工具放行；"只观察"由提示词约束，gate 不检查 pwsh 命令参数。')
    if (agent.inbox?.nextStep?.length > 0 || agent.inbox?.nextTurn?.length > 0) {
      lines.push('当前 Turn 已在运行：阶段提示与门控从下一步生效。')
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  /** @param {machine.OrchestratorState} state */
  statusText(state) {
    const suspended = state.active && this.isSuspended(state)
    const lines = []
    if (!state.active) lines.push('编排模式：未开启')
    else if (suspended) lines.push('编排模式：挂起（DSH plan mode 已开启）')
    else lines.push('编排模式：已开启')
    lines.push(`阶段：${state.phase === 'plan' ? '规划' : '执行'}`)
    const current = this.modelOf(state)
    const sameAsExecutor = Boolean(
      current && this.config.executorRoute && machine.sameSelection(current, this.config.executorRoute),
    )
    const planner = state.plannerSelection
      ? machine.routeLabel(state.plannerSelection)
      : (current && !sameAsExecutor ? machine.routeLabel(current) : '未记录')
    lines.push(`规划模型：${planner}（由模型选择器决定）`)
    lines.push(`执行模型：${this.config.executorRoute ? machine.routeLabel(this.config.executorRoute) : '未配置（单模型运行，沿用规划模型）'}`)
    lines.push(`复核节奏：${this.config.reviewEvery > 0 ? `每 ${this.config.reviewEvery} 个执行步` : '关闭'}`)
    if (state.active) {
      lines.push(`本轮已执行：${state.sinceHandoff}`)
      const pending = [state.pendingReview ? '复核到期' : '', state.pendingInterruption ? '用户插话' : ''].filter(Boolean)
      lines.push(`待处理：${pending.length > 0 ? pending.join(' / ') : '无'}`)
    }
    lines.push(`工具：${this.config.exitToolName} / ${this.config.enterToolName}`)
    lines.push(`规划 gate：黑名单 ${this.config.planDenyTools.length} 项（${this.config.planDenyTools.join('、')}）；其余放行，不检查命令参数`)
    if (sameAsExecutor) {
      lines.push(state.active
        ? '提示：当前模型就是执行模型，交接不会切换模型；请在模型选择器里换一个规划模型。'
        : '提示：当前模型就是执行模型，/orchestrate 会拒绝开启；请先换一个模型，或清空插件的执行路由（两个阶段共用当前模型）。')
    }
    if (this.config.warnings.length > 0) lines.push(`配置提醒：${this.config.warnings.join('；')}`)
    return lines.join('\n')
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** @param {unknown} agent */
  stateOfAgent(agent) {
    return agent ? this.states.get(agent) : undefined
  }

  /** @param {machine.OrchestratorState} state */
  isSuspended(state) {
    const planMode = this.ctx.get('planMode')
    if (!planMode || typeof planMode.get !== 'function') return false
    try {
      const value = planMode.get(state.agent)
      return value?.active === true || value?.pending === true
    } catch {
      return false
    }
  }

  /** @param {machine.OrchestratorState} state */
  labels(state) {
    const planner = state.plannerSelection
      ? machine.routeLabel(state.plannerSelection)
      : 'the session-selected model'
    const executor = this.config.executorRoute
      ? machine.routeLabel(this.config.executorRoute)
      : 'the session model (no separate executor route is configured)'
    return {
      planner,
      executor,
      exitTool: this.config.exitToolName,
      enterTool: this.config.enterToolName,
    }
  }

  /**
   * @param {string} message
   * @param {unknown} [error]
   */
  warn(message, error) {
    const logger = this.ctx.logger
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`orchestrator-mode: ${message}`, error)
    }
  }
}