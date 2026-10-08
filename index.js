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
 *  4. 单路由多 key：条目的 `keys` 是**同一路由的凭据引用名**列表；凭据类失败时改写该
 *     路由的 `apiKeyEnv` 引用（只写引用名），下一次尝试由适配器按新引用解析凭据。
 *     路由名与模型名不变，因此模型选择列表里不会多出任何路由。实证：适配器每请求
 *     `resolveApiKey(provider, profile)` = `credentials.resolve(profile.apiKeyEnv)`，
 *     profile 按 settings 快照记忆化，故改写引用对下一个请求立即生效。
 *  5. 每日重置：`keyResetAt`（本地时间，默认 06:00）清空 key 失效标记并把仍属插件
 *     状态的条目写回首项（默认 key）；当前引用不在 `keys` 内时视为用户手工状态，不动。
 *
 * 约束（自 openspec 规范）：
 *   - 不持有、不存储、不读取任何凭据值；只读写引用名，凭据由适配器按 apiKeyEnv 解析。
 *   - 每 `(turn, step)` 每个条目至多尝试一次；单 turn 切换次数有上限；冷却期内不选中。
 *   - 未配置/未启用时零介入；无法解析目标时交回宿主，不做隐式降级。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-provider-failover'

export const inject = []

/** 设置页（settings.section）与状态接口共用的命名空间与路由前缀。 */
const SETTINGS_NAMESPACE = 'provider-failover'
const ROUTE_BASE = '/provider-failover'
const LOG_LIMIT = 10

/**
 * 设置页可编辑项（总开关 + 常用参数）的取值契约：
 * 用户层的值落在插件自有文件 `$DSH_HOME/plugins/provider-failover/settings.json`
 * （0.2 起 dsh-settings 不再提供按插件命名空间 store，见 createFileSettingsScope），
 * 键集为 `enabled / minSwitchIntervalMs / maxSwitchesPerTurn / startupPreferTier /
 * rankingMode / keyResetAt / keysByEntry`；生效时机为写入后即时同步，无需重启。
 * 字段合法性由 /config 端点与 normalize 校验，不再维护独立的 schema 定义。
 */

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

/**
 * 「可切换失败」里属于**凭据类**的编码：命中时先尝试条目内 key 轮换（改 apiKeyEnv 引用），
 * 其余（SERVER/RATE_LIMIT/NO_ADAPTER）走 provider 切换——换 key 治不了过载与路由缺失。
 * 消息模式兜底命中的失败一律按非凭据类处理：不因一句话就消耗一把 key。
 */
const KEY_ROTATION_CODES = new Set(['QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])

/** 凭据引用名的形状（宿主凭据服务的 POSIX 标识符约定）。 */
const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `keyResetAt` 的形状：24 小时制本地时间。 */
const KEY_RESET_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 宿主 pi-ai 适配器的设置命名空间：路由 profile（含 apiKeyEnv）在这里。 */
const PI_AI_NAMESPACE = 'llm-pi-ai'

/** 引用描述（是否已配置 / 来源层）的缓存时长，避免每次状态查询都打凭据服务。 */
const REF_INFO_TTL_MS = 10000

/** 会话级测试切换（pin）的有效期：到期自动解除，避免把路由长期钉住。 */
const TEST_PIN_TTL_MS = 30 * 60 * 1000

/**
 * 测试切换的目标解析（纯函数）。
 *   spec = ''          → 当前条目之后的下一启用条目（末尾回环）
 *   spec = 'tier:N'    → 第 N 档首个启用条目
 *   spec = '<entryId>' → 该条目
 * 只考虑启用档位与启用条目；无法解析返回 undefined。
 */
function resolveTestTarget(tiers, spec, currentProvider) {
  const flat = []
  for (const tier of tiers) {
    if (tier.enabled !== true) continue
    for (const entry of tier.entries) {
      if (entry.enabled !== true) continue
      flat.push({ tier, entry })
    }
  }
  if (flat.length === 0) return undefined
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text.length === 0) {
    const at = flat.findIndex((item) => item.entry.route === currentProvider)
    return flat[(at + 1) % flat.length]
  }
  const tierMatch = /^tier:(\d+)$/.exec(text)
  if (tierMatch !== null) {
    const wanted = Number(tierMatch[1])
    return flat.find((item) => item.tier.tier === wanted)
  }
  return flat.find((item) => item.entry.id === text)
}

/** 编码未归一化时的消息模式兜底（大小写不敏感）。 */
const DEFAULT_FAILURE_PATTERNS = [
  'insufficient balance',
  'insufficient_quota',
  'quota exceeded',
  // Codex OAuth may surface an exhausted subscription as generic PI_AI_ERROR:
  // "The usage limit has been reached" or a snake-case usage_limit_reached code.
  'usage limit',
  'usage_limit',
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
      { id: 'example', route: 'example-provider', model: 'example-model', description: '示例条目：替换为你自己的首选路由与模型', keywords: [], compatible: { tools: true, images: true }, cooldownMs: 60000, keys: [] },
    ],
  },
]

/** 排序请求的输出预算：推理型模型会把较多 token 花在推理上，预算过小会导致可见输出为空。 */
const RANKING_MAX_TOKENS = 512

/** 全量测试：每个目标发送的最小探测请求参数与默认超时。 */
const PROBE_TIMEOUT_MS = 20000
const PROBE_MAX_TOKENS = 32
const PROBE_PROMPT = 'Reply with the single word: ok'

const DEFAULT_CONFIG = {
  enabled: true,
  policyFailover: true,
  terminalCodes: DEFAULT_TERMINAL_CODES,
  failurePatterns: DEFAULT_FAILURE_PATTERNS,
  minSwitchIntervalMs: 1000,
  maxSwitchesPerTurn: 6,
  probeTarget: true,
  // key 状态每日重置时刻（本地时间）：清空失效标记并把默认 key 写回。
  keyResetAt: '06:00',
  // 启动对齐档位：默认 0（关闭）——新会话保持宿主默认/最近一次选择，不自动拉回第一档；
  // 需要“启动时优先某档”时在 profile patch 里显式设为 >=1。
  startup: { preferTier: 0 },
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

/** 插件自有设置文件：`$DSH_HOME/plugins/<namespace>/settings.json`。 */
function settingsFilePath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'plugins', SETTINGS_NAMESPACE, 'settings.json')
}

/** 读取设置用户层（容错：缺失/损坏一律回退空对象）。 */
function readSettingsOverrides(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 插件自有设置 scope（get/update/watch）。
 *
 * 0.2 移除了 `@deepseek-ai/dsh-settings` 的按插件命名空间 store
 * （`ctx.settings.register`），故用户层改为插件自有 JSON 文件；`base` 仍是
 * profile patch 派生的配置，语义与旧的 settings scope 一致（base 打底、用户层覆盖、
 * 变更实时通知）。
 */
function createFileSettingsScope({ file, base }) {
  const listeners = new Set()
  const notify = (value) => {
    for (const listener of listeners) {
      try {
        listener(value)
      } catch (error) {
        console.warn('[dsh-provider-failover] settings listener failed: ' + messageOf(error))
      }
    }
  }
  return {
    get() {
      return { ...base, ...readSettingsOverrides(file) }
    },
    async update(patch) {
      const next = { ...readSettingsOverrides(file), ...patch }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
      notify({ ...base, ...next })
    },
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 凭据引用名（POSIX 标识符）：`keys` 的每个元素都是它，而不是路由名，更不是密钥值。 */
function isCredentialRef(value) {
  return typeof value === 'string' && KEY_REF_PATTERN.test(value)
}

/**
 * 条目 `reasoningEffort` 与模型目录声明的一致性检查（纯函数）。
 * 口径与宿主 `dsh-llm` 一致：模型未暴露 reasoning 时**任何**层级都不支持；暴露时层级必须
 * 出现在 `reasoning.efforts` 中。返回「不支持」的原因文本；一致或条目未声明层级时返回 undefined。
 */
function unsupportedReasoningEffort(entry, info) {
  const requested = isPlainObject(entry) ? entry.reasoningEffort : undefined
  if (requested === undefined) return undefined
  const reasoning = isPlainObject(info) ? info.reasoning : undefined
  if (isPlainObject(reasoning) !== true) return 'but the model exposes no reasoning levels'
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  if (efforts.some((effort) => isPlainObject(effort) && effort.id === requested)) return undefined
  const exposed = efforts.map((effort) => String(isPlainObject(effort) ? effort.id : effort)).filter((id) => id.length > 0)
  return 'but the model exposes: ' + (exposed.length > 0 ? exposed.join(', ') : '(none)')
}

/** 条目内 key 轮换序列的纯函数：从 `active` 之后环形前进，返回第一个 `isUsable` 的引用。 */
function selectNextRef(keys, active, isUsable) {
  if (Array.isArray(keys) !== true || keys.length === 0) return undefined
  const start = active === undefined ? -1 : keys.indexOf(active)
  for (let offset = 1; offset <= keys.length; offset++) {
    const candidate = keys[(start + offset) % keys.length]
    if (candidate === active) continue
    if (isUsable(candidate) === true) return candidate
  }
  return undefined
}

/** 从 `HH:MM` 解析出 { hours, minutes }；非法返回 undefined。 */
function parseClock(text) {
  if (typeof text !== 'string' || KEY_RESET_AT_PATTERN.test(text) !== true) return undefined
  const [hours, minutes] = text.split(':').map((part) => Number(part))
  return { hours, minutes }
}

/** 下一个 `HH:MM`（本地时间）的毫秒时间戳；`now` 已过当日时刻时取次日。 */
function nextResetAt(text, now) {
  const clock = parseClock(text)
  if (clock === undefined) return now + 24 * 60 * 60 * 1000
  const next = new Date(now)
  next.setHours(clock.hours, clock.minutes, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
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
    policyFailover: input.policyFailover === undefined ? DEFAULT_CONFIG.policyFailover : input.policyFailover === true,
    terminalCodes: new Set((strings(input.terminalCodes).length > 0 ? strings(input.terminalCodes) : DEFAULT_TERMINAL_CODES).map((code) => code.toUpperCase())),
    failurePatterns: (strings(input.failurePatterns).length > 0 ? strings(input.failurePatterns) : DEFAULT_FAILURE_PATTERNS).map((pattern) => pattern.toLowerCase()),
    minSwitchIntervalMs: input.minSwitchIntervalMs === undefined ? DEFAULT_CONFIG.minSwitchIntervalMs : input.minSwitchIntervalMs,
    maxSwitchesPerTurn: input.maxSwitchesPerTurn === undefined ? DEFAULT_CONFIG.maxSwitchesPerTurn : input.maxSwitchesPerTurn,
    probeTarget: input.probeTarget === undefined ? DEFAULT_CONFIG.probeTarget : input.probeTarget === true,
    keyResetAt: optionalString(input.keyResetAt) ?? DEFAULT_CONFIG.keyResetAt,
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
  if (parseClock(config.keyResetAt) === undefined) errors.push('keyResetAt must be HH:MM in 24-hour local time (e.g. 06:00)')

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
      // 条目内 key 轮换（opt-in）：keys[] 是**同一路由的凭据引用名**（有序，首项为默认 key）。
      // 未声明或声明为空数组时不参与轮换，行为与单 key 条目一致。
      const keys = []
      if (rawEntry.keys !== undefined && Array.isArray(rawEntry.keys) !== true) {
        errors.push('entry.keys must be an array of credential reference names (entry ' + String(id ?? '?') + ')')
      }
      if (Array.isArray(rawEntry.keys)) {
        const seenKey = new Set()
        for (const item of rawEntry.keys) {
          if (isCredentialRef(item) !== true) {
            errors.push('entry.keys items must be credential reference names (POSIX identifiers such as MY_KEY_2) (entry ' + String(id ?? '?') + ')')
            continue
          }
          if (seenKey.has(item)) {
            errors.push('duplicate credential reference in entry.keys: ' + item + ' (entry ' + String(id ?? '?') + ')')
            continue
          }
          seenKey.add(item)
          keys.push(item)
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
  // 每个引用只服务一个 provider：同一凭据引用名不得出现在多个条目（引用即该路由的凭据来源）。
  const refOwner = new Map()
  for (const tier of config.tiers) {
    for (const entry of tier.entries) {
      for (const ref of entry.keys) {
        const owner = refOwner.get(ref)
        if (owner !== undefined) {
          errors.push('credential reference "' + ref + '" is used by both entry ' + owner + ' and entry ' + entry.id + '; each reference serves a single provider')
        } else {
          refOwner.set(ref, entry.id)
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

/**
 * 该失败是否属于「可切换」，并给设置页一个明确的“不切换原因”。
 * 内容/安全策略拒绝必须先于通用 INVALID_REQUEST 判断：它不是请求参数问题。
 * 默认 `policyFailover: true` 时按受限策略进入下一条已配置 Provider（不轮换 key，
 * 仍受候选预检/冷却/单 turn 切换上限/最小间隔约束）；设为 false 才终止本轮并提示修改提示词。
 */
function isSwitchable(config, code, message) {
  const normalized = typeof code === 'string' ? code.toUpperCase() : ''
  const haystack = (String(message ?? '') + ' ' + normalized).toLowerCase()
  const policyCodes = new Set(['CONTENT_POLICY_VIOLATION', 'MODERATION_BLOCKED', 'PROMPT_BLOCKED', 'SAFETY'])
  const policyPatterns = ['usage policy', 'content policy', 'safety policy', 'potentially violating', 'prompt was flagged']
  if (policyCodes.has(normalized) || policyPatterns.some((pattern) => haystack.includes(pattern))) {
    if (config.policyFailover !== false) return { hit: true, how: 'policy:prompt', category: 'switchable', policy: true }
    return {
      hit: false,
      category: 'policy',
      reason: '提示词被上游内容/安全策略拒绝；不会轮换密钥或切换 Provider，请修改提示词后重试。',
    }
  }
  if (normalized === 'CONTEXT_WINDOW_EXCEEDED') {
    return { hit: false, category: 'context', reason: '上下文窗口超限；切换密钥无效，请缩短上下文或先压缩。' }
  }
  if (normalized === 'INVALID_REQUEST') {
    return { hit: false, category: 'invalid-request', reason: '请求参数无效；切换密钥无效，请修正请求配置。' }
  }
  if (normalized === 'UNSUPPORTED_REASONING_EFFORT') {
    return { hit: false, category: 'configuration', reason: '模型不支持当前推理档位；请关闭推理档位或选择兼容模型。' }
  }
  if (config.terminalCodes.has(normalized)) return { hit: true, how: 'code:' + normalized, category: 'switchable' }
  for (const pattern of config.failurePatterns) {
    if (haystack.indexOf(pattern) >= 0) return { hit: true, how: 'pattern:' + pattern, category: 'switchable' }
  }
  return { hit: false, category: 'other', reason: '该错误不属于额度、凭据、过载或限流故障；保持当前模型。' }
}

/** 全量测试的状态标签：失败编码 → 中文状态（供设置页/指令展示）。 */
const PROBE_STATUS_LABELS = {
  QUOTA: '额度不足',
  AUTH: '凭据无效',
  INVALID_CREDENTIAL: '凭据无效',
  MISSING_CREDENTIAL: '凭据缺失',
  NO_ADAPTER: '路由未注册/无适配器',
  RATE_LIMIT: '限流',
  SERVER: '服务端/网络异常',
  CONTEXT_WINDOW_EXCEEDED: '上下文超限',
  INVALID_REQUEST: '请求无效',
  UNSUPPORTED_REASONING_EFFORT: '推理档位不支持',
}

/**
 * 把一次探测失败的编码/消息归类成可展示状态（纯函数）。
 * 归一化编码优先；未归一化时按消息（超时/中断关键词）兜底。
 */
function classifyProbeFailure(code, message) {
  const normalized = typeof code === 'string' ? code.toUpperCase() : ''
  const haystack = (String(message ?? '') + ' ' + normalized).toLowerCase()
  const detail = String(message ?? '').slice(0, 200)
  if (haystack.includes('timeout') || haystack.includes('timed out') || haystack.includes('aborted')) {
    return { status: 'TIMEOUT', label: '超时/无响应', message: detail.length > 0 ? detail : 'no response in time' }
  }
  const label = PROBE_STATUS_LABELS[normalized]
  if (label !== undefined) return { status: normalized, label, message: detail }
  return { status: normalized.length > 0 ? normalized : 'UNKNOWN', label: '未知错误', message: detail.length > 0 ? detail : 'no failure message' }
}

function tierOf(config, route) {
  for (const tier of config.tiers) {
    for (const entry of tier.entries) if (entry.route === route) return tier
  }
  return undefined
}

/** 失败归属：返回路由所在的 {tier, entry}。key 轮换不改路由，因此只按路由匹配。 */
function locateRoute(config, route) {
  for (const tier of config.tiers) {
    for (const entry of tier.entries) {
      if (entry.route === route) return { tier, entry }
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
    /** 最近未切换决策（策略拒绝、参数错误等；上限 50） */
    ignoredLog: [],
    /** stepKey -> { attempted:Set<'entryId@route#ref'>, target, switches, needs, at } */
    steps: new Map(),
    /** key 候选的预检警告去重（每引用每进程一次，避免刷屏） */
    keyWarned: new Set(),
    /**
     * 当日失效的凭据引用：ref -> { gen, code, route, at }。
     * `gen` 与 `keyGeneration` 相等才算「本次重置周期内失效」——每日重置只是把代数 +1，
     * 无需遍历清理，也不依赖时钟比较。
     */
    keyFailed: new Map(),
    keyGeneration: 0,
    /** 设置层覆盖的 key 引用列表（条目 id → 引用名[]）；空对象时全部回退 patch */
    keysByEntry: {},
    /** 配置类警告去重（每消息每进程一次） */
    configWarned: new Set(),
    /** 每日重置排程是否已启用（界面新增 keys 后可补启用） */
    keyResetArmed: false,
    /** 会话级测试切换 pin：sessionId -> { entryId, route, model, reasoningEffort, tier, at } */
    pins: new Map(),
    /** 引用描述缓存：ref -> { configured, source, at }（短 TTL，仅用于状态展示） */
    refInfo: new Map(),
    /**
     * 每会话的最近切换时刻（最小切换间隔护栏按会话计，避免一个会话压制另一个）。
     * sessionId -> 毫秒时间戳。
     */
    lastSwitchAt: new Map(),
    /**
     * 每会话最近一次观测到的能力需求（工具/图片），在 llm/stream 写入、下一次
     * agent/request 取用，作为该会话步骤的需求粘滞。sessionId -> { needs, at }。
     */
    pendingNeeds: new Map(),
    /** 排序结果缓存：hash -> { ids, at } */
    rankingCache: new Map(),
    /** 进行中的排序请求 signal 集合（钩子据此豁免自身调用；支持并发） */
    rankingSignals: new Set(),
    /** 进行中的全量测试请求 signal 集合（同样豁免插件钩子，避免污染 pendingNeeds） */
    probeSignals: new Set(),
    /** 一次全量测试进行中：避免并发重入 */
    probeRunning: false,
    /** 最近一次全量测试报告（内存态，供 /status 与设置页回显） */
    lastProbe: undefined,
    /** 最近一次会话身份 { id, at }，供旁路排序调用使用（短 TTL） */
    lastSessionId: undefined,
    /** 已完成“启动对齐”判定的 live Agent；只判定一次，避免覆盖会话内显式选模。 */
    startupHandled: new WeakSet(),
    /** settings scope（settings 服务未组合时为 undefined） */
    settings: undefined,
    /** settings 同步函数，/config 路由保存后用它立即预演，避免响应竞态 */
    syncSettings: undefined,
  }

  // 步骤记账按会话隔离：同一 (turn, step) 在两个会话里是两条独立记录，
  // 避免并行标签页/子代理共享切换目标、尝试次数与能力需求。
  const stepKeyOf = (sessionId, turn, step) => String(sessionId ?? '-') + '/' + String(turn) + '/' + String(step)
  const sessionKeyOf = (sessionId) => sessionId === undefined || sessionId === null ? '-' : String(sessionId)

  // ------------------------------------------------------- 单路由多 key（凭据引用轮换）

  const settingsService = () => ctx.get('settings') ?? undefined
  const credentialsService = () => ctx.get('credentials') ?? undefined

  /** 实时读取某路由当前的凭据引用名（不缓存：用户手工改 settings 立即被采纳）。 */
  function activeRefOf(route) {
    const service = settingsService()
    if (service === undefined || typeof service.describe !== 'function') return undefined
    let section
    try {
      // 0.2 的 SettingsForms 没有按命名空间的 get()；活动表单经 describe() 读取，
      // 只有声明了 volatile 字段的条目（llm-pi-ai 的 providers 即是）才会出现。
      section = service.describe().find((row) => row.ns === PI_AI_NAMESPACE)?.value
    } catch (error) {
      return undefined
    }
    if (section === null || typeof section !== 'object') return undefined
    const profile = section.providers !== undefined && section.providers !== null ? section.providers[route] : undefined
    if (profile === null || typeof profile !== 'object') return undefined
    const ref = profile.apiKeyEnv
    return typeof ref === 'string' && ref.length > 0 ? ref : undefined
  }

  /** 引用是否已配置（凭据描述）。服务缺失或描述失败一律按「未配置」处理——失败闭合。 */
  async function refConfigured(ref) {
    const service = credentialsService()
    if (service === undefined || typeof service.describe !== 'function') {
      state.refInfo.set(ref, { configured: false, source: undefined, at: Date.now() })
      return { configured: false, source: undefined }
    }
    try {
      const info = await service.describe(ref)
      const record = { configured: info?.configured === true, source: typeof info?.source === 'string' ? info.source : undefined, at: Date.now() }
      state.refInfo.set(ref, record)
      return record
    } catch (error) {
      state.refInfo.set(ref, { configured: false, source: undefined, at: Date.now() })
      return { configured: false, source: undefined }
    }
  }

  /** 只改写引用名；永不触碰凭据值。 */
  async function writeActiveRef(route, ref) {
    const service = settingsService()
    if (service === undefined || typeof service.mutate !== 'function') throw new Error('settings service is not composed')
    await service.mutate(PI_AI_NAMESPACE, [{ op: 'set', path: ['providers', route, 'apiKeyEnv'], value: ref }])
  }

  /** 每次尝试的记账键：同一条路由在不同凭据引用下算不同的尝试。 */
  function attemptKey(entryId, route, ref) {
    return entryId + '@' + route + '#' + String(ref ?? '')
  }

  function refFailed(ref) {
    const mark = state.keyFailed.get(ref)
    return mark !== undefined && mark.gen === state.keyGeneration
  }

  /** 配置类警告去重（每消息每进程一次，避免刷屏）。 */
  function warnConfigOnce(message) {
    if (state.configWarned.has(message)) return
    state.configWarned.add(message)
    console.warn('[dsh-provider-failover] ' + message)
  }

  /**
   * 条目生效的 key 引用列表：设置层 `keysByEntry[id]` 优先，否则回退 profile patch 的 `keys`。
   * 运行时防御性过滤（不信任落盘内容）：非法名与重复项被丢弃并警告一次，绝不因此中断请求。
   */
  function effectiveKeys(entry) {
    const override = state.keysByEntry[entry.id]
    const source = Array.isArray(override) ? override : entry.keys
    const refs = []
    const seen = new Set()
    for (const item of source) {
      if (isCredentialRef(item) !== true) {
        warnConfigOnce('keysByEntry.' + entry.id + ': ignoring invalid credential reference name ' + JSON.stringify(item))
        continue
      }
      if (seen.has(item)) {
        warnConfigOnce('keysByEntry.' + entry.id + ': ignoring duplicate credential reference ' + item)
        continue
      }
      seen.add(item)
      refs.push(item)
    }
    return refs
  }

  /** 该条目是否有可轮换的 key 引用（决定是否需要每日重置排程）。 */
  function hasRotation(entry) {
    return effectiveKeys(entry).length > 0
  }

  // ------------------------------------------------------- 会话级测试切换（pin）

  const sessionController = () => ctx.get('sessionController') ?? undefined

  /** agent 的会话 id（原样返回，供官方接口使用）。 */
  function sessionIdOf(agent) {
    const session = agent !== null && agent !== undefined ? agent.session : undefined
    const id = session !== null && session !== undefined ? session.id : undefined
    return id === undefined || id === null ? undefined : id
  }

  const pinKeyOf = (sessionId) => sessionId === undefined || sessionId === null ? undefined : String(sessionId)

  /** 有效 pin：过期即删并返回 undefined。 */
  function activePin(sessionId) {
    const key = pinKeyOf(sessionId)
    if (key === undefined) return undefined
    const pin = state.pins.get(key)
    if (pin === undefined) return undefined
    if (Date.now() - pin.at >= TEST_PIN_TTL_MS) {
      state.pins.delete(key)
      return undefined
    }
    return pin
  }

  /**
   * 执行一次测试切换：走官方会话模型选择通路（`sessionController.selectModel`，与模型选择器同路），
   * 并在插件侧记 pin，使后续请求不被启动对齐顶回。不伪造失败、不改档位表与凭据。
   */
  async function applyTestSwitch(sessionId, target, reason) {
    const controller = sessionController()
    if (controller === undefined || typeof controller.selectModel !== 'function') {
      throw new Error('session controller is not composed; cannot switch the session model')
    }
    const entry = target.entry
    const effort = await usableEffort(entry)
    const request = { sessionId, provider: entry.route, model: entry.model }
    if (effort !== undefined) request.reasoningEffort = effort
    const result = await controller.selectModel(request)
    const selected = result !== null && typeof result === 'object' && result.selected !== undefined ? result.selected : {}
    const pin = {
      entryId: entry.id,
      route: String(selected.provider ?? entry.route),
      model: String(selected.model ?? entry.model),
      reasoningEffort: selected.reasoningEffort ?? effort,
      tier: target.tier.tier,
      at: Date.now(),
    }
    state.pins.set(pinKeyOf(sessionId), pin)
    pushLog({ at: pin.at, kind: 'test-switch', from: '(session selection)', to: pin.route + '/' + pin.model, tier: pin.tier, code: 'TEST', trigger: reason, turn: 0, step: 0 })
    console.warn('[dsh-provider-failover] test switch session ' + String(pinKeyOf(sessionId)) + ' -> ' + pin.route + '/' + pin.model + ' tier ' + String(pin.tier) + ' (' + reason + ')')
    return pin
  }

  /** 启用档位下的启用条目（「打开状态」的 provider+model），保留 tier/entry 引用。 */
  function enabledTargets() {
    const list = []
    for (const tier of config.tiers) {
      if (tier.enabled !== true) continue
      for (const entry of tier.entries) {
        if (entry.enabled !== true) continue
        list.push({ tier, entry })
      }
    }
    return list
  }

  /** 可用测试目标清单（供界面下拉与指令报错提示）。 */
  function testTargets() {
    return enabledTargets().map((item) => ({ id: item.entry.id, route: item.entry.route, model: item.entry.model, tier: item.tier.tier }))
  }

  /**
   * 探测用的会话身份。会话作用域路由（如 opencode-go）要求 `x-opencode-session`
   * 才会被有效路由，缺失即 400 `MissingSessionID`；而 pi-ai 只在 options.sessionId 存在时
   * 才补该标头（pi-ai/dist/providers/opencode-headers.js）。因此优先级：
   * 显式传入 > 最近 1 小时内的活跃会话 > 新生成随机 id（保证标头始终存在）。
   */
  function probeSessionId(explicit) {
    const wanted = optionalString(explicit)
    if (wanted !== undefined) return wanted
    const session = state.lastSessionId
    if (session !== undefined && Date.now() - session.at < 3600000) return String(session.id)
    return randomUUID()
  }

  /**
   * 全量测试单个目标：发送一条最小真实请求并读回首个可见文本；
   * 返回统一结构 { id, route, model, reasoningEffort?, tier?, ok, status, label, ms, reply?, message? }。
   * 不复用 agent 循环，直连 `ctx.llm.stream`；用专用 signal 让本插件钩子跳过它。
   * 条目声明的推理层级若确认不被模型支持，直接判为配置问题（不消耗额度）。
   */
  async function probeOne(entry, timeoutMs, sessionId, signal) {
    const base = { id: entry.id, route: entry.route, model: entry.model, reasoningEffort: entry.reasoningEffort, checkedAt: Date.now() }
    const service = llm()
    if (service === undefined || typeof service.stream !== 'function') {
      return { ...base, ok: false, ms: 0, status: 'NO_LLM', label: 'LLM 服务不可用', message: 'llm service is not composed' }
    }
    if (entry.reasoningEffort !== undefined && typeof service.resolveModelInfo === 'function') {
      try {
        const info = await service.resolveModelInfo(entry.route, entry.model, signal)
        const unsupported = unsupportedReasoningEffort(entry, info)
        if (unsupported !== undefined) {
          return { ...base, ok: false, ms: 0, status: 'UNSUPPORTED_REASONING_EFFORT', label: '推理档位不支持', message: 'reasoningEffort "' + String(entry.reasoningEffort) + '" ' + unsupported }
        }
      } catch (error) {
        // 解析服务不可用不阻断真实探测，交给请求本身判定。
      }
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    const timer = setTimeout(() => controller.abort(new Error('probe timeout')), timeoutMs)
    if (signal !== undefined) signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    let text = ''
    let blockText = ''
    let streamFailure
    let thrown
    try {
      state.probeSignals.add(controller.signal)
      const request = { provider: entry.route, model: entry.model, messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }], maxTokens: PROBE_MAX_TOKENS, signal: controller.signal }
      if (entry.reasoningEffort !== undefined) request.reasoningEffort = entry.reasoningEffort
      // 会话身份始终带上：会话作用域路由（opencode-go）靠它生成 x-opencode-session，
      // 缺失会被网关以 400 MissingSessionID 拒绝。
      if (sessionId !== undefined && sessionId !== null && String(sessionId).length > 0) request.sessionId = String(sessionId)
      const stream = service.stream(request)
      for await (const chunk of stream) {
        if (chunk === null || chunk === undefined) continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') blockText += chunk.block.text
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          streamFailure = chunk.reason.failure ?? { message: 'stream ' + String(chunk.reason.kind) }
        }
      }
      if (text.length === 0) text = blockText
    } catch (error) {
      thrown = error
    } finally {
      clearTimeout(timer)
      state.probeSignals.delete(controller.signal)
    }
    const ms = Date.now() - startedAt
    if (controller.signal.aborted) {
      return { ...base, ok: false, ms, status: 'TIMEOUT', label: '超时/无响应', message: '超过 ' + String(timeoutMs) + 'ms 未完成' }
    }
    if (streamFailure !== undefined) {
      const cls = classifyProbeFailure(streamFailure.code, streamFailure.message)
      return { ...base, ok: false, ms, status: cls.status, label: cls.label, message: cls.message }
    }
    if (thrown !== undefined) {
      const cls = classifyProbeFailure(thrown.code, messageOf(thrown))
      return { ...base, ok: false, ms, status: cls.status, label: cls.label, message: cls.message }
    }
    const reply = String(text).trim().slice(0, 120)
    return { ...base, ok: true, ms, status: 'OK', label: '正常', reply: reply.length > 0 ? reply : '(空回复)', message: '' }
  }

  /** 全量测试：顺序探测所有「打开状态」的目标，返回汇总报告并记入 state.lastProbe。 */
  async function probeAll(options) {
    const opts = isPlainObject(options) ? options : {}
    if (state.probeRunning === true) return { ok: false, error: 'a probe run is already in progress', results: [] }
    const wanted = optionalString(opts.entry)
    const targets = enabledTargets().filter((item) => wanted === undefined || item.entry.id === wanted)
    if (targets.length === 0) {
      return { ok: false, error: wanted === undefined ? 'no enabled entry to test (enable a tier/entry first)' : 'no enabled entry with id ' + wanted, results: [] }
    }
    const timeoutMs = positiveNumber(opts.timeoutMs) ? opts.timeoutMs : PROBE_TIMEOUT_MS
    const sessionId = probeSessionId(opts.sessionId)
    state.probeRunning = true
    const startedAt = Date.now()
    const results = []
    try {
      for (const item of targets) {
        const result = await probeOne(item.entry, timeoutMs, sessionId, opts.signal)
        result.tier = item.tier.tier
        results.push(result)
        console.warn('[dsh-provider-failover] probe ' + item.entry.id + ' ' + item.entry.route + '/' + item.entry.model + ' -> ' + result.status + ' (' + String(result.ms) + 'ms)')
      }
    } finally {
      state.probeRunning = false
    }
    const okCount = results.filter((item) => item.ok === true).length
    const report = { ok: true, at: Date.now(), elapsedMs: Date.now() - startedAt, timeoutMs, sessionId, results, summary: { total: results.length, ok: okCount, failed: results.length - okCount } }
    state.lastProbe = report
    return report
  }

  function warnRefOnce(ref, detail) {
    if (state.keyWarned.has(ref)) return
    state.keyWarned.add(ref)
    console.warn('[dsh-provider-failover] key reference skipped: ' + ref + ' — ' + detail)
  }

  /**
   * 条目内 key 轮换：把失败路由的 `apiKeyEnv` 改写为条目内下一把可用引用。
   * 环形前进（从当前引用之后开始，至多一圈）：跳过本周期已失效者与未配置者。
   * 返回生效的引用名；无可用候选或写入失败时返回 undefined（调用方落到 provider 切换）。
   */
  async function rotateKey(entry, route, failedRef, code, now, message) {
    const keys = effectiveKeys(entry)
    if (keys.length === 0) return undefined
    const active = failedRef ?? activeRefOf(route)
    if (active !== undefined) state.keyFailed.set(active, { gen: state.keyGeneration, code, route, at: now, message: String(message ?? '').slice(0, 200) })
    // 环形前进至多一圈：跳过本周期已失效者，逐个用凭据描述预检，第一个已配置的即为目标。
    let remaining = keys.length
    let cursor = active
    while (remaining > 0) {
      const candidate = selectNextRef(keys, cursor, (ref) => refFailed(ref) !== true)
      if (candidate === undefined) break
      remaining -= 1
      cursor = candidate
      const info = await refConfigured(candidate)
      if (info.configured !== true) {
        warnRefOnce(candidate, 'not configured in the host credential store')
        continue
      }
      try {
        await writeActiveRef(route, candidate)
      } catch (error) {
        console.warn('[dsh-provider-failover] key rotate failed for ' + route + ' -> ' + candidate + ': ' + messageOf(error))
        return undefined
      }
      return candidate
    }
    return undefined
  }

  /** 写入前的整表校验：引用名、条目内去重、跨条目唯一、条目 id 必须存在。 */
  function validateKeysByEntry(map) {
    const errors = []
    if (map === undefined) return errors
    if (isPlainObject(map) !== true) {
      errors.push('keysByEntry must be an object mapping entry id to credential reference names')
      return errors
    }
    const known = new Set()
    for (const tier of config.tiers) for (const entry of tier.entries) known.add(entry.id)
    const owner = new Map()
    for (const [entryId, refs] of Object.entries(map)) {
      if (known.has(entryId) !== true) {
        errors.push('keysByEntry has unknown entry id: ' + entryId)
        continue
      }
      if (Array.isArray(refs) !== true) {
        errors.push('keysByEntry.' + entryId + ' must be an array of credential reference names')
        continue
      }
      const seen = new Set()
      for (const ref of refs) {
        if (isCredentialRef(ref) !== true) {
          errors.push('keysByEntry.' + entryId + ' has an invalid credential reference name: ' + JSON.stringify(ref))
          continue
        }
        if (seen.has(ref)) {
          errors.push('keysByEntry.' + entryId + ' repeats credential reference: ' + ref)
          continue
        }
        seen.add(ref)
        const previous = owner.get(ref)
        if (previous !== undefined && previous !== entryId) errors.push('credential reference "' + ref + '" is used by both entry ' + previous + ' and entry ' + entryId)
        else owner.set(ref, entryId)
      }
    }
    return errors
  }

  /** 每日重置：清空失效标记 + 把仍属插件状态的条目写回首项（默认 key）。 */
  async function keyResetDue(reason) {
    const previous = state.keyGeneration
    state.keyGeneration = previous + 1
    state.keyFailed.clear()
    const actions = []
    for (const tier of config.tiers) {
      for (const entry of tier.entries) {
        const keys = effectiveKeys(entry)
        if (keys.length === 0) continue
        const active = activeRefOf(entry.route)
        if (active === undefined) continue
        if (keys.indexOf(active) < 0) {
          // 当前引用不是本条目声明的引用：视为用户手工状态，只清标记不改写。
          actions.push({ entry: entry.id, action: 'keep-manual', ref: active })
          continue
        }
        const target = keys[0]
        if (target === active) continue
        const info = await refConfigured(target)
        if (info.configured !== true) {
          actions.push({ entry: entry.id, action: 'skip-unconfigured', ref: target })
          continue
        }
        try {
          await writeActiveRef(entry.route, target)
          actions.push({ entry: entry.id, action: 'restore', ref: target, from: active })
        } catch (error) {
          actions.push({ entry: entry.id, action: 'failed', ref: target, error: messageOf(error) })
        }
      }
    }
    pushLog({ at: Date.now(), kind: 'key-reset', reason, actions })
    const summary = actions.length === 0 ? 'no entry with keys needed a rewrite' : actions.map((item) => item.entry + ':' + item.action + (item.ref !== undefined ? '(' + item.ref + ')' : '')).join(', ')
    console.warn('[dsh-provider-failover] key reset (' + reason + '): ' + summary)
  }

  /** 状态展示用的引用描述刷新（短 TTL；只读，失败按未配置）。 */
  async function refreshRefInfo() {
    const now = Date.now()
    for (const tier of config.tiers) {
      for (const entry of tier.entries) {
        for (const ref of effectiveKeys(entry)) {
          const cached = state.refInfo.get(ref)
          if (cached !== undefined && now - cached.at < REF_INFO_TTL_MS) continue
          await refConfigured(ref)
        }
      }
    }
  }

  function stepState(sessionId, turn, step) {
    const key = stepKeyOf(sessionId, turn, step)
    let record = state.steps.get(key)
    if (record === undefined) {
      record = { attempted: new Set(), target: undefined, switches: 0, needs: { tools: false, images: false }, at: Date.now() }
      state.steps.set(key, record)
      if (state.steps.size > 128) {
        // 按 lastAccess 淘汰：不得误删活跃 step 的记账（R5 语义）。
        // 必须排除刚创建的 key：它的 at 是本轮最新，若参与比较会因同毫秒并列被误删，
        // 使该 (turn, step) 的 target/记账在 request 与 request-error 之间丢失。
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [k, v] of state.steps) {
          if (k === key) continue
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

  /**
   * 记录一次「保持当前路由」的决策，供设置页回答“为什么没换 key/换 provider”。
   * 同一 (turn, step, route, category) 只保留一条，避免宿主重试刷屏。
   */
  function pushIgnored(record) {
    const signature = [record.turn, record.step, record.provider, record.category].join('|')
    if (state.ignoredLog.some((item) => [item.turn, item.step, item.provider, item.category].join('|') === signature)) return
    state.ignoredLog.unshift(record)
    if (state.ignoredLog.length > 50) state.ignoredLog.length = 50
  }

  /**
   * 会话是否已有用户显式选择、但尚未被某次请求真正执行（durable model/selection 投影）。
   * 投影服务缺失时失败闭合为 undefined——此时继续走 base/options/header 判定，不静默改写。
   */
  function pendingSelectionOf(agent) {
    if (agent === null || agent === undefined) return undefined
    const registry = ctx.get('sessionProjections') ?? agent.ctx?.get?.('sessionProjections')
    const session = agent.session
    if (registry === undefined || session === undefined || typeof registry.stateOf !== 'function') return undefined
    try {
      const stateOf = registry.stateOf(session, 'modelSelection')
      const pending = stateOf?.pending
      return pending !== null && pending !== undefined && typeof pending.provider === 'string' ? pending : undefined
    } catch (error) {
      return undefined
    }
  }

  /** 该 Agent 是否已有过真实请求头（有任何 request/header 的会话都不是“新会话”）。 */
  function hasLoggedHeader(agent) {
    try {
      return agent?.session?.requestHeader?.() !== undefined
    } catch (error) {
      return false
    }
  }

  /**
   * 启动对齐只判定一次：Agent 已判定过、存在显式 pending 选择、已有持久化请求头、
   * 或上游链已把请求路由改到非 Agent 声明路由，都视为“用户/宿主意图优先”，不介入。
   * 返回 true 表示本插件可以执行启动对齐。
   */
  function startupAlignAllowed(agent, base) {
    if (agent === null || agent === undefined) return false
    if (state.startupHandled.has(agent)) return false
    state.startupHandled.add(agent)
    if (pendingSelectionOf(agent) !== undefined) return false
    if (hasLoggedHeader(agent)) return false
    const declaredProvider = typeof agent.options?.provider === 'string' ? agent.options.provider : ''
    const declaredModel = typeof agent.options?.model === 'string' ? agent.options.model : ''
    if (declaredProvider.length > 0 && base.provider !== declaredProvider) return false
    if (declaredModel.length > 0 && base.model !== declaredModel) return false
    return true
  }

  /**
   * 目标预检：路由/模型必须能被解析；声明了 `reasoningEffort` 的条目还必须确认该层级受模型支持。
   * 任一不满足即视为候选不合格——跳过候选，而不是把 `UNSUPPORTED_REASONING_EFFORT` 抛给宿主打断整轮。
   */
  async function serviceable(entry, signal) {
    if (config.probeTarget !== true) return true
    const service = llm()
    if (service === undefined || typeof service.resolveModelInfo !== 'function') return true
    let info
    try {
      info = await service.resolveModelInfo(entry.route, entry.model, signal)
    } catch (error) {
      console.warn('[dsh-provider-failover] candidate skipped (unresolvable): ' + entry.route + '/' + entry.model + ' — ' + messageOf(error))
      return false
    }
    const unsupported = unsupportedReasoningEffort(entry, info)
    if (unsupported !== undefined) {
      console.warn('[dsh-provider-failover] candidate skipped (unsupported reasoning effort): ' + entry.route + '/' + entry.model + ' reasoningEffort "' + String(entry.reasoningEffort) + '" ' + unsupported)
      return false
    }
    return true
  }

  /**
   * 测试切换下发的推理层级：条目声明了 `reasoningEffort` 但模型目录不支持时**丢弃并警告**。
   * 官方 `selectModel` 会按模型能力校验层级并抛错，不能让一次测试切换打断会话。
   * 解析服务不可用时保持原样，交由官方通路自行判定。
   */
  async function usableEffort(entry) {
    if (entry.reasoningEffort === undefined) return undefined
    const service = llm()
    if (service === undefined || typeof service.resolveModelInfo !== 'function') return entry.reasoningEffort
    let info
    try {
      info = await service.resolveModelInfo(entry.route, entry.model)
    } catch (error) {
      return entry.reasoningEffort
    }
    const unsupported = unsupportedReasoningEffort(entry, info)
    if (unsupported === undefined) return entry.reasoningEffort
    console.warn('[dsh-provider-failover] test switch drops reasoning effort: ' + entry.route + '/' + entry.model + ' reasoningEffort "' + String(entry.reasoningEffort) + '" ' + unsupported)
    return undefined
  }

  /**
   * 插件改写 provider/model 时同步推理层级。旧模型（或会话持久化选择）上的
   * `reasoningEffort` 不能原样带到新模型：目标模型不支持时宿主会在联网前抛
   * `UNSUPPORTED_REASONING_EFFORT`，而该编码不属于可切换失败，整轮会被打断、
   * 且待生效的会话选模永远 commit 不了——表现为「切换 provider 时持续卡在前一个故障中」。
   * 规则：条目声明的层级最优先；否则继承层级仅在目标模型支持时保留，不支持则丢弃。
   * 模型信息不可用（解析服务缺失/抛错）时保持原样，交由宿主自行判定。
   */
  async function reconcileEffort(entry, inheritedEffort, signal) {
    if (entry.reasoningEffort !== undefined) return entry.reasoningEffort
    if (inheritedEffort === undefined) return undefined
    const service = llm()
    if (service === undefined || typeof service.resolveModelInfo !== 'function') return inheritedEffort
    let info
    try {
      info = await service.resolveModelInfo(entry.route, entry.model, signal)
    } catch (error) {
      return inheritedEffort
    }
    if (unsupportedReasoningEffort({ reasoningEffort: inheritedEffort }, info) === undefined) return inheritedEffort
    console.warn('[dsh-provider-failover] dropping inherited reasoning effort "' + inheritedEffort + '" for ' + entry.route + '/' + entry.model + ' (model does not support it)')
    return undefined
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

  async function pickCandidate(sessionId, turn, step, context, signal, excludeRoute) {
    const record = stepState(sessionId, turn, step)
    const now = Date.now()
    for (const tier of config.tiers) {
      if (tier.enabled !== true) continue
      for (const entry of await entriesInOrder(tier, context, signal, excludeRoute)) {
        if (entry.enabled !== true) continue
        if (record.attempted.has(attemptKey(entry.id, entry.route, activeRefOf(entry.route)))) continue
        if (cooling(entry.route, now)) continue
        if (compatible(entry, record.needs) !== true) continue
        if ((await serviceable(entry, signal)) !== true) continue
        return { tier, entry }
      }
    }
    return undefined
  }

  // ---------------------------------------------------------------- 钩子一
  // 每次尝试前决定本次实际使用的路由/模型/推理层级。
  ctx.on('llm/stream', (options, next) => {
    // 插件自身的排序/全量测试请求不参与路由编排（集合判断，支持并发）。
    if (options?.signal !== undefined && (state.rankingSignals.has(options.signal) || state.probeSignals.has(options.signal))) return next()
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
    // 按会话记录，避免并行会话互相污染能力需求；带时间戳用于容量淘汰。
    const needsKey = sessionKeyOf(options?.sessionId)
    state.pendingNeeds.set(needsKey, { needs, at: Date.now() })
    if (state.pendingNeeds.size > 128) {
      let oldestKey
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [k, v] of state.pendingNeeds) {
        if (k === needsKey) continue
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
      }
      if (oldestKey !== undefined) state.pendingNeeds.delete(oldestKey)
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    if (config.enabled !== true || config.tiers.length === 0) return base
    const sessionId = sessionIdOf(payload?.agent)
    const sessionKey = sessionKeyOf(sessionId)
    const turn = payload?.turn ?? 0
    const step = payload?.step ?? 0
    const record = stepState(sessionId, turn, step)
    // 需求在 llm/stream 里观测、在 request 里取用；同一 turn 内保持粘滞，避免第一步没有需求信息。
    const pending = state.pendingNeeds.get(sessionKey)
    if (pending !== undefined) record.needs = pending.needs

    let target = record.target
    // 会话级测试 pin：有效期内直接下发该目标并跳过启动对齐（否则会被拉回目标档）。
    const pin = activePin(sessionId)
    if (pin !== undefined) {
      const agent = payload?.agent
      if (agent !== null && typeof agent === 'object') state.startupHandled.add(agent)
      const pinnedConfig = { ...base, provider: pin.route, model: pin.model }
      const pinEffort = await reconcileEffort({ route: pin.route, model: pin.model, reasoningEffort: pin.reasoningEffort }, base.reasoningEffort, payload?.signal)
      if (pinEffort === undefined) delete pinnedConfig.reasoningEffort
      else pinnedConfig.reasoningEffort = pinEffort
      return pinnedConfig
    }
    if (target === undefined && config.startup.preferTier > 0 && startupAlignAllowed(payload?.agent, base)) {
      // 启动对齐（口径 B）：当前路由已属于目标档则不改写，否则对齐到该档排序最前的可用条目。
      // 它只作用于“无持久化请求、无显式选择”的全新 Agent 首个请求；之后永不覆盖会话内选模。
      const current = tierOf(config, base.provider)
      const wanted = config.tiers.find((tier) => tier.tier === config.startup.preferTier)
      if (wanted !== undefined && wanted.enabled === true && (current === undefined || current.tier !== wanted.tier)) {
        const picked = await pickCandidate(sessionId, turn, step, base.provider + '/' + base.model + ' startup', payload?.signal, undefined)
        if (picked !== undefined) {
          target = { entry: picked.entry, tier: picked.tier, reason: 'startup-align' }
          record.target = target
          pushLog({ at: Date.now(), kind: 'startup-align', from: base.provider + '/' + base.model, to: picked.entry.route + '/' + picked.entry.model, tier: picked.tier.tier })
          console.warn('[dsh-provider-failover] startup-align ' + base.provider + '/' + base.model + ' -> ' + picked.entry.route + '/' + picked.entry.model + ' tier ' + String(picked.tier.tier) + ' (preferTier ' + String(config.startup.preferTier) + ')')
        }
      }
    }

    if (target === undefined) return base
    // 路由与模型由条目决定；key 轮换不改这两者（只改该路由的 apiKeyEnv 引用）。
    const switchedConfig = { ...base, provider: target.entry.route, model: target.entry.model }
    // 同步推理层级：条目声明的优先，否则仅在目标模型支持时保留继承层级（见 reconcileEffort）。
    const effort = await reconcileEffort(target.entry, base.reasoningEffort, payload?.signal)
    if (effort === undefined) delete switchedConfig.reasoningEffort
    else switchedConfig.reasoningEffort = effort
    return switchedConfig
  })

  // ---------------------------------------------------------------- 钩子二
  ctx.on('agent/request-error', async (payload, next) => {
    if (config.enabled !== true || config.tiers.length === 0) return next()
    const failure = payload?.failure
    const sessionId = sessionIdOf(payload?.agent)
    const sessionKey = sessionKeyOf(sessionId)
    const turn = payload?.turn ?? 0
    const step = payload?.step ?? 0
    const decision = isSwitchable(config, failure?.code, failure?.message)
    if (decision.hit !== true) {
      // 记录「为什么不切换」，避免设置页/日志只看到沉默；不改变宿主原有失败路径。
      pushIgnored({
        at: Date.now(),
        session: sessionKey === '-' ? '' : sessionKey,
        provider: typeof payload?.provider === 'string' ? payload.provider : '',
        category: decision.category ?? 'other',
        reason: decision.reason ?? '',
        code: typeof failure?.code === 'string' ? failure.code : '',
        message: String(failure?.message ?? '').slice(0, 200),
        turn,
        step,
      })
      return next()
    }

    const record = stepState(sessionId, turn, step)
    const failedRoute = typeof payload?.provider === 'string' ? payload.provider : ''
    const code = typeof failure?.code === 'string' ? failure.code.toUpperCase() : ''

    const now = Date.now()
    if (now - (state.lastSwitchAt.get(sessionKey) ?? 0) < config.minSwitchIntervalMs) return next()
    if (record.switches >= config.maxSwitchesPerTurn) return next()

    const failedLoc = failedRoute.length > 0 ? locateRoute(config, failedRoute) : undefined
    const failedEntry = failedLoc?.entry
    const activeRef = failedRoute.length > 0 ? activeRefOf(failedRoute) : undefined
    if (failedEntry !== undefined) record.attempted.add(attemptKey(failedEntry.id, failedRoute, activeRef))

    // ① 凭据类失败：先在该条目内换 key（同路由、同模型，只改 apiKeyEnv 引用）。
    //    只有归一化到凭据类编码才走这里；消息模式兜底命中的失败按非凭据类处理。
    if (failedEntry !== undefined && hasRotation(failedEntry) && KEY_ROTATION_CODES.has(code)) {
      const rotatedTo = await rotateKey(failedEntry, failedRoute, activeRef, code, now, failure?.message)
      if (rotatedTo !== undefined) {
        record.target = { entry: failedEntry, tier: failedLoc.tier, reason: 'key:' + code }
        record.switches += 1
        state.lastSwitchAt.set(sessionKey, now)
        pushLog({
          at: now,
          kind: 'key-rotate',
          from: failedRoute,
          to: failedRoute + '/' + failedEntry.model,
          key: rotatedTo,
          fromKey: activeRef,
          tier: failedLoc.tier.tier,
          code,
          trigger: decision.how,
          turn,
          step,
        })
        console.warn('[dsh-provider-failover] key rotate ' + failedEntry.id + '@' + failedRoute + ' ' + String(activeRef ?? '(unset)') + ' -> ' + rotatedTo + ' (' + decision.how + ', turn ' + String(turn) + ' step ' + String(step) + ')')
        return { kind: 'retry' }
      }
      // 无可用下一把（全部失效 / 未配置 / 写入失败）→ 落到 provider 切换路径。
    }

    // ② provider 切换：失败路由进入冷却，本步不再尝试它。
    if (failedRoute.length > 0) {
      state.routeHealth.set(failedRoute, {
        coolingUntil: now + (failedEntry?.cooldownMs ?? 60000),
        code: typeof failure?.code === 'string' ? failure.code : '',
        message: String(failure?.message ?? '').slice(0, 200),
        at: now,
      })
    }

    const context = String(failure?.code ?? '') + ' ' + String(failure?.message ?? '') + (record.needs.tools ? ' tools' : '') + (record.needs.images ? ' images' : '')
    const picked = await pickCandidate(sessionId, turn, step, context, payload?.signal, failedRoute)
    if (picked === undefined) return next()

    record.target = { entry: picked.entry, tier: picked.tier, reason: decision.how }
    record.switches += 1
    state.lastSwitchAt.set(sessionKey, now)
    pushLog({
      at: now,
      kind: 'failover',
      from: failedRoute,
      to: picked.entry.route + '/' + picked.entry.model,
      tier: picked.tier.tier,
      code: typeof failure?.code === 'string' ? failure.code : '',
      trigger: decision.how,
      turn,
      step,
    })
    console.warn('[dsh-provider-failover] switch ' + (failedRoute.length > 0 ? failedRoute : '(unknown)') + ' -> ' + picked.entry.route + '/' + picked.entry.model + ' tier ' + String(picked.tier.tier) + ' (' + decision.how + ', turn ' + String(turn) + ' step ' + String(step) + ')')
    return { kind: 'retry' }
  })

  // ------------------------------------------------------------ 设置项与状态接口
  // 设置命名空间 `provider-failover`：用户层落在 `$DSH_HOME/settings.yaml`，
  // base 层来自 profile patch 的条目配置（没被用户覆盖的项仍以 patch 为准），
  // 默认 effect=live → 变更即时生效，无需重启。
  // 对话指令：/failover-test [tier:N|<entryId>|clear]
  // 把「该会话所选 provider/模型」切到档位表中的目标；commands 服务未组合时静默跳过。
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'failover-test',
      description: '测试故障转移：把当前会话的 provider/模型切到档位表中的目标（tier:N / 条目 id / clear）',
      handler: async (invocation) => {
        const sessionId = sessionIdOf(invocation.agent)
        if (sessionId === undefined) return { kind: 'error', text: '无法确定当前会话，测试切换未执行。' }
        const spec = String(invocation.rawInput ?? '').trim()
        if (spec === 'clear' || spec === 'reset') {
          state.pins.delete(pinKeyOf(sessionId))
          return { kind: 'success', text: '已解除本会话的测试切换。' }
        }
        let current
        try {
          const header = invocation.agent.session.requestHeader()
          current = header !== undefined && header !== null && header.config !== undefined ? header.config.provider : undefined
        } catch (error) {
          current = undefined
        }
        const target = resolveTestTarget(config.tiers, spec, current)
        if (target === undefined) {
          const available = testTargets().map((item) => item.id).join(', ')
          return { kind: 'error', text: '未知测试目标：' + (spec.length > 0 ? spec : '(空)') + '；可用条目：' + available + '，或 tier:N，或 clear。' }
        }
        try {
          const pin = await applyTestSwitch(sessionId, target, 'command:' + (spec.length > 0 ? spec : 'next'))
          return {
            kind: 'success',
            text: '已切换本会话模型：' + pin.route + '/' + pin.model + '（档 ' + String(pin.tier) + '，条目 ' + pin.entryId + '）。'
              + '测试 pin ' + String(Math.round(TEST_PIN_TTL_MS / 60000)) + ' 分钟后自动失效，可 /failover-test clear 立即解除。'
              + '注意：该切换与模型选择器同路，会同时存为默认模型。',
          }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    })
    // 对话指令：/failover-probe [条目 id]
    // 对启用档位下的每个 provider/model 发最小真实请求，列出额度/凭据/限流/网络等状态。
    commandsCtx.commands.register({
      name: 'failover-probe',
      description: '全量测试：对启用档位的每个 provider/model 发送最小请求并列出状态（额度不足/凭据/限流/网络等）',
      handler: async (invocation) => {
        const spec = String(invocation?.rawInput ?? '').trim()
        if (spec === 'clear') {
          state.lastProbe = undefined
          return { kind: 'success', text: '已清除上一次全量测试结果。' }
        }
        const report = await probeAll({ entry: spec.length > 0 ? spec : undefined, sessionId: sessionIdOf(invocation?.agent) })
        if (report.ok !== true) return { kind: 'error', text: report.error }
        const lines = report.results.map((item) =>
          '- ' + item.id + '（' + item.route + '/' + item.model + '）· ' + item.label + ' · ' + String(item.ms) + 'ms'
          + (item.ok === true ? (item.reply !== undefined && item.reply.length > 0 ? ' · ' + item.reply : '') : ' · ' + String(item.message ?? '')))
        return {
          kind: 'success',
          text: '全量测试 ' + String(report.summary.ok) + '/' + String(report.summary.total) + ' 正常，用时 ' + String(report.elapsedMs) + 'ms（超时 ' + String(report.timeoutMs) + 'ms/目标）：\n' + lines.join('\n'),
        }
      },
    })
  })

  // 0.2 移除了按插件的 settings namespace store（`ctx.settings.register`）；
  // 设置改为插件自有的 JSON 文件，base/sync/端点语义保持不变。
  {
    const scope = createFileSettingsScope({
      file: settingsFilePath(),
      base: {
        enabled: config.enabled,
        minSwitchIntervalMs: config.minSwitchIntervalMs,
        maxSwitchesPerTurn: config.maxSwitchesPerTurn,
        startupPreferTier: config.startup.preferTier,
        rankingMode: config.ranking.mode,
        keyResetAt: config.keyResetAt,
        keysByEntry: {},
      },
    })
    const sync = (value, source) => {
      config.enabled = value.enabled === true
      config.minSwitchIntervalMs = value.minSwitchIntervalMs
      config.maxSwitchesPerTurn = value.maxSwitchesPerTurn
      config.startup.preferTier = value.startupPreferTier
      config.ranking.mode = value.rankingMode
      if (parseClock(value.keyResetAt) !== undefined) config.keyResetAt = value.keyResetAt
      else console.warn('[dsh-provider-failover] ignoring invalid keyResetAt (expected HH:MM): ' + String(value.keyResetAt))
      state.keysByEntry = isPlainObject(value.keysByEntry) ? value.keysByEntry : {}
      const keySummary = config.tiers.map((tier) => tier.entries.map((entry) => entry.id + ':' + String(effectiveKeys(entry).length)).join(',')).join(' | ')
      console.log('[dsh-provider-failover] settings ' + source + ': enabled=' + String(config.enabled) + ' minSwitchIntervalMs=' + String(config.minSwitchIntervalMs) + ' maxSwitchesPerTurn=' + String(config.maxSwitchesPerTurn) + ' startup.preferTier=' + String(config.startup.preferTier) + ' ranking=' + config.ranking.mode + ' keyResetAt=' + config.keyResetAt + ' keys=' + keySummary)
      ensureKeyResetTimer()
    }
    state.settings = scope
    state.syncSettings = sync
    sync(scope.get(), 'loaded')
    scope.watch((next) => { sync(next, 'updated') })
  }

  // 每日重置排程：到下一个 keyResetAt（本地时间）清失效标记并把默认 key 写回，然后重新排程。
  // 无任何条目有生效 key 引用时不排程；界面新增引用后由 ensureKeyResetTimer() 补启用（无需重启）。
  function ensureKeyResetTimer() {
    if (state.keyResetArmed === true) return
    if (config.tiers.some((tier) => tier.entries.some((entry) => hasRotation(entry))) !== true) return
    state.keyResetArmed = true
    ctx.effect(() => {
      let handle
      const arm = () => {
        const now = Date.now()
        const due = nextResetAt(config.keyResetAt, now)
        // setTimeout 的上限约 24.8 天；这里最多 24 小时，无需分段。
        handle = setTimeout(() => {
          keyResetDue('scheduled')
            .catch((error) => console.warn('[dsh-provider-failover] key reset failed: ' + messageOf(error)))
            .finally(arm)
        }, Math.max(1000, due - now))
        // 不因后台排程阻止宿主/脚本退出（宿主有 webServer 时本就长驻，此项无副作用）。
        if (typeof handle.unref === 'function') handle.unref()
      }
      arm()
      return () => {
        if (handle !== undefined) clearTimeout(handle)
      }
    }, 'dsh-provider-failover: daily key reset timer')
  }
  ensureKeyResetTimer()

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
    const snapshot = async () => {
      await refreshRefInfo()
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
          const active = activeRefOf(entry.route)
          return {
            id: entry.id,
            route: entry.route,
            model: entry.model,
            registered: directoryKnown ? registeredIds.has(entry.route) : true,
            cooling: cooling(entry.route, now),
            activeRef: active,
            keysSource: Array.isArray(state.keysByEntry[entry.id]) ? 'settings' : 'patch',
            keys: effectiveKeys(entry).map((ref) => {
              const info = state.refInfo.get(ref)
              const mark = refFailed(ref) ? state.keyFailed.get(ref) : undefined
              return {
                ref,
                active: ref === active,
                configured: info !== undefined ? info.configured : false,
                source: info?.source,
                failed: mark !== undefined,
                failedAt: mark !== undefined ? mark.at : undefined,
                failedCode: mark !== undefined ? mark.code : undefined,
                failedMessage: mark !== undefined ? String(mark.message ?? '').slice(0, 120) : undefined,
              }
            }),
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
          keyResetAt: config.keyResetAt,
          keysByEntry: state.keysByEntry,
        },
        writable: state.settings !== undefined,
        keyResetAt: config.keyResetAt,
        nextKeyResetAt: nextResetAt(config.keyResetAt, now),
        testTargets: testTargets(),
        pins: [...state.pins.entries()].map(([session, pin]) => ({ session, entryId: pin.entryId, route: pin.route, model: pin.model, tier: pin.tier, at: pin.at })),
        lastSessionId: state.lastSessionId !== undefined ? state.lastSessionId.id : undefined,
        tiers,
        providers: directoryKnown ? {
          registered: directory.registered,
          configurable: directory.configurable,
          unassigned: directory.registered.filter((item) => assigned.has(item.id) !== true),
          missing: [...assigned].filter((route) => registeredIds.has(route) !== true),
        } : null,
        switches: state.switchLog.slice(0, LOG_LIMIT),
        ignored: state.ignoredLog.slice(0, LOG_LIMIT),
        lastProbe: state.lastProbe,
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        cooling: [...state.routeHealth.entries()].map(([route, health]) => ({ route: route, code: health.code, until: health.coolingUntil })),
      }
    }
    register(ROUTE_BASE + '/status', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      sendJson(res, 200, await snapshot())
    })
    register(ROUTE_BASE + '/keys', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const body = await readJsonBody(req)
      const wanted = typeof body.entry === 'string' ? body.entry : undefined
      const targets = []
      for (const tier of config.tiers) {
        for (const entry of tier.entries) {
          if (hasRotation(entry) !== true) continue
          if (wanted !== undefined && entry.id !== wanted) continue
          targets.push(entry)
        }
      }
      if (targets.length === 0) return sendJson(res, 404, { ok: false, error: 'no entry with keys matches the request' })
      // 手工操作即「状态重来」：清空本周期失效标记。
      state.keyGeneration += 1
      state.keyFailed.clear()
      const results = []
      for (const entry of targets) {
        const keys = effectiveKeys(entry)
        const ref = typeof body.ref === 'string' && body.ref.length > 0 ? body.ref : keys[0]
        if (keys.indexOf(ref) < 0) {
          results.push({ entry: entry.id, ok: false, ref, error: 'ref is not declared in the entry key list' })
          continue
        }
        const info = await refConfigured(ref)
        if (info.configured !== true) {
          results.push({ entry: entry.id, ok: false, ref, error: 'ref is not configured in the host credential store' })
          continue
        }
        try {
          await writeActiveRef(entry.route, ref)
          results.push({ entry: entry.id, ok: true, ref, route: entry.route })
        } catch (error) {
          results.push({ entry: entry.id, ok: false, ref, error: messageOf(error) })
        }
      }
      for (const item of results) {
        if (item.ok !== true) continue
        pushLog({ at: Date.now(), kind: 'key-manual', from: item.route, to: item.route, key: item.ref, tier: 0, code: 'MANUAL', trigger: 'manual', turn: 0, step: 0 })
      }
      sendJson(res, 200, { ok: results.some((item) => item.ok === true), results, status: await snapshot() })
    })
    register(ROUTE_BASE + '/config', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      if (state.settings === undefined) return sendJson(res, 503, { ok: false, error: 'settings service is not composed; edit the profile patch instead' })
      const body = await readJsonBody(req)
      const patch = {}
      for (const key of ['enabled', 'minSwitchIntervalMs', 'maxSwitchesPerTurn', 'startupPreferTier', 'rankingMode', 'keyResetAt', 'keysByEntry']) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
      }
      if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, error: 'no editable field in request' })
      if (patch.keyResetAt !== undefined && parseClock(patch.keyResetAt) === undefined) return sendJson(res, 400, { ok: false, error: 'keyResetAt must be HH:MM in 24-hour local time' })
      const keyErrors = validateKeysByEntry(patch.keysByEntry)
      if (keyErrors.length > 0) return sendJson(res, 400, { ok: false, error: keyErrors.join('; '), errors: keyErrors })
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
          keyResetAt: config.keyResetAt,
          keysByEntry: state.keysByEntry,
          ...patch,
        }, 'updated')
      }
      sendJson(res, 200, await snapshot())
    })
    // 测试切换：{entry?, sessionId?, clear?}；缺 sessionId 时用最近一次活跃会话。
    register(ROUTE_BASE + '/test', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const body = await readJsonBody(req)
      const rawSessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0
        ? body.sessionId
        : (state.lastSessionId !== undefined ? state.lastSessionId.id : undefined)
      if (rawSessionId === undefined) return sendJson(res, 400, { ok: false, error: 'no session to test: pass sessionId or send a request in a session first' })
      if (body.clear === true) {
        state.pins.delete(pinKeyOf(rawSessionId))
        return sendJson(res, 200, { ok: true, cleared: true, sessionId: String(pinKeyOf(rawSessionId)), status: await snapshot() })
      }
      const spec = typeof body.entry === 'string' ? body.entry : ''
      // HTTP 路径不知道会话当前路由：空 spec 时从启用序列首项开始（与指令路径不同，指令用会话请求头定位）。
      const target = resolveTestTarget(config.tiers, spec, undefined)
      if (target === undefined) {
        const available = testTargets().map((item) => item.id).join(', ')
        return sendJson(res, 400, { ok: false, error: 'unknown test target: ' + (spec.length > 0 ? spec : '(empty)') + '; available entries: ' + available + ' or tier:N' })
      }
      try {
        const pin = await applyTestSwitch(rawSessionId, target, 'http:' + (spec.length > 0 ? spec : 'next'))
        return sendJson(res, 200, { ok: true, sessionId: String(pinKeyOf(rawSessionId)), pin, status: await snapshot() })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: messageOf(error) })
      }
    })
    // 全量测试：{entry?, timeoutMs?}；对启用档位下的每个 provider/model 发最小真实请求并列出状态。
    register(ROUTE_BASE + '/probe', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
      const body = await readJsonBody(req)
      const report = await probeAll({
        entry: typeof body.entry === 'string' && body.entry.length > 0 ? body.entry : undefined,
        timeoutMs: body.timeoutMs,
        sessionId: typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined,
      })
      sendJson(res, report.ok === true ? 200 : 400, report)
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
export const __test = { parseRanking, hashKey, sanitizeForRanking, isSwitchable, tierOf, orderEntries, isCredentialRef, parseClock, nextResetAt, selectNextRef, resolveTestTarget, unsupportedReasoningEffort, classifyProbeFailure }
