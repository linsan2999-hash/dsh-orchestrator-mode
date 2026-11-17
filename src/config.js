/**
 * Orchestrator mode — configuration normalization and validation.
 *
 * The planner model is the model the user selects in the session model picker.
 * Only the executor route is configured here. Everything is plain JavaScript so
 * the bundle has no runtime dependency on DSH internals beyond the injected
 * services.
 *
 * Resolution never throws: a hand-edited profile row with a typo falls back to
 * the default, records a warning, and keeps the plugin (and its own page)
 * loadable, so the mistake can be repaired from the UI instead of the YAML.
 */

/** @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelRoute */

/**
 * The planning phase's read-only deny list.
 *
 * The reference binary is not a whitelist: its pre-tool gate refuses an exact
 * set of workspace-changing tools and lets every other name through
 * ("Plan mode is on, and %s changes the workspace. Plan mode is read-only…").
 * The "commands that only observe" rule is carried by the phase prompt; the
 * gate only stops the model from reaching for an editing tool.
 *
 * This list enumerates the first-party tools whose purpose is to write the
 * workspace, so a planner cannot sidestep the gate through a file-editing or
 * code-execution tool. Command runners (`pwsh`, `terminal_*`) stay out on
 * purpose: the reference gate does not inspect command arguments and neither
 * does this one. Delegation (`subagent`, `workflow`) also stays out, matching
 * the reference, where swarm tools pass the gate and the planner prompt is
 * what forbids dispatching workers. `planDenyTools` adds names.
 */
export const DEFAULT_PLAN_DENY = Object.freeze([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'run_code',
  'memory',
  'office_render',
  'office_convert',
  'office_recalculate',
])

/**
 * The pre-0.4 allow-list config key. It is no longer read; a non-empty value
 * only produces a warning so an old profile row keeps loading.
 */
export const LEGACY_PLAN_ALLOW_KEY = 'planAllowTools'

const DEFAULT_EXIT_TOOL = 'orchestrator_exit_plan_mode'
const DEFAULT_ENTER_TOOL = 'orchestrator_enter_plan_mode'
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/

/** First-party names the hand-off tools must never shadow at agent scope. */
const RESERVED_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'multi_edit', 'apply_patch', 'glob', 'grep', 'pwsh',
  'run_code', 'web_fetch', 'present', 'todo_write', 'ask_user_question',
  'skill', 'memory', 'session_manager', 'plugin_manager', 'workflow',
  'subagent', 'subagent_fork', 'send_message', 'create_goal', 'update_goal',
  'schedule_create', 'schedule_edit', 'load_workspace_dependencies',
  'job_output', 'job_list', 'job_kill', 'terminal_open', 'terminal_send',
  'terminal_signal', 'terminal_close', 'terminal_read', 'terminal_list',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'exit_plan_mode', 'enter_plan_mode',
])

/**
 * Read an integer config value. Never throws: a value that cannot be parsed
 * falls back, an out-of-range value is clamped, and both record a warning so
 * the plugin still loads and its page can repair the config.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} key
 * @param {(message: string) => void} warn
 * @returns {number}
 */
function integer(value, fallback, min, max, key, warn) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warn(`config "${key}" must be an integer; using ${fallback}`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max)
    warn(`config "${key}" must be between ${min} and ${max}; using ${clamped}`)
    return clamped
  }
  return parsed
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} key
 * @param {(message: string) => void} warn
 * @returns {boolean}
 */
function boolean(value, fallback, key, warn) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === '1' || text === 'yes') return true
  if (text === 'false' || text === '0' || text === 'no') return false
  warn(`config "${key}" must be a boolean; using ${fallback}`)
  return fallback
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * Read a tool name. Never throws: an invalid or shadowing name falls back to
 * the default and records a warning.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @param {string} key
 * @param {(message: string) => void} warn
 * @returns {string}
 */
function toolName(value, fallback, key, warn) {
  const name = text(value) || fallback
  if (!TOOL_NAME_RE.test(name)) {
    warn(`config "${key}" must match ${TOOL_NAME_RE.source}; using "${fallback}"`)
    return fallback
  }
  if (RESERVED_TOOL_NAMES.has(name)) {
    warn(`config "${key}" must not shadow the built-in tool "${name}"; using "${fallback}"`)
    return fallback
  }
  return name
}

/**
 * @param {unknown} value
 * @param {(message: string) => void} warn
 * @returns {string[]}
 */
function nameList(value, warn) {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const names = []
  for (const entry of raw) {
    const name = text(entry)
    if (name === '') continue
    if (!TOOL_NAME_RE.test(name)) {
      warn(`plan tool list contains an invalid tool name "${name}"; ignoring it`)
      continue
    }
    names.push(name)
  }
  return names
}

/**
 * Resolve and validate the plugin row config.
 *
 * @param {unknown} raw
 * @returns {{
 *   enabled: boolean,
 *   activation: 'command' | 'always',
 *   executorRoute: ModelRoute | null,
 *   executorProvider: string,
 *   executorModel: string,
 *   executorEffort: string,
 *   reviewEvery: number,
 *   maxReportChars: number,
 *   includeSubagents: boolean,
 *   exitToolName: string,
 *   enterToolName: string,
 *   planDenyTools: string[],
 *   sectionOrder: number,
 *   contextOrder: number,
 *   plannerPrompt: string,
 *   executorPrompt: string,
 *   warnings: string[],
 * }}
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const warnings = []
  /** @param {string} message */
  const warn = message => {
    warnings.push(message)
  }

  const enabled = boolean(input.enabled, true, 'enabled', warn)
  let activation = text(input.activation) || 'command'
  if (activation !== 'command' && activation !== 'always') {
    warn(`config "activation" must be "command" or "always"; using "command"`)
    activation = 'command'
  }

  let exitToolName = toolName(input.exitToolName, DEFAULT_EXIT_TOOL, 'exitToolName', warn)
  let enterToolName = toolName(input.enterToolName, DEFAULT_ENTER_TOOL, 'enterToolName', warn)
  if (exitToolName === enterToolName) {
    warn('exitToolName and enterToolName must differ; using the defaults')
    exitToolName = DEFAULT_EXIT_TOOL
    enterToolName = DEFAULT_ENTER_TOOL
  }

  const executorProvider = text(input.executorProvider)
  const executorModel = text(input.executorModel)
  const executorEffort = text(input.executorEffort)
  if (Boolean(executorProvider) !== Boolean(executorModel)) {
    warnings.push('executorProvider and executorModel must both be set; the executor route is treated as unconfigured')
  }
  const executorRoute = executorProvider && executorModel
    ? {
      provider: executorProvider,
      model: executorModel,
      ...(executorEffort ? { reasoningEffort: executorEffort } : {}),
    }
    : null
  if (executorRoute === null && executorEffort) {
    warnings.push('executorEffort is set but the executor route is incomplete; it is ignored')
  }

  const deny = new Set(DEFAULT_PLAN_DENY)
  for (const name of nameList(input.planDenyTools, warn)) deny.add(name)
  // The hand-off tools are never denied: their own `when` conditions decide the
  // phase, and the review gate is what holds them back.
  deny.delete(exitToolName)
  deny.delete(enterToolName)
  const legacyAllow = input[LEGACY_PLAN_ALLOW_KEY]
  const legacyAllowSet = Array.isArray(legacyAllow) ? legacyAllow.length > 0 : text(legacyAllow) !== ''
  if (legacyAllowSet) {
    warnings.push('planAllowTools is no longer supported; the planning phase uses the deny list in planDenyTools')
  }

  /** @type {ModelRoute | null} */
  return Object.freeze({
    enabled,
    activation,
    executorRoute,
    executorProvider,
    executorModel,
    executorEffort,
    reviewEvery: integer(input.reviewEvery, 10, 0, 1000, 'reviewEvery', warn),
    maxReportChars: integer(input.maxReportChars, 12000, 1000, 200000, 'maxReportChars', warn),
    includeSubagents: boolean(input.includeSubagents, false, 'includeSubagents', warn),
    exitToolName,
    enterToolName,
    planDenyTools: Object.freeze([...deny].sort()),
    sectionOrder: integer(input.sectionOrder, 50, -1000, 1000, 'sectionOrder', warn),
    contextOrder: integer(input.contextOrder, 100, -1000, 1000, 'contextOrder', warn),
    plannerPrompt: text(input.plannerPrompt),
    executorPrompt: text(input.executorPrompt),
    warnings: Object.freeze(warnings),
  })
}

/** The subset of the config the plugin page edits. */
export const PAGE_FIELDS = Object.freeze([
  'enabled',
  'executorProvider',
  'executorModel',
  'executorEffort',
  'reviewEvery',
])

/**
 * Project a resolved config onto the fields the plugin page owns.
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {{ enabled: boolean, executorProvider: string, executorModel: string, executorEffort: string, reviewEvery: number }}
 */
export function pageConfig(config) {
  return {
    enabled: config.enabled,
    executorProvider: config.executorProvider,
    executorModel: config.executorModel,
    executorEffort: config.executorEffort,
    reviewEvery: config.reviewEvery,
  }
}

/** The shipped defaults for the page fields (no profile override applied). */
export function pageDefaults() {
  return pageConfig(resolveConfig({}))
}