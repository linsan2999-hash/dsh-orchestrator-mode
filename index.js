/**
 * Orchestrator mode — Host plugin entry.
 *
 * Two models share one conversation: the session-selected model plans, the
 * configured executor route implements, and two hand-off tools move control
 * between the phases inside a single turn. See README.md.
 */

import { resolveConfig } from './src/config.js'
import { ROUTE_PREFIX, createHandler } from './src/panel.js'
import { OrchestratorRuntime } from './src/runtime.js'

export const name = 'dsh-orchestrator-mode'
export const inject = ['tools', 'systemPrompt']

/**
 * Resolve the row config without ever failing the plugin. `resolveConfig` is
 * written not to throw; this is the last-resort guard so a malformed profile
 * row cannot take the plugin — and with it the page that repairs the row — down.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
function resolveSafely(ctx, config) {
  try {
    return resolveConfig(config)
  } catch (error) {
    ctx.logger?.warn?.('orchestrator-mode: config resolution failed; falling back to the defaults', error)
    return resolveConfig({})
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 * @returns {() => void}
 */
export function apply(ctx, config) {
  const resolved = resolveSafely(ctx, config)
  if (!resolved.enabled) {
    // Keep the control routes alive so the plugin page can turn the master
    // switch back on; every model-facing registration still checks `enabled`.
    ctx.logger?.info?.('orchestrator-mode: disabled by config; the plugin page can enable it')
  }
  for (const warning of resolved.warnings) {
    ctx.logger?.warn?.(`orchestrator-mode: ${warning}`)
  }
  const runtime = new OrchestratorRuntime(ctx, resolved)
  try {
    runtime.start()
  } catch (error) {
    ctx.logger?.warn?.('orchestrator-mode: the runtime failed to start; only the plugin page is available', error)
  }
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler(runtime) }),
        'orchestrator-mode: plugin page routes',
      )
    })
  } catch (error) {
    ctx.logger?.warn?.('orchestrator-mode: failed to register the plugin page routes', error)
  }
  return () => runtime.dispose()
}

export { OrchestratorRuntime }
