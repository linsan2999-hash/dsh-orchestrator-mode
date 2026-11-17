/**
 * Orchestrator mode — pure per-agent state machine.
 *
 * No DSH imports and no I/O: every transition is synchronous and testable with
 * plain objects. The runtime owns agents, events, tools, and model selection.
 */

/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelSelection */

/**
 * @typedef {Object} OrchestratorState
 * @property {unknown} agent
 * @property {string} sessionId
 * @property {boolean} active
 * @property {'plan' | 'execute'} phase
 * @property {number} sinceHandoff
 * @property {boolean} pendingReview
 * @property {boolean} pendingInterruption
 * @property {boolean} reviewTurn
 * @property {number} forcedSteers
 * @property {ModelSelection | null} plannerSelection
 * @property {boolean} internalSelection
 * @property {Array<() => void>} toolDisposers
 * @property {{ selection: ModelSelection } | null} correction
 */

/**
 * Copy a model selection into a detached plain object.
 *
 * @param {unknown} selection
 * @returns {ModelSelection | null}
 */
export function copySelection(selection) {
  if (selection === null || typeof selection !== 'object') return null
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  if (!provider || !model) return null
  const effort = typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : ''
  return {
    provider,
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

/**
 * @param {ModelSelection | null | undefined} left
 * @param {ModelSelection | null | undefined} right
 * @returns {boolean}
 */
export function sameSelection(left, right) {
  if (left === right) return true
  if (!left || !right) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/**
 * @param {ModelSelection | null | undefined} route
 * @returns {string}
 */
export function routeLabel(route) {
  if (!route) return ''
  return route.reasoningEffort
    ? `${route.provider}/${route.model} (${route.reasoningEffort})`
    : `${route.provider}/${route.model}`
}

/**
 * @param {unknown} agent
 * @param {string} sessionId
 * @returns {OrchestratorState}
 */
export function createState(agent, sessionId) {
  return {
    agent,
    sessionId,
    active: false,
    phase: 'plan',
    sinceHandoff: 0,
    pendingReview: false,
    pendingInterruption: false,
    reviewTurn: false,
    forcedSteers: 0,
    plannerSelection: null,
    internalSelection: false,
    toolDisposers: [],
    correction: null,
  }
}

/**
 * Reset the phase cycle without touching activation or the planner selection.
 *
 * @param {OrchestratorState} state
 */
export function resetRound(state) {
  state.phase = 'plan'
  state.sinceHandoff = 0
  state.pendingReview = false
  state.pendingInterruption = false
  state.reviewTurn = false
  state.forcedSteers = 0
  state.correction = null
}

/**
 * Activate the mode and adopt the session-selected model as the planner.
 *
 * The current model is **not** adopted when it is the configured executor
 * route. After a plugin reload or a DSH restart the session model is the
 * executor, and adopting it would silently collapse the two-model protocol
 * into one model with no error. `enable()` refuses that case up front; this
 * guard keeps the invariant for any other caller.
 *
 * @param {OrchestratorState} state
 * @param {ModelSelection | null | undefined} current
 * @param {ModelSelection | null | undefined} [executorRoute]
 */
export function activate(state, current, executorRoute) {
  state.active = true
  state.plannerSelection = executorRoute && sameSelection(current, executorRoute)
    ? null
    : copySelection(current)
  resetRound(state)
}

/**
 * @param {OrchestratorState} state
 */
export function deactivate(state) {
  state.active = false
  resetRound(state)
}

/**
 * Planner → executor handoff.
 *
 * @param {OrchestratorState} state
 */
export function handoffToExecution(state) {
  state.phase = 'execute'
  state.sinceHandoff = 0
  state.pendingReview = false
  state.pendingInterruption = false
  state.reviewTurn = false
  state.forcedSteers = 0
  state.correction = null
}

/**
 * Executor → planner handoff (a planner review turn).
 *
 * @param {OrchestratorState} state
 */
export function handoffToPlanning(state) {
  state.phase = 'plan'
  state.sinceHandoff = 0
  state.pendingReview = false
  state.pendingInterruption = false
  state.reviewTurn = true
  state.forcedSteers = 0
  state.correction = null
}

/**
 * Count one execution-model invocation.
 *
 * @param {OrchestratorState} state
 */
export function recordStepStart(state) {
  if (!state.active || state.phase !== 'execute') return
  state.sinceHandoff += 1
}

/**
 * Mark a periodic review due after the configured cadence is reached.
 *
 * @param {OrchestratorState} state
 * @param {number} reviewEvery
 */
export function recordStepEnd(state, reviewEvery) {
  if (!state.active || state.phase !== 'execute') return
  if (reviewEvery <= 0) return
  if (state.sinceHandoff < reviewEvery) return
  if (state.pendingReview) return
  state.pendingReview = true
  state.forcedSteers = 0
}

/**
 * A user message reached the executor mid-turn.
 *
 * @param {OrchestratorState} state
 */
export function recordUserMessage(state) {
  if (!state.active || state.phase !== 'execute') return
  state.pendingInterruption = true
}

/**
 * Adopt the session-selected model as the planner unless it is the configured
 * executor route. Used at a new turn and after enabling.
 *
 * @param {OrchestratorState} state
 * @param {ModelSelection | null | undefined} current
 * @param {ModelSelection | null | undefined} executorRoute
 * @returns {ModelSelection | null}
 */
export function adoptPlanner(state, current, executorRoute) {
  if (current && !(executorRoute && sameSelection(current, executorRoute))) {
    state.plannerSelection = copySelection(current)
  }
  return state.plannerSelection
}

/**
 * Apply one recorded model selection.
 *
 * While planning, any selection becomes the planner. While executing, a
 * selection other than the configured executor is treated as the *next* planner
 * and the runtime should re-select the executor for the active step.
 *
 * @param {OrchestratorState} state
 * @param {ModelSelection | null | undefined} selection
 * @param {ModelSelection | null | undefined} executorRoute
 * @returns {{ plannerUpdated: boolean, correctTo: ModelSelection | null }}
 */
export function applyModelSelection(state, selection, executorRoute) {
  if (!state.active) return { plannerUpdated: false, correctTo: null }
  const picked = copySelection(selection)
  if (!picked) return { plannerUpdated: false, correctTo: null }

  if (state.phase === 'plan') {
    state.plannerSelection = picked
    return { plannerUpdated: true, correctTo: null }
  }

  // Execution phase.
  if (!executorRoute) {
    // Single-model mode: the selection is simply the model used by both phases.
    state.plannerSelection = picked
    return { plannerUpdated: true, correctTo: null }
  }
  if (sameSelection(picked, executorRoute)) {
    // Our own handoff switch, or a redundant selection of the executor.
    return { plannerUpdated: false, correctTo: null }
  }
  state.plannerSelection = picked
  state.correction = { selection: picked }
  return { plannerUpdated: true, correctTo: copySelection(executorRoute) }
}

/**
 * The tool-time gate. Returns a model-facing refusal reason, or null to allow.
 *
 * @param {OrchestratorState} state
 * @param {string} toolName
 * @param {{ exitToolName: string, enterToolName: string, planDenyTools: readonly string[] }} config
 * @param {boolean} suspended
 * @returns {string | null}
 */
export function gateDecision(state, toolName, config, suspended) {
  if (!state.active || suspended) return null
  const { exitToolName, enterToolName } = config

  // 1) Plan phase: an exact deny list of workspace-changing tools. Everything
  // else passes, matching the reference gate ("%s changes the workspace").
  if (state.phase === 'plan' && config.planDenyTools.includes(toolName)) {
    return `Plan mode is on, and ${toolName} changes the workspace. `
      + `Plan mode is read-only: finish the plan and call ${exitToolName} with it; `
      + 'the execution model makes the changes.'
  }

  // 2) The hand-back tool is always admitted, in every phase and while a review
  // is pending. The reference gate special-cases it before the review check.
  if (toolName === enterToolName) return null

  // 3) A pending review or a user interruption holds everything else.
  if (state.pendingReview || state.pendingInterruption) {
    return `A plan review is due: ${toolName} is refused until you hand back. `
      + `Call ${enterToolName} now with a status report (what is done, what was verified, what remains); `
      + 'the planning model returns a plan to continue from.'
  }

  // 4) The outbound hand-off tool belongs to the planning phase.
  if (state.phase === 'execute' && toolName === exitToolName) {
    return `${exitToolName} is only available while the planning phase is on. `
      + `${enterToolName} is the hand-back tool in this phase.`
  }
  return null
}

/**
 * Whether one of the two handoff tools is callable in the current phase.
 *
 * @param {OrchestratorState} state
 * @param {string} toolName
 * @param {{ exitToolName: string, enterToolName: string }} config
 * @returns {boolean}
 */
export function toolAvailable(state, toolName, config, suspended) {
  if (!state.active || suspended) return false
  if (toolName === config.exitToolName) return state.phase === 'plan'
  if (toolName === config.enterToolName) return state.phase === 'execute'
  return false
}