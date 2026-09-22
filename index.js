/**
 * dsh-provider-failover（原 dsh-deepseek-keypool 就地升级）
 *
 * 在模型请求以「可切换失败」结束时，按**分档配置表**顺序把下一个请求换成另一条
 * harness 路由（provider），并可同时下发该条目声明的模型与推理层级。
 *
 * 机制依据（本地 mock 端点实测）：
 *   1. `agent/request` 是 waterfall，返回值直接决定本次尝试的 provider/model；
 *      在失败的同一个 step 里，后续尝试会重新发射该钩子，因此换 provider 生效。
 *   2. `agent/request-error` 每次失败尝试发射一次；返回 `{kind:'retry'}` 触发同一步再试。
 *      交回 `next()` 会进入宿主自带的重试策略（dsh-llm-retry）。
 *   3. 失败码由适配器归一化：402→QUOTA，401/403→AUTH，429→RATE_LIMIT，5xx→SERVER；
 *      凭据不可用的路由会以 NO_ADAPTER 失败。
 *
 * 约束（自 openspec 规范）：
 *   - 不持有、不存储、不写入任何凭据；凭据由各路由既有 apiKeyEnv 从宿主凭据源解析。
 *   - 每 `(turn, step)` 每个条目至多尝试一次；单 turn 切换次数有上限；冷却期内不选中。
 *   - 未配置/未启用时零介入；无法解析目标时交回宿主，不做隐式降级。
 */

import z from '@deepseek-ai/schemastery'

export const name = 'dsh-provider-failover'

export const inject = []

/** 设置页（settings.section）与状态接口共用的命名空间与路由前缀。 */
const SETTINGS_NAMESPACE = 'provider-failover'
const ROUTE_BASE = '/provider-failover'
const LOG_LIMIT = 10

/**
 * 设置页可编辑项（总开关 + 常用参数）。schema 即取值契约：
 * 用户层的值落在 `$DSH_HOME/settings.yaml` 的 `provider-failover:` 段，
 * 生效时机为 resolved 值变更（默认 live），无需重启。
 */
const FailoverSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  minSwitchIntervalMs: z.number().step(1).min(0).default(1000),
  maxSwitchesPerTurn: z.number().step(1).min(1).default(6),
  startupPreferTier: z.number().step(1).min(0).default(1),
  rankingMode: z.union(['declared', 'keywords', 'llm']).default('keywords'),
})

/** 只读状态接口与设置页共用的 JSON 助手。 */
function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = '{"ok":false,"error":"response is not serializable"}'
    status = 500
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  try {
    for await (const chunk of req) chunks.push(chunk)
  } catch (error) {
    return {}
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

function isLocalRequest(req) {
  const socket = req !== null && req !== undefined ? req.socket : undefined
  const addr = socket !== null && socket !== undefined ? socket.remoteAddress : undefined
  if (typeof addr !== 'string' || addr.length === 0) return true
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.indexOf('127.') === 0
}

/** 可切换失败的默认归一化编码集合。 */
const DEFAULT_TERMINAL_CODES = ['QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'SERVER', 'RATE_LIMIT']

/** 编码未归一化时的消息模式兜底（大小写不敏感）。 */
const DEFAULT_FAILURE_PATTERNS = [
  'insufficient balance',
  'insufficient_quota',
  'quota exceeded',
  'balance',
  'overloaded',
  'invalid api key',
  'token limit',
  'rate limit',
]

/**
 * 示例默认表：全新安装时**零介入**——示例档默认禁用，且路由不指向任何真实服务。
 * 实际档位请在 profile 的 cordis.patch.yml 里按插件 id 覆盖 config.tiers（见 README「覆盖方式」）。
 */
const DEFAULT_TIERS = [
  {
    tier: 1,
    enabled: false,
    entries: [
      { id: 'example', route: 'example-provider', model: 'example-model', description: '示例条目：替换为你自己的首选路由与模型', keywords: [], compatible: { tools: true, images: true }, cooldownMs: 60000 },
    ],
  },
]

/** 排序请求的输出预算：推理型模型会把较多 token 花在推理上，预算过小会导致可见输出为空。 */
const RANKING_MAX_TOKENS = 512

const DEFAULT_CONFIG = {
  enabled: true,
  terminalCodes: DEFAULT_TERMINAL_CODES,
  failurePatterns: DEFAULT_FAILURE_PATTERNS,
  minSwitchIntervalMs: 1000,
  maxSwitchesPerTurn: 6,
  probeTarget: true,
  startup: { preferTier: 1 },
  ranking: {
    mode: 'keywords',
    // 实测：真实排序模型一次排序可达秒级（5-15s），默认超时按此设定；过小会导致 llm 模式永远回退。
    timeoutMs: 20000,
    cacheTtlMs: 60000,
    // 有序候选：按顺序尝试，跳过正在失败的那条路由；整条链共用一个超时预算。
    // 默认为空（无内置路由），需要 llm 排序时在 profile patch 里按自己的路由配置。
    models: [],
    provider: '',
    model: '',
  },
  tiers: DEFAULT_TIERS,
}

// ---------------------------------------------------------------- 配置校验

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) !== true
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : []
}

/**
 * 归一化并与默认值合并。返回 `{ value, errors }`；有 errors 时调用方必须按
 * 「零配置零介入」处理，不得带着部分配置继续运行。
 */
function normalizeConfig(raw) {
  const errors = []
  const input = isPlainObject(raw) ? raw : {}
  const config = {
    enabled: input.enabled === undefined ? DEFAULT_CONFIG.enabled : input.enabled === true,
    terminalCodes: new Set((strings(input.terminalCodes).length > 0 ? strings(input.terminalCodes) : DEFAULT_TERMINAL_CODES).map((code) => code.toUpperCase())),
    failurePatterns: (strings(input.failurePatterns).length > 0 ? strings(input.failurePatterns) : DEFAULT_FAILURE_PATTERNS).map((pattern) => pattern.toLowerCase()),
    minSwitchIntervalMs: input.minSwitchIntervalMs === undefined ? DEFAULT_CONFIG.minSwitchIntervalMs : input.minSwitchIntervalMs,
    maxSwitchesPerTurn: input.maxSwitchesPerTurn === undefined ? DEFAULT_CONFIG.maxSwitchesPerTurn : input.maxSwitchesPerTurn,
    probeTarget: input.probeTarget === undefined ? DEFAULT_CONFIG.probeTarget : input.probeTarget === true,
    startup: { preferTier: 0 },
    ranking: {
      mode: 'keywords',
      timeoutMs: DEFAULT_CONFIG.ranking.timeoutMs,
      cacheTtlMs: DEFAULT_CONFIG.ranking.cacheTtlMs,
      provider: '',
      model: '',
    },
    tiers: [],
  }

  if (typeof config.minSwitchIntervalMs !== 'number' || Number.isFinite(config.minSwitchIntervalMs) !== true || config.minSwitchIntervalMs < 0) errors.push('minSwitchIntervalMs must be a non-negative number (0 disables the interval guard)')
  if (!Number.isInteger(config.maxSwitchesPerTurn) || config.maxSwitchesPerTurn < 1) errors.push('maxSwitchesPerTurn must be a positive integer')

  const startup = isPlainObject(input.startup) ? input.startup : {}
  if (startup.preferTier !== undefined) {
    if (!Number.isInteger(startup.preferTier) || startup.preferTier < 0) errors.push('startup.preferTier must be a non-negative integer (0 disables)')
    else config.startup.preferTier = startup.preferTier
  } else config.startup.preferTier = DEFAULT_CONFIG.startup.preferTier

  const ranking = isPlainObject(input.ranking) ? input.ranking : {}
  const mode = optionalString(ranking.mode) ?? DEFAULT_CONFIG.ranking.mode
  if (['declared', 'keywords', 'llm'].indexOf(mode) < 0) errors.push('ranking.mode must be one of declared|keywords|llm')
  else config.ranking.mode = mode
  if (ranking.timeoutMs !== undefined) {
    if (!positiveNumber(ranking.timeoutMs)) errors.push('ranking.timeoutMs must be a positive number')
    else config.ranking.timeoutMs = ranking.timeoutMs
  }
  if (ranking.cacheTtlMs !== undefined) {
    if (!positiveNumber(ranking.cacheTtlMs)) errors.push('ranking.cacheTtlMs must be a positive number')
    else config.ranking.cacheTtlMs = ranking.cacheTtlMs
  }
  // 排序模型：优先读有序列表 `ranking.models`；兼容单条 `provider`/`model` 写法。
  const models = Array.isArray(ranking.models) ? ranking.models : []
  const chain = []
  for (const item of models) {
    if (!isPlainObject(item)) {
      errors.push('ranking.models entries must be objects with provider and model')
      continue
    }
    const provider = optionalString(item.provider)
    const model = optionalString(item.model)
    if (provider === undefined || model === undefined) errors.push('ranking.models entries require provider and model')
    else chain.push({ provider, model })
  }
  if (chain.length === 0 && models.length === 0) {
    const provider = optionalString(ranking.provider)
    const model = optionalString(ranking.model)
    if (provider !== undefined && model !== undefined) chain.push({ provider, model })
    else if ((provider === undefined) !== (model === undefined)) errors.push('ranking.provider and ranking.model must be set together')
  }
  if (chain.length > 0) config.ranking.models = chain
  config.ranking.provider = optionalString(ranking.provider) ?? ''
  config.ranking.model = optionalString(ranking.model) ?? ''

  const tiers = Array.isArray(input.tiers) ? input.tiers : DEFAULT_CONFIG.tiers
  const seenTier = new Set()
  const seenId = new Set()
  for (const rawTier of tiers) {
    if (!isPlainObject(rawTier)) {
      errors.push('tier entry must be an object')
      continue
    }
    const tierNumber = rawTier.tier
    if (!Number.isInteger(tierNumber) || tierNumber < 1) errors.push('tier.tier must be a positive integer')
    else if (seenTier.has(tierNumber)) errors.push('duplicate tier ' + String(tierNumber))
    else seenTier.add(tierNumber)
    const entries = []
    for (const rawEntry of Array.isArray(rawTier.entries) ? rawTier.entries : []) {
      if (!isPlainObject(rawEntry)) {
        errors.push('entries[] item must be an object (tier ' + String(tierNumber) + ')')
        continue
      }
      const id = optionalString(rawEntry.id)
      const route = optionalString(rawEntry.route)
      const model = optionalString(rawEntry.model)
      if (id === undefined) errors.push('entry.id is required (tier ' + String(tierNumber) + ')')
      else if (seenId.has(id)) errors.push('duplicate entry id: ' + id)
      else seenId.add(id)
      if (route === undefined) errors.push('entry.route is required (entry ' + String(id ?? '?') + ')')
      if (model === undefined) errors.push('entry.model is required (entry ' + String(id ?? '?') + ')')
      const cooldownMs = rawEntry.cooldownMs === undefined ? 60000 : rawEntry.cooldownMs
      if (!positiveNumber(cooldownMs)) errors.push('entry.cooldownMs must be a positive number (entry ' + String(id ?? '?') + ')')
      // 条目内 key 轮换（opt-in）：keys[] 是兄弟路由 key，轮换序列 = [route, ...keys]。
      const keys = []
      if (rawEntry.keys !== undefined && Array.isArray(rawEntry.keys) !== true) {
        errors.push('entry.keys must be an array of route keys (entry ' + String(id ?? '?') + ')')
      }
      if (Array.isArray(rawEntry.keys)) {
        const seenKey = new Set()
        for (const item of rawEntry.keys) {
          const keyRoute = optionalString(item)
          if (keyRoute === undefined) {
            errors.push('entry.keys items must be non-empty strings (entry ' + String(id ?? '?') + ')')
            continue
          }
          if (keyRoute === route) {
            errors.push('entry.keys must not repeat entry.route: ' + keyRoute + ' (entry ' + String(id ?? '?') + ')')
            continue
          }
          if (seenKey.has(keyRoute)) {
            errors.push('duplicate key route in entry.keys: ' + keyRoute + ' (entry ' + String(id ?? '?') + ')')
            continue
          }
          seenKey.add(keyRoute)
          keys.push(keyRoute)
        }
        if (keys.length === 0 && route !== undefined) {
          errors.push('entry.keys declares no usable distinct key route; in-entry rotation needs at least one key besides entry.route (entry ' + String(id ?? '?') + ')')
        }
      }
      if (id === undefined || route === undefined || model === undefined || !positiveNumber(cooldownMs)) continue
      const compatible = isPlainObject(rawEntry.compatible) ? rawEntry.compatible : {}
      entries.push({
        id,
        route,
        model,
        description: optionalString(rawEntry.description) ?? '',
        keywords: strings(rawEntry.keywords).map((keyword) => keyword.toLowerCase()),
        compatible: { tools: compatible.tools !== false, images: compatible.images === true },
        cooldownMs,
        reasoningEffort: optionalString(rawEntry.reasoningEffort),
        enabled: rawEntry.enabled !== false,
        keys,
      })
    }
    if (Array.isArray(rawTier.entries) !== true) errors.push('tier.entries must be an array (tier ' + String(tierNumber) + ')')
    config.tiers.push({ tier: Number.isInteger(tierNumber) ? tierNumber : 0, enabled: rawTier.enabled === true, entries })
  }
  // 每个 key 只用于单个 provider：同一路由 key（主路由或 keys 候选）不得服务多个条目。
  const routeOwner = new Map()
  for (const tier of config.tiers) {
    for (const entry of tier.entries) {
      for (const routeKey of [entry.route, ...entry.keys]) {
        const owner = routeOwner.get(routeKey)
        if (owner !== undefined) {
          errors.push('route key "' + routeKey + '" is used by both entry ' + owner + ' and entry ' + entry.id + '; each key serves a single provider')
        } else {
          routeOwner.set(routeKey, entry.id)
        }
      }
    }
  }

  config.tiers.sort((a, b) => a.tier - b.tier)
  if (config.tiers.length === 0) errors.push('tiers must not be empty')

  return { value: config, errors }
}

// ---------------------------------------------------------------- 状态与工具

function messageOf(error) {
  if (error !== null && error !== undefined && error.message !== undefined) return String(error.message)
  return String(error)
}

/** 稳定的小哈希，用于排序缓存键（不引入 crypto 依赖）。 */
function hashKey(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 排序输入脱敏：截断 + 抹掉形似密钥的片段。会话正文与凭据都不会进入这里。 */
function sanitizeForRanking(text, limit) {
  const trimmed = typeof text === 'string' ? text.replace(/\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9-_]{8,}/gi, '[redacted]') : ''
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

function masked(value) {
  const text = typeof value === 'string' ? value : ''
  if (text.length === 0) return ''
  if (text.length <= 10) return text.slice(0, 3) + '***'
  return text.slice(0, 6) + '····' + text.slice(-4)
}

/** 该失败是否属于「可切换」。code 命中集合或消息命中模式都算。 */
function isSwitchable(config, code, message) {
  const normalized = typeof code === 'string' ? code.toUpperCase() : ''
  if (config.terminalCodes.has(normalized)) return { hit: true, how: 'code:' + normalized }
  if (normalized === 'CONTEXT_WINDOW_EXCEEDED' || normalized === 'INVALID_REQUEST') return { hit: false, how: '' }
  const haystack = (String(message ?? '') + ' ' + normalized).toLowerCase()
  for (const pattern of config.failurePatterns) {
    if (haystack.indexOf(pattern) >= 0) return { hit: true, how: 'pattern:' + pattern }
  }
  return { hit: false, how: '' }
}

function tierOf(config, route) {
  for (const tier of config.tiers) {
    for (const entry of tier.entries) if (entry.route === route) return tier
  }
  return undefined
}

/** 失败归属：返回路由（条目主路由或 keys 候选）所在的 {tier, entry}。 */
function locateRoute(config, route) {
  for (const tier of config.tiers) {
    for (const entry of tier.entries) {
      if (entry.route === route || entry.keys.includes(route)) return { tier, entry }
    }
  }
  return undefined
}

/**
 * 档内排序：`declared` 原序；`keywords` 按「失败上下文 + 会话需要的能力」命中关键词前移；
 * `llm` 由调用方先给出结果（这里只用已缓存的排序，未命中则退回 keywords）。
 */
function orderEntries(entries, context) {
  const scored = entries.map((entry, index) => {
    let score = 0
    const haystack = context.toLowerCase()
    for (const keyword of entry.keywords) if (haystack.indexOf(keyword) >= 0) score += 10
    for (const word of entry.description.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 3 && haystack.indexOf(word) >= 0) score += 1
    }
    return { entry, score, index }
  })
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return scored.map((item) => item.entry)
}

/**
 * 解析排序回复：按候选 id 在文本中以**独立词元**首次出现的顺序排列，未出现的按原序补齐。
 * 只做整词匹配：`o` 不得匹配到 `ok`，`ais` 不得匹配到 `raise`（id 常是常用词）。
 * 结果为空时返回 undefined（调用方回退到声明顺序）。
 */
function parseRanking(text, candidates) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const tokens = text.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length > 0)
  const found = []
  for (const candidate of candidates) {
    const at = tokens.indexOf(candidate.id.toLowerCase())
    if (at >= 0) found.push({ id: candidate.id, at })
  }
  if (found.length === 0) return undefined
  found.sort((a, b) => a.at - b.at)
  const ids = found.map((item) => item.id)
  for (const candidate of candidates) if (ids.indexOf(candidate.id) < 0) ids.push(candidate.id)
  return ids
}

// ------------------------------------------------------------------- 插件

/**
 * @param {import('cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig 插件条目 config
 */
export function apply(ctx, rawConfig) {
  const { value: config, errors } = normalizeConfig(rawConfig)
  if (errors.length > 0) {
    // 校验失败：零介入，并把原因报到日志，便于诊断。
    ctx.logger?.warn?.('dsh-provider-failover: configuration rejected, staying out of the way:\n  - ' + errors.join('\n  - '))
    console.warn('[dsh-provider-failover] configuration rejected, staying out of the way:\n  - ' + errors.join('\n  - '))
    return
  }

  const state = {
    /** route -> { coolingUntil, code, message, at } */
    routeHealth: new Map(),
    /** 最近转移记录（上限 50） */
    switchLog: [],
    /** stepKey -> { attempted:Set<'entryId@route'>, target, switches, needs, at } */
    steps: new Map(),
    /** keys 候选的预检警告去重（每路由每进程一次，避免刷屏） */
    keyWarned: new Set(),
    lastSwitchAt: 0,
    /** 排序结果缓存：hash -> { ids, at } */
    rankingCache: new Map(),
    /** 进行中的排序请求 signal 集合（钩子据此豁免自身调用；支持并发） */
    rankingSignals: new Set(),
    /** 最近一次会话身份 { id, at }，供旁路排序调用使用（短 TTL） */
    lastSessionId: undefined,
    /** settings scope（settings 服务未组合时为 undefined） */
    settings: undefined,
    /** settings 同步函数，/config 路由保存后用它立即预演，避免响应竞态 */
    syncSettings: undefined,
  }

  const stepKeyOf = (turn, step) => String(turn) + '/' + String(step)

  function stepState(turn, step) {
    const key = stepKeyOf(turn, step)
    let record = state.steps.get(key)
    if (record === undefined) {
      record = { attempted: new Set(), target: undefined, switches: 0, needs: { tools: false, images: false }, at: 0 }
      state.steps.set(key, record)
      if (state.steps.size > 128) {
        // 按 lastAccess 淘汰：不得误删活跃 step 的记账（R5 语义）。
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [k, v] of state.steps) {
          if (v.at < oldestAt) {
            oldestAt = v.at
            oldestKey = k
          }
        }
        if (oldestKey !== undefined) state.steps.delete(oldestKey)
      }
    }
    record.at = Date.now()
    return record
  }

  const llm = () => ctx.get('llm') ?? undefined

  function cooling(route, now) {
    const health = state.routeHealth.get(route)
    return health !== undefined && health.coolingUntil > now
  }

  function pushLog(record) {
    state.switchLog.unshift(record)
    if (state.switchLog.length > 50) state.switchLog.length = 50
  }

  /** 目标预检：路由/模型必须能被解析；失败即视为候选不合格。 */
  async function serviceable(entry, signal, keyRoute) {
    if (config.probeTarget !== true) return true
    const service = llm()
    if (service === undefined || typeof service.resolveModelInfo !== 'function') return true
    const route = keyRoute ?? entry.route
    try {
      await service.resolveModelInfo(route, entry.model, signal)
      return true
    } catch (error) {
      if (route === entry.route) {
        console.warn('[dsh-provider-failover] candidate skipped (unresolvable): ' + route + '/' + entry.model + ' — ' + messageOf(error))
      } else if (state.keyWarned.has(route) !== true) {
        // keys 候选不可解析：按路由名去重，每进程只警告一次。
        state.keyWarned.add(route)
        console.warn('[dsh-provider-failover] key candidate skipped (unresolvable): ' + entry.id + '@' + route + '/' + entry.model + ' — ' + messageOf(error))
      }
      return false
    }
  }

  function compatible(entry, needs) {
    if (needs.tools === true && entry.compatible.tools !== true) return false
    if (needs.images === true && entry.compatible.images !== true) return false
    return true
  }

  /**
   * 运行期大模型排序（模式 C）。硬边界：
   *   - 只发脱敏摘要：失败编码 + 截断消息 + 候选 id/路由/描述/关键词；
   *   - `ranking.models` 是有序候选：按序尝试，跳过与失败路由同一 provider 的那条；
   *   - 整条链共用一个 `ranking.timeoutMs` 预算，超时/报错/不可解析一律返回 undefined（调用方回退）；
   *   - 结果按「候选集合 + 上下文 + 排序链」哈希缓存 `ranking.cacheTtlMs`（负结果同样入缓存）；
   *   - 排序调用走 `ctx.llm.stream` 直连（不经 agent 循环），并用专用 signal 让本插件钩子跳过它。
   */
  async function rankWithLlm(candidates, context, signal, excludeRoute) {
    const service = llm()
    if (service === undefined || typeof service.stream !== 'function') return undefined
    const chain = config.ranking.models.filter((target) => target.provider !== excludeRoute)
    if (chain.length === 0) return undefined
    const chainKey = chain.map((target) => target.provider + '/' + target.model).join(',')
    const cacheKey = hashKey(chainKey + '|' + context + '|' + candidates.map((candidate) => candidate.id).join(','))
    const cached = state.rankingCache.get(cacheKey)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < config.ranking.cacheTtlMs) return cached.ids
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('ranking timeout')) }, config.ranking.timeoutMs)
    if (signal !== undefined) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    const lines = candidates.map((candidate) => '- ' + candidate.id + ' | ' + candidate.route + '/' + candidate.model + ' | ' + candidate.description + ' | keywords: ' + candidate.keywords.join(' ')).join('\n')
    const prompt = 'You are ranking fallback model endpoints for one failed request.\n'
      + 'Failure context: ' + sanitizeForRanking(context, 400) + '\n'
      + 'Candidates:\n' + lines + '\n\n'
      + 'Reply with ONLY the candidate ids in the order they should be tried, best first, separated by commas.'
    const remember = (ids) => {
      state.rankingCache.set(cacheKey, { ids, at: Date.now() })
      if (state.rankingCache.size > 64) {
        const oldest = state.rankingCache.keys().next()
        if (oldest.done !== true) state.rankingCache.delete(oldest.value)
      }
    }
    const startedAt = Date.now()
    try {
      for (const target of chain) {
        let text = ''
        let blockText = ''
        let streamFailure
        try {
          // 排序请求自身也会经过 llm/stream；用专用 signal 让钩子识别并跳过它，
          // 否则它会覆盖 pendingNeeds、并让排序缓存键每次都不同（实测 8 次调用不收敛）。
          state.rankingSignals.add(controller.signal)
          const request = { provider: target.provider, model: target.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: RANKING_MAX_TOKENS, signal: controller.signal }
          // 会话作用域的路由（要求 x-opencode-session 这类会话头的路由）需要把会话身份带给适配器，否则 400 MissingSessionID；
          // 只带最近 1 小时内的会话身份，避免跨会话串扰。
          const session = state.lastSessionId
          if (session !== undefined && Date.now() - session.at < 3600000) request.sessionId = session.id
          const stream = service.stream(request)
          const debugTypes = {}
          for await (const chunk of stream) {
            if (chunk === null || chunk === undefined) continue
            if (process.env.DSH_FAILOVER_DEBUG === '1') debugTypes[chunk.type] = (debugTypes[chunk.type] || 0) + 1
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            // 兜底：部分适配器只在 block-end 给出完整文本块（实测推理模型可能不产生 text-delta）。
            else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') blockText += chunk.block.text
            else if (chunk.type === 'finish') {
              // 失败以 finish 结束（不抛异常），必须显式识别，否则会被当成「空回复」而静默回退。
              if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') streamFailure = chunk.reason.failure ?? { message: 'stream ' + String(chunk.reason.kind) }
              if (process.env.DSH_FAILOVER_DEBUG === '1') debugTypes.finishReason = chunk.reason
            }
          }
          if (text.length === 0) text = blockText
          if (process.env.DSH_FAILOVER_DEBUG === '1') console.warn('[dsh-provider-failover] ranking chunks: ' + JSON.stringify(debugTypes))
        } catch (error) {
          console.warn('[dsh-provider-failover] llm ranking target unavailable (' + target.provider + '/' + target.model + '): ' + messageOf(error))
          if (controller.signal.aborted) break
          continue
        }
        if (streamFailure !== undefined) {
          console.warn('[dsh-provider-failover] llm ranking target failed (' + target.provider + '/' + target.model + '): ' + String(streamFailure.code ?? '') + ' ' + messageOf(streamFailure))
          if (controller.signal.aborted) break
          continue
        }
        const ids = parseRanking(text, candidates)
        if (process.env.DSH_FAILOVER_DEBUG === '1') console.warn('[dsh-provider-failover] ranking raw (' + String(text.length) + ' chars): ' + JSON.stringify(text.slice(0, 300)))
        if (ids === undefined) {
          console.warn('[dsh-provider-failover] llm ranking unparseable from ' + target.provider + '/' + target.model)
          continue
        }
        remember(ids)
        console.warn('[dsh-provider-failover] llm ranking (' + target.provider + '/' + target.model + '): ' + ids.join(' > ') + ' [' + String(Date.now() - startedAt) + 'ms]')
        return ids
      }
      remember(undefined)
      return undefined
    } finally {
      clearTimeout(timer)
      state.rankingSignals.delete(controller.signal)
    }
  }

  /** 每 failover 的档内顺序：declared 原序；keywords/llm 按命中重排（llm 未命中缓存则退回 keywords）。 */
  async function entriesInOrder(tier, context, signal, excludeRoute) {
    if (config.ranking.mode === 'declared') return tier.entries
    if (config.ranking.mode === 'llm') {
      const ranked = await rankWithLlm(tier.entries, context, signal, excludeRoute)
      if (ranked !== undefined) {
        const byId = new Map(tier.entries.map((entry) => [entry.id, entry]))
        const ordered = ranked.map((id) => byId.get(id)).filter((entry) => entry !== undefined)
        for (const entry of tier.entries) if (ordered.indexOf(entry) < 0) ordered.push(entry)
        return ordered
      }
    }
    return orderEntries(tier.entries, context)
  }

  async function pickCandidate(turn, step, context, signal, excludeRoute, primaryOnly) {
    const record = stepState(turn, step)
    const now = Date.now()
    for (const tier of config.tiers) {
      if (tier.enabled !== true) continue
      for (const entry of await entriesInOrder(tier, context, signal, excludeRoute)) {
        if (entry.enabled !== true) continue
        // entry-major：先穷尽条目自身路由与其 keys 候选，再进入下一条目（条目内先换 key）。
        // primaryOnly（启动对齐专用）：只考虑条目主路由，keys 不参与，且主路由不可用（冷却/已尝试）时整条目让位——与单 key 语义一致。
        for (const keyRoute of primaryOnly === true ? [entry.route] : [entry.route, ...entry.keys]) {
          if (record.attempted.has(entry.id + '@' + keyRoute)) continue
          if (cooling(keyRoute, now)) continue
          if (compatible(entry, record.needs) !== true) continue
          if ((await serviceable(entry, signal, keyRoute)) !== true) continue
          return { tier, entry, keyRoute }
        }
      }
    }
    return undefined
  }

  // ---------------------------------------------------------------- 钩子一
  // 每次尝试前决定本次实际使用的路由/模型/推理层级。
  ctx.on('llm/stream', (options, next) => {
    // 插件自身的排序请求不参与路由编排（集合判断，支持并发排序）。
    if (options?.signal !== undefined && state.rankingSignals.has(options.signal)) return next()
    // 记下会话身份（带时间戳）：排序等旁路调用需要把它带给适配器（会话作用域路由会校验）。
    if (options?.sessionId !== undefined) state.lastSessionId = { id: options.sessionId, at: Date.now() }
    // 记录本步的能力需求（工具/图片），供候选兼容性过滤使用。
    const needs = { tools: false, images: false }
    try {
      if (Array.isArray(options?.tools) && options.tools.length > 0) needs.tools = true
      const messages = Array.isArray(options?.messages) ? options.messages : []
      needs.images = messages.some((message) => Array.isArray(message?.content) && message.content.some((block) => block?.type === 'image'))
    } catch (error) {
      // 需求探测失败不应影响请求本身。
    }
    state.pendingNeeds = needs
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    if (config.enabled !== true || config.tiers.length === 0) return base
    const turn = payload?.turn ?? 0
    const step = payload?.step ?? 0
    const record = stepState(turn, step)
    // 需求在 llm/stream 里观测、在 request 里取用；同一 turn 内保持粘滞，避免第一步没有需求信息。
    if (state.pendingNeeds !== undefined) record.needs = state.pendingNeeds

    let target = record.target
    if (target === undefined && config.startup.preferTier > 0) {
      // 启动对齐（口径 B）：当前路由已属于目标档则不改写，否则对齐到该档排序最前的可用条目。
      const current = tierOf(config, base.provider)
      const wanted = config.tiers.find((tier) => tier.tier === config.startup.preferTier)
      if (wanted !== undefined && wanted.enabled === true && (current === undefined || current.tier !== wanted.tier)) {
        const picked = await pickCandidate(turn, step, base.provider + '/' + base.model + ' startup', payload?.signal, undefined, true)
        if (picked !== undefined) {
          // 启动对齐只落条目主路由（keys 仅参与失败路径）。
          target = { entry: picked.entry, tier: picked.tier, keyRoute: picked.entry.route, reason: 'startup-align' }
          record.target = target
          pushLog({ at: Date.now(), kind: 'startup-align', from: base.provider + '/' + base.model, to: picked.entry.route + '/' + picked.entry.model, tier: picked.tier.tier })
          console.warn('[dsh-provider-failover] startup-align ' + base.provider + '/' + base.model + ' -> ' + picked.entry.route + '/' + picked.entry.model + ' tier ' + String(picked.tier.tier) + ' (preferTier ' + String(config.startup.preferTier) + ')')
        }
      }
    }

    if (target === undefined) return base
    // keys 轮换：本次实际下发的路由是生效目标的 keyRoute（主路由或别名）。
    const switchedConfig = { ...base, provider: target.keyRoute ?? target.entry.route, model: target.entry.model }
    if (target.entry.reasoningEffort !== undefined) switchedConfig.reasoningEffort = target.entry.reasoningEffort
    return switchedConfig
  })

  // ---------------------------------------------------------------- 钩子二
  ctx.on('agent/request-error', async (payload, next) => {
    if (config.enabled !== true || config.tiers.length === 0) return next()
    const failure = payload?.failure
    const decision = isSwitchable(config, failure?.code, failure?.message)
    if (decision.hit !== true) return next()

    const turn = payload?.turn ?? 0
    const step = payload?.step ?? 0
    const record = stepState(turn, step)
    const failedRoute = typeof payload?.provider === 'string' ? payload.provider : ''

    const now = Date.now()
    if (now - state.lastSwitchAt < config.minSwitchIntervalMs) return next()
    if (record.switches >= config.maxSwitchesPerTurn) return next()

    // 失败路由（条目主路由或 keys 候选）进入冷却，且本步不再尝试它。
    const failedLoc = failedRoute.length > 0 ? locateRoute(config, failedRoute) : undefined
    const failedEntry = failedLoc?.entry
    if (failedEntry !== undefined) record.attempted.add(failedEntry.id + '@' + failedRoute)
    if (failedRoute.length > 0) {
      state.routeHealth.set(failedRoute, {
        coolingUntil: now + (failedEntry?.cooldownMs ?? 60000),
        code: typeof failure?.code === 'string' ? failure.code : '',
        message: String(failure?.message ?? '').slice(0, 200),
        at: now,
      })
    }

    const context = String(failure?.code ?? '') + ' ' + String(failure?.message ?? '') + (record.needs.tools ? ' tools' : '') + (record.needs.images ? ' images' : '')
        const picked = await pickCandidate(turn, step, context, payload?.signal, failedRoute)
    if (picked === undefined) return next()

    record.target = { entry: picked.entry, tier: picked.tier, keyRoute: picked.keyRoute, reason: decision.how }
    record.switches += 1
    state.lastSwitchAt = now
    pushLog({
      at: now,
      kind: 'failover',
      from: failedRoute,
      to: picked.keyRoute + '/' + picked.entry.model,
      ...(picked.keyRoute !== picked.entry.route ? { key: picked.keyRoute } : {}),
      tier: picked.tier.tier,
      code: typeof failure?.code === 'string' ? failure.code : '',
      trigger: decision.how,
      turn,
      step,
    })
    console.warn('[dsh-provider-failover] switch ' + (failedRoute.length > 0 ? failedRoute : '(unknown)') + ' -> ' + picked.keyRoute + '/' + picked.entry.model + ' tier ' + String(picked.tier.tier) + (picked.keyRoute !== picked.entry.route ? ' key ' + picked.keyRoute : '') + ' (' + decision.how + ', turn ' + String(turn) + ' step ' + String(step) + ')')
    return { kind: 'retry' }
  })

  // ------------------------------------------------------------ 设置项与状态接口
  // 设置命名空间 `provider-failover`：用户层落在 `$DSH_HOME/settings.yaml`，
  // base 层来自 profile patch 的条目配置（没被用户覆盖的项仍以 patch 为准），
  // 默认 effect=live → 变更即时生效，无需重启。
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, FailoverSettingsSchema, {
      base: {
        enabled: config.enabled,
        minSwitchIntervalMs: config.minSwitchIntervalMs,
        maxSwitchesPerTurn: config.maxSwitchesPerTurn,
        startupPreferTier: config.startup.preferTier,
        rankingMode: config.ranking.mode,
      },
    })
    const sync = (value, source) => {
      config.enabled = value.enabled === true
      config.minSwitchIntervalMs = value.minSwitchIntervalMs
      config.maxSwitchesPerTurn = value.maxSwitchesPerTurn
      config.startup.preferTier = value.startupPreferTier
      config.ranking.mode = value.rankingMode
      console.log('[dsh-provider-failover] settings ' + source + ': enabled=' + String(config.enabled) + ' minSwitchIntervalMs=' + String(config.minSwitchIntervalMs) + ' maxSwitchesPerTurn=' + String(config.maxSwitchesPerTurn) + ' startup.preferTier=' + String(config.startup.preferTier) + ' ranking=' + config.ranking.mode)
    }
    state.settings = scope
    state.syncSettings = sync
    sync(scope.get(), 'loaded')
    scope.watch((next) => { sync(next, 'updated') })
  })

  ctx.inject(['webServer'], (webCtx) => {
    const register = (path, handler) => ctx.effect(() => webCtx.webServer.register({ kind: 'exact', path: path, handler: handler }), 'dsh-provider-failover: ' + path)
    /** 宿主 provider 目录（实时读取，不固化）：已注册路由 + 可配置路由。 */
    const providerDirectory = () => {
      const service = llm()
      const registered = []
      const configurable = []
      if (service !== undefined) {
        try {
          if (typeof service.listProviders === 'function') {
            for (const info of service.listProviders()) registered.push({ id: String(info.id), name: String(info.name ?? info.id) })
          }
        } catch (error) {
          console.warn('[dsh-provider-failover] listProviders failed: ' + messageOf(error))
        }
        try {
          if (typeof service.listConfigurableProviders === 'function') {
            for (const info of service.listConfigurableProviders()) configurable.push({ provider: String(info.provider), displayName: String(info.displayName ?? info.provider), settingsNs: String(info.settingsNs ?? '') })
          }
        } catch (error) {
          console.warn('[dsh-provider-failover] listConfigurableProviders failed: ' + messageOf(error))
        }
      }
      return { registered, configurable }
    }
    const snapshot = () => {
      const directory = providerDirectory()
      // 目录不可用（llm 未就绪或宿主未报告任何 provider）时不做关联判断，避免全量误标。
      const directoryKnown = directory.registered.length > 0 || directory.configurable.length > 0
      const registeredIds = new Set(directory.registered.map((item) => item.id))
      const assigned = new Set()
      const now = Date.now()
      const tiers = config.tiers.map((tier) => ({
        tier: tier.tier,
        enabled: tier.enabled,
        entries: tier.entries.map((entry) => {
          assigned.add(entry.route)
          for (const keyRoute of entry.keys) assigned.add(keyRoute)
          return {
            id: entry.id,
            route: entry.route,
            model: entry.model,
            keys: entry.keys.map((keyRoute) => ({
              route: keyRoute,
              registered: directoryKnown ? registeredIds.has(keyRoute) : true,
              cooling: cooling(keyRoute, now),
            })),
            registered: directoryKnown ? registeredIds.has(entry.route) : true,
            cooling: cooling(entry.route, now),
          }
        }),
      }))
      return {
        ok: true,
        enabled: config.enabled,
        editable: {
          enabled: config.enabled,
          minSwitchIntervalMs: config.minSwitchIntervalMs,
          maxSwitchesPerTurn: config.maxSwitchesPerTurn,
          startupPreferTier: config.startup.preferTier,
          rankingMode: config.ranking.mode,
        },
        writable: state.settings !== undefined,
        tiers,
        providers: directoryKnown ? {
          registered: directory.registered,
          configurable: directory.configurable,
          unassigned: directory.registered.filter((item) => assigned.has(item.id) !== true),
          missing: [...assigned].filter((route) => registeredIds.has(route) !== true),
        } : null,
        switches: state.switchLog.slice(-LOG_LIMIT),
        cooling: [...state.routeHealth.entries()].map(([route, health]) => ({ route: route, code: health.code, until: health.coolingUntil })),
      }
    }
    register(ROUTE_BASE + '/status', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      sendJson(res, 200, snapshot())
    })
    register(ROUTE_BASE + '/config', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      if (state.settings === undefined) return sendJson(res, 503, { ok: false, error: 'settings service is not composed; edit the profile patch instead' })
      const body = await readJsonBody(req)
      const patch = {}
      for (const key of ['enabled', 'minSwitchIntervalMs', 'maxSwitchesPerTurn', 'startupPreferTier', 'rankingMode']) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
      }
      if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, error: 'no editable field in request' })
      try {
        await state.settings.update(patch)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: messageOf(error) })
      }
      // watch 回调是异步投递的；这里立即按 patch 预演一次，保证响应里的 editable 已是新值（M1）。
      if (typeof state.syncSettings === 'function') {
        state.syncSettings({
          enabled: config.enabled,
          minSwitchIntervalMs: config.minSwitchIntervalMs,
          maxSwitchesPerTurn: config.maxSwitchesPerTurn,
          startupPreferTier: config.startup.preferTier,
          rankingMode: config.ranking.mode,
          ...patch,
        }, 'updated')
      }
      sendJson(res, 200, snapshot())
    })
  })

  const configured = config.tiers.map((tier) => String(tier.tier) + (tier.enabled ? '' : '(off)') + ':' + tier.entries.map((entry) => entry.id).join(',')).join(' | ')
  console.log('[dsh-provider-failover] ready: ' + configured + ' | startup.preferTier=' + String(config.startup.preferTier) + ' | ranking=' + config.ranking.mode)
}

/** 供诊断/测试使用：暴露默认配置的深拷贝。 */
export function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

/** 供诊断/测试使用：暴露配置归一化。 */
export function normalize(raw) {
  const { value, errors } = normalizeConfig(raw)
  return { value: JSON.parse(JSON.stringify({ ...value, terminalCodes: [...value.terminalCodes], failurePatterns: value.failurePatterns })), errors }
}

export { masked }

/** 内部纯函数，供冒烟测试断言（不属于对外契约）。 */
export const __test = { parseRanking, hashKey, sanitizeForRanking, isSwitchable, tierOf, orderEntries }
