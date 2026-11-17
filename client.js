/**
 * Orchestrator mode — Client configuration page.
 *
 * The row page of the Plugins manager (slot `plugins.row.config`, key
 * `dsh-orchestrator-mode#orchestrator-mode`) picks the execution route and the
 * review cadence. The host persists them through configEditor, so the values
 * land in the profile patch and survive upgrades. The planning model is not
 * configured here: it is the model the session's own picker selects.
 */

window.__ModuleLoader__.load({
  id: 'dsh-orchestrator-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useContext, useEffect, useState } = React

    const NS = 'orchestratorMode'
    const ROUTE = '/plugins/orchestrator-mode'

    // ── copy ──────────────────────────────────────────────────────────────

    const zh = {
      summary: '选择执行模型与复核节奏；规划模型仍由会话的模型选择器决定。',
      intro: '规划阶段沿用会话里选中的模型；执行阶段使用下面配置的模型。保存会重载插件，正在运行的编排会话会回到关闭状态。',
      enabled: '启用编排模式',
      enabledHint: '关闭后隐藏交接工具、阶段提示词与门控；这个配置页仍然可用。',
      executor: '执行路由',
      provider: 'Provider',
      providerNone: '不指定（单模型运行）',
      model: '模型',
      modelPlaceholder: '选择模型',
      modelManual: '手填模型 id',
      effort: '推理强度',
      effortDefault: '默认（不指定）',
      effortManual: '手填强度（如 low / high）',
      effortUnavailable: '这个模型没有返回强度清单，可以手填。',
      review: '复核间隔（执行步）',
      reviewHint: '每 N 个执行步注入一次隐藏复核；0 关闭。',
      save: '保存',
      saving: '保存中…',
      loading: '读取配置…',
      saved: '已保存，插件正在重载…',
      reloaded: '配置已生效。',
      reloadFailed: '保存成功，但重载后暂时读不到状态；稍后点“重试”。',
      retry: '重试',
      reset: '恢复默认',
      resetConfirm: '再点一次确认',
      resetDone: '已恢复插件默认值，正在重载…',
      current: '当前执行模型',
      currentNone: '未配置（与规划共用模型）',
      tools: '交接工具',
      warning: '保存会重载插件；正在运行的编排会话会回到关闭状态。',
      notWritable: '当前 profile 不支持写回配置。',
      loadFailed: '读取配置失败。',
      unavailable: 'Host 尚未就绪（插件可能正在重载）。',
      noProviders: '没有读到可用 provider。',
      catalogPartial: '部分 provider 的模型清单读取失败，可以手填模型 id。',
      errNetwork: '网络错误。',
      errNoLlm: 'Host 没有 llm 服务。',
      errMissingModel: '请选择模型，或把 provider 设为“不指定”。',
      errBadReview: '复核间隔必须是 0–1000 的整数。',
      errSave: '保存失败。',
      errReset: '恢复默认失败。',
      errUnknown: '请求失败。',
    }

    const en = {
      summary: 'Pick the execution model and review cadence; the planning model still comes from the session picker.',
      intro: 'The planning phase uses the model selected in the session. The execution phase uses the route below. Saving reloads the plugin, so a running Orchestrator session returns to off.',
      enabled: 'Enable Orchestrator mode',
      enabledHint: 'When off, the hand-off tools, phase prompts, and gate are hidden; this page still works.',
      executor: 'Execution route',
      provider: 'Provider',
      providerNone: 'Not set (single-model mode)',
      model: 'Model',
      modelPlaceholder: 'Choose a model',
      modelManual: 'Model id',
      effort: 'Reasoning effort',
      effortDefault: 'Default (not set)',
      effortManual: 'Effort id (for example low or high)',
      effortUnavailable: 'This model advertised no effort list; enter one manually.',
      review: 'Review cadence (execution steps)',
      reviewHint: 'Inject a hidden review every N execution steps; 0 disables it.',
      save: 'Save',
      saving: 'Saving…',
      loading: 'Reading configuration…',
      saved: 'Saved. The plugin is reloading…',
      reloaded: 'The configuration is live.',
      reloadFailed: 'Saved, but the reload is not reachable yet. Try again shortly.',
      retry: 'Retry',
      reset: 'Restore defaults',
      resetConfirm: 'Click again to confirm',
      resetDone: 'Defaults restored. The plugin is reloading…',
      current: 'Current execution model',
      currentNone: 'Not configured (the planner model is used)',
      tools: 'Hand-off tools',
      warning: 'Saving reloads the plugin; a running Orchestrator session returns to off.',
      notWritable: 'This profile does not expose configuration writes.',
      loadFailed: 'Could not read the configuration.',
      unavailable: 'The Host is not ready yet (the plugin may be reloading).',
      noProviders: 'No provider was advertised.',
      catalogPartial: 'Some provider model lists failed; you can enter a model id manually.',
      errNetwork: 'Network error.',
      errNoLlm: 'The Host has no llm service.',
      errMissingModel: 'Choose a model, or set the provider to “Not set”.',
      errBadReview: 'The review cadence must be an integer from 0 to 1000.',
      errSave: 'Could not save the configuration.',
      errReset: 'Could not restore the defaults.',
      errUnknown: 'The request failed.',
    }

    const COPY = { zh, en }
    const LocaleContext = React.createContext(null)

    function useT() {
      return useContext(LocaleContext) ?? ((key) => key)
    }

    // ── data access ───────────────────────────────────────────────────────

    async function call(path, init) {
      let response
      try {
        response = await fetch(`${ROUTE}${path}`, {
          cache: 'no-store',
          ...init,
          headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        })
      } catch {
        return { ok: false, code: 'network' }
      }
      let text = ''
      try {
        text = await response.text()
      } catch {
        return { ok: false, code: 'network' }
      }
      if (text.length === 0) return { ok: false, code: response.status === 404 ? 'unknown-route' : 'failed' }
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, code: 'failed' }
      }
    }

    const ERROR_KEYS = {
      network: 'errNetwork',
      'no-llm': 'errNoLlm',
      'missing-model': 'errMissingModel',
      'bad-review': 'errBadReview',
      'save-failed': 'errSave',
      'reset-failed': 'errReset',
      'unknown-route': 'errUnknown',
      failed: 'errUnknown',
    }

    function errorText(t, payload) {
      const key = ERROR_KEYS[payload?.code]
      const text = key === undefined ? t('errUnknown') : t(key)
      const detail = typeof payload?.detail === 'string' && payload.detail.length > 0 ? ` (${payload.detail})` : ''
      return `${text}${detail}`
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function routeText(route) {
      if (route === null || route === undefined) return null
      const effort = route.effort ? ` · ${route.effort}` : ''
      return `${route.provider}/${route.model}${effort}`
    }

    // ── view ──────────────────────────────────────────────────────────────

    const CSS = `
.om-page { display: flex; flex-direction: column; gap: 14px; }
.om-note { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.om-error { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-state-error-primary); }
.om-warn { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-state-warn-primary); }
.om-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--dsw-alias-label-primary); }
.om-check input { margin-top: 2px; }
.om-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.om-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 720px) { .om-grid { grid-template-columns: 1fr; } }
.om-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.om-field label { font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.om-field select, .om-field input { height: 32px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; min-width: 0; }
.om-field select:disabled, .om-field input:disabled { opacity: 0.58; }
.om-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.om-button { height: 30px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12.5px; cursor: pointer; }
.om-button.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); }
.om-button:disabled { opacity: 0.55; cursor: default; }
.om-route { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.om-status { margin: 0; min-height: 18px; font-size: 12.5px; }
.om-status.ok { color: var(--dsw-alias-state-success-primary); }
.om-status.err { color: var(--dsw-alias-state-error-primary); }
`

    function ConfigForm() {
      const t = useT()
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [confirmReset, setConfirmReset] = useState(false)
      const [form, setForm] = useState({ enabled: true, provider: '', model: '', effort: '', review: '10' })
      const [efforts, setEfforts] = useState([])

      const applyState = useCallback((value) => {
        setData(value)
        setForm({
          enabled: value.config.enabled !== false,
          provider: value.config.executorProvider ?? '',
          model: value.config.executorModel ?? '',
          effort: value.config.executorEffort ?? '',
          review: String(value.config.reviewEvery ?? 10),
        })
      }, [])

      const load = useCallback(async () => {
        const result = await call('/state')
        if (!result.ok) {
          setLoadError(result.code === 'unknown-route' || result.code === 'network' ? t('unavailable') : errorText(t, result))
          setLoading(false)
          return
        }
        applyState(result)
        setLoadError('')
        setLoading(false)
      }, [applyState, t])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        if (!confirmReset) return undefined
        const timer = setTimeout(() => setConfirmReset(false), 4000)
        return () => clearTimeout(timer)
      }, [confirmReset])

      useEffect(() => {
        if (form.provider.length === 0 || form.model.length === 0) {
          setEfforts([])
          return undefined
        }
        let alive = true
        const query = `?provider=${encodeURIComponent(form.provider)}&model=${encodeURIComponent(form.model)}`
        call(`/efforts${query}`).then((result) => {
          if (!alive) return
          setEfforts(result.ok && Array.isArray(result.reasoning?.efforts) ? result.reasoning.efforts : [])
        })
        return () => { alive = false }
      }, [form.provider, form.model])

      if (loading) return h('p', { className: 'om-note' }, t('loading'))
      if (loadError.length > 0) {
        return h('div', { className: 'om-page' },
          h('style', null, CSS),
          h('p', { className: 'om-error', role: 'status' }, loadError),
          h('div', { className: 'om-actions' },
            h('button', {
              type: 'button',
              className: 'om-button',
              onClick: () => { setLoading(true); setLoadError(''); void load() },
            }, t('retry')),
          ),
        )
      }

      const providers = Array.isArray(data?.providers) ? data.providers : []
      const providerEntry = providers.find(entry => entry.id === form.provider)
      const models = Array.isArray(providerEntry?.models) ? providerEntry.models : []
      const disabled = busy || data?.writable === false
      const hasProviderError = providers.some(entry => typeof entry.error === 'string')
      const currentRoute = routeText(data?.route)
      const modelIds = new Set(models.map(model => model.id))
      const effortIds = new Set(efforts.map(effort => effort.id))
      const change = (part) => setForm(current => ({ ...current, ...part }))

      const providerOptions = [
        h('option', { key: '', value: '' }, t('providerNone')),
        ...providers.map(provider => h('option', { key: provider.id, value: provider.id }, provider.name ?? provider.id)),
      ]
      if (form.provider.length > 0 && !providers.some(provider => provider.id === form.provider)) {
        providerOptions.push(h('option', { key: form.provider, value: form.provider, disabled: true }, form.provider))
      }

      function chooseProvider(id) {
        if (id.length === 0) {
          change({ provider: '', model: '', effort: '' })
          return
        }
        const entry = providers.find(candidate => candidate.id === id)
        const options = Array.isArray(entry?.models) ? entry.models : []
        const keep = options.some(model => model.id === form.model) ? form.model : (options[0]?.id ?? '')
        change({ provider: id, model: keep, effort: '' })
      }

      const save = async () => {
        const reviewEvery = Number(form.review)
        if (!Number.isInteger(reviewEvery) || reviewEvery < 0 || reviewEvery > 1000) {
          setNotice('')
          setError(t('errBadReview'))
          return
        }
        setBusy(true)
        setNotice('')
        setError('')
        const result = await call('/config', {
          method: 'POST',
          body: JSON.stringify({
            enabled: form.enabled,
            executorProvider: form.provider,
            executorModel: form.model,
            executorEffort: form.effort,
            reviewEvery,
          }),
        })
        if (!result.ok) {
          setError(errorText(t, result))
          setBusy(false)
          return
        }
        setNotice(t('saved'))
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(500)
          const state = await call('/state')
          if (state.ok) {
            applyState(state)
            setNotice(t('reloaded'))
            setBusy(false)
            return
          }
        }
        setNotice(t('reloadFailed'))
        setBusy(false)
      }

      const reset = async () => {
        if (!confirmReset) {
          setConfirmReset(true)
          return
        }
        setConfirmReset(false)
        setBusy(true)
        setNotice('')
        setError('')
        const result = await call('/config', { method: 'POST', body: JSON.stringify({ reset: true }) })
        if (!result.ok) {
          setError(errorText(t, result))
          setBusy(false)
          return
        }
        setNotice(t('resetDone'))
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(500)
          const state = await call('/state')
          if (state.ok) {
            applyState(state)
            setNotice(t('reloaded'))
            setBusy(false)
            return
          }
        }
        setNotice(t('reloadFailed'))
        setBusy(false)
      }

      const modelField = models.length > 0
        ? h('select', {
          id: 'om-model',
          value: form.model,
          disabled,
          onChange: event => change({ model: event.target.value, effort: '' }),
        },
        h('option', { value: '' }, t('modelPlaceholder')),
        ...models.map(model => h('option', { key: model.id, value: model.id }, model.name ?? model.id)),
        form.model.length > 0 && !modelIds.has(form.model)
          ? h('option', { value: form.model, disabled: true }, form.model)
          : null,
        )
        : h('input', {
          id: 'om-model',
          type: 'text',
          value: form.model,
          disabled,
          placeholder: t('modelManual'),
          onChange: event => change({ model: event.target.value, effort: '' }),
        })

      const effortField = efforts.length > 0
        ? h('select', {
          id: 'om-effort',
          value: form.effort,
          disabled,
          onChange: event => change({ effort: event.target.value }),
        },
        h('option', { value: '' }, t('effortDefault')),
        ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id)),
        form.effort.length > 0 && !effortIds.has(form.effort)
          ? h('option', { value: form.effort, disabled: true }, form.effort)
          : null,
        )
        : h('input', {
          id: 'om-effort',
          type: 'text',
          value: form.effort,
          disabled,
          placeholder: t('effortManual'),
          onChange: event => change({ effort: event.target.value }),
        })

      return h('div', { className: 'om-page', 'data-orchestrator-config': 'page' },
        h('style', null, CSS),
        h('p', { className: 'om-note' }, t('intro')),
        h('label', { className: 'om-check', htmlFor: 'om-enabled' },
          h('input', {
            id: 'om-enabled',
            type: 'checkbox',
            checked: form.enabled,
            disabled,
            onChange: event => change({ enabled: event.target.checked }),
          }),
          h('span', null, t('enabled')),
        ),
        h('p', { className: 'om-hint' }, t('enabledHint')),
        h('div', { className: 'om-grid' },
          h('div', { className: 'om-field' },
            h('label', { htmlFor: 'om-provider' }, t('provider')),
            h('select', {
              id: 'om-provider',
              value: form.provider,
              disabled,
              onChange: event => chooseProvider(event.target.value),
            }, providerOptions),
          ),
          h('div', { className: 'om-field' },
            h('label', { htmlFor: 'om-model' }, t('model')),
            modelField,
          ),
          h('div', { className: 'om-field' },
            h('label', { htmlFor: 'om-effort' }, t('effort')),
            effortField,
          ),
          h('div', { className: 'om-field' },
            h('label', { htmlFor: 'om-review' }, t('review')),
            h('input', {
              id: 'om-review',
              type: 'number',
              min: '0',
              max: '1000',
              step: '1',
              value: form.review,
              disabled,
              onChange: event => change({ review: event.target.value }),
            }),
            h('p', { className: 'om-hint' }, t('reviewHint')),
          ),
        ),
        h('p', { className: 'om-route' },
          `${t('current')}: ${currentRoute ?? t('currentNone')}`,
          data?.tools ? ` · ${t('tools')}: ${data.tools.exit} / ${data.tools.enter}` : '',
        ),
        providers.length === 0 ? h('p', { className: 'om-warn' }, t('noProviders')) : null,
        hasProviderError ? h('p', { className: 'om-warn' }, t('catalogPartial')) : null,
        data?.catalogError ? h('p', { className: 'om-warn' }, `${data.catalogError.code}: ${data.catalogError.detail ?? ''}`) : null,
        (Array.isArray(data?.warnings) ? data.warnings : []).map((warning, index) =>
          h('p', { className: 'om-warn', key: `warning-${index}` }, warning)),
        h('p', { className: 'om-warn' }, t('warning')),
        data?.writable === false ? h('p', { className: 'om-note' }, t('notWritable')) : null,
        h('div', { className: 'om-actions' },
          h('button', {
            type: 'button',
            className: 'om-button primary',
            disabled: disabled,
            onClick: () => { void save() },
          }, busy ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'om-button',
            disabled: disabled,
            onClick: () => { void reset() },
          }, confirmReset ? t('resetConfirm') : t('reset')),
        ),
        h('p', {
          className: `om-status ${error.length > 0 ? 'err' : 'ok'}`,
          role: 'status',
          'aria-live': 'polite',
        }, error.length > 0 ? error : notice),
      )
    }

    function ConfigPage(props) {
      const t = useT()
      if (props?.view === 'summary') return h('span', null, t('summary'))
      return h(ConfigForm)
    }

    function bindPage(t) {
      return function BoundPage(props) {
        return h(LocaleContext.Provider, { value: t }, h(ConfigPage, props))
      }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, COPY), 'orchestrator-mode: dictionaries')
      const Page = bindPage(t)
      ctx.effect(
        () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-orchestrator-mode#orchestrator-mode',
          locale: NS,
        }, Page)),
        'orchestrator-mode: plugin page',
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})