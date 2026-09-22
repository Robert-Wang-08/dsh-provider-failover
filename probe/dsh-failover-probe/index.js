/**
 * dsh-failover-probe —— M0 证据探针（Host 半，纯观测 + 可选的单次切换实验）
 *
 * 目的（对应 tasks.md T0.2 / T0.3）：
 *   1. 记录 `agent/request`、`agent/request-error`、`llm/stream` 的真实触发次数与载荷；
 *   2. 验证「在 agent/request 里返回替换后的 provider/model，能否让同一步的下一次尝试
 *      真的走另一条路由」。
 *
 * 线索文件为 JSONL，一行一个事件。它不做任何生产决策、不写凭据、不改宿主。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-failover-probe'
export const inject = []
export const Config = undefined

function writeLine(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(record) + '\n')
  } catch (error) {
    process.stderr.write('[failover-probe] cannot write log: ' + String(error) + '\n')
  }
}

function text(value, limit) {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return s.length > limit ? s.slice(0, limit) : s
}

/**
 * @param {import('cordis').Context} ctx
 * @param {{ logFile?: string, switchTo?: string, switchModel?: string }} config
 */
export function apply(ctx, config = {}) {
  const logFile = typeof config.logFile === 'string' && config.logFile.length > 0 ? config.logFile : 'probe.jsonl'
  const switchTo = typeof config.switchTo === 'string' ? config.switchTo : ''
  const switchModel = typeof config.switchModel === 'string' ? config.switchModel : ''
  const state = { target: undefined, targetKey: '' }
  let requestSeq = 0

  process.stderr.write('[failover-probe] ready: log=' + logFile + ' switchTo=' + (switchTo.length > 0 ? switchTo : '(off)') + '\n')

  // 诊断：直接问 LLM 服务这条路由能不能解析，报错原文写入日志。
  ctx.inject(['llm'], (inner) => {
    const llm = inner.llm
    const providers = Array.isArray(config.diagnoseProviders) ? config.diagnoseProviders : []
    if (llm === undefined || llm === null || providers.length === 0) return
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      for (const provider of providers) {
        try {
          const models = await llm.listModels(provider)
          writeLine(logFile, { event: 'probe.listModels', provider, models: models.map((m) => m.id) })
        } catch (error) {
          writeLine(logFile, { event: 'probe.listModels.error', provider, message: text(error !== null && error !== undefined ? error.message : error, 300) })
        }
      }
      try {
        const info = await llm.resolveModel('probe-quota', 'probe-model')
        writeLine(logFile, { event: 'probe.resolveModel', ok: true, context: info !== null && info !== undefined && info.context !== undefined ? info.context.contextWindow : null })
      } catch (error) {
        writeLine(logFile, { event: 'probe.resolveModel', ok: false, message: text(error !== null && error !== undefined ? error.message : error, 300) })
      }
    })()
  })

  ctx.on('llm/stream', (options, next) => {
    const provider = options !== null && options !== undefined ? options.provider : undefined
    const model = options !== null && options !== undefined ? options.model : undefined
    writeLine(logFile, { seq: ++requestSeq, event: 'llm/stream', provider: provider ?? null, model: model ?? null })
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    const key = String(payload.turn) + '/' + String(payload.step)
    const switched = state.target !== undefined && state.targetKey === key
    writeLine(logFile, {
      event: switched ? 'agent/request.switched' : 'agent/request.pass',
      turn: payload.turn,
      step: payload.step,
      from: base.provider + '/' + base.model,
      to: switched ? state.target.provider + '/' + state.target.model : null,
    })
    if (!switched) return base
    return { ...base, provider: state.target.provider, model: state.target.model }
  })

  ctx.on('agent/request-error', async (payload, next) => {
    const failure = payload !== null && payload !== undefined ? payload.failure : undefined
    const code = failure !== null && failure !== undefined ? failure.code : undefined
    const message = failure !== null && failure !== undefined ? failure.message : undefined
    const key = String(payload.turn) + '/' + String(payload.step)
    writeLine(logFile, {
      event: 'agent/request-error',
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider ?? null,
      code: code ?? null,
      message: text(message, 200),
    })
    if (switchTo.length === 0) return next()
    if (state.targetKey === key) {
      writeLine(logFile, { event: 'probe.delegate', turn: payload.turn, step: payload.step, reason: 'already-switched-this-step' })
      return next()
    }
    state.target = { provider: switchTo, model: switchModel.length > 0 ? switchModel : undefined }
    state.targetKey = key
    writeLine(logFile, { event: 'probe.decide-retry', turn: payload.turn, step: payload.step, code: code ?? null, switchTo })
    return { kind: 'retry' }
  })
}
