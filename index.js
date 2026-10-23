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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * rankingMode / keyResetAt / keysByEntry / rankingModel`；生效时机为写入后即时同步，无需重启。
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
const DEFAULT_TERMINAL_CODES = ['QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'SERVER', 'RATE_LIMIT', 'TRANSPORT']

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
  // 传输层异常：上游 WebSocket/SSE 中途断开。宿主 classifyPiAiError 只把
  // "WebSocket closed unexpectedly" 归一化为 TRANSPORT，像 "WebSocket closed 1000"
  // 这类仅带关闭码的文案会落到通用 PI_AI_ERROR，必须靠消息模式兜底才能触发切换。
  'websocket closed',
  // pi-ai 的原生 WebSocket 失败文案就是裸的 "WebSocket error"（实测见
  // .ptc-probe/failover-switch-incident.json 的 ignored 记录）。没有这一条，
  // 这类失败既不会重试也不会切换，直接交回宿主。
  'websocket error',
  'websocket',
  // 上游流错误（实测 2026-10-15，见 docs/ptc/reports/codex-relay-http2-stream-error-20261015.md）：
  // codex-relay 的上游 chatgpt.com Codex 后端 HTTP/2 流被对端复位，relay 以 SSE error 事件下发
  // `{"type":"error","code":"upstream_http2_stream_error","message":"Upstream HTTP/2 stream failed"}`，
  // pi-ai 拼成 `Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed` 抛出。
  // 该文案两条都不命中宿主 classifyPiAiError（既无 5xx 数字也无 network/socket/connection 词），
  // 于是落成 PI_AI_ERROR；宿主默认重试码表又不含 PI_AI_ERROR → 整轮终止、无自动恢复。
  // 这两条按 TRANSPORT 归类（连接层中断，与能否换 key 无关）：
  //   'http2'    —— HTTP/2 流/请求失败的各种文案；
  //   'upstream_'—— 网关/relay 转发层的前缀式错误码（upstream_*）。
  // 刻意不加宽泛的 'stream failed'：应用语义的 "stream failed to produce output" 会被误伤。
  'http2',
  'upstream_',
]

/**
 * 失败**原因**细分表（有序，自上而下首次命中）。
 *
 * 存在的理由：归一化码的粒度不够。宿主把上游 403 一律归一化成 `AUTH`，于是
 * 「余额不足，该去充值」与「该令牌无权访问这个模型，该换来源/换模型」这两件处置完全不同的事，
 * 在提示里长得一模一样。实测 2026-10-16：tokeniss 返回
 * `403 {"message":"预扣费额度失败, 用户剩余额度: ¥1.040956, 需要预扣费额度: ¥1.192114"}`
 * 且 `code: "AUTH"` —— 提示写「AUTH」，真因却是余额不足；同一时期 anthropic-relay 对
 * `claude-opus-5-5` 返回的 403「该令牌无权访问模型」也是 `AUTH`，但真因是模型未授权。
 *
 * 本表**只影响提示文案**：不参与 isSwitchable / retryPolicies / 冷却时长 / key 轮换的任何判定，
 * 因此增删词条永远不会改变切换与重试行为。匹配对象是**原始报文 + 归一化码**：与
 * effectiveFailureCode 不同，这里在码已归一化时**不短路**——短路正是 AUTH 提示丢失原文的原因。
 */
const DEFAULT_FAILURE_REASONS = [
  {
    id: 'QUOTA_EXHAUSTED',
    label: '额度/余额不足',
    // 中文厂商文案（实测 tokeniss「预扣费额度失败 / 用户剩余额度」）与常见英文额度报错。
    patterns: ['预扣费额度失败', '剩余额度', '余额不足', '额度不足', '额度已用尽', '欠费', 'insufficient balance', 'insufficient_quota', 'insufficient funds', 'quota exceeded', 'usage limit', 'usage_limit', 'balance', 'out of credits', 'no credits'],
  },
  {
    id: 'MODEL_NOT_AUTHORIZED',
    label: '权限不足：该令牌无权使用该模型',
    // 实测 anthropic-relay 对 claude-opus-5-5 返回 403「该令牌无权访问模型 claude-opus-5-5」。
    // 与「凭据无效」的区别很关键：凭据本身有效，只是这一把 token 没有该模型/该来源的授权，
    // 处置是换来源或换档，而不是换 key 或重新登录。
    patterns: ['无权访问模型', '无权使用', '无权限', '未授权', 'not authorized', 'unauthorized', 'permission', 'forbidden', 'not allowed to access'],
  },
  {
    id: 'CREDENTIAL_INVALID',
    label: '凭据无效',
    patterns: ['invalid api key', 'invalid_api_key', 'incorrect api key', 'invalid token', 'invalid credential', 'authentication failed', 'api key not valid'],
  },
  {
    id: 'CREDENTIAL_MISSING',
    label: '凭据缺失',
    patterns: ['missing api key', 'no api key', 'api key is required', 'credential not found'],
  },
  {
    id: 'RATE_LIMITED',
    label: '被限流',
    patterns: ['rate limit', 'too many requests'],
  },
]

/**
 * 原文都认不出来时，退回**按归一化码**给一个原因标签。
 * `AUTH` 刻意不再写「凭据无效」——那一句正是本次要修的误导：403 里既有余额不足也有模型未授权，
 * 拿不准时如实说「未细分」，而不是替用户下结论。
 */
const CODE_REASON_LABELS = {
  QUOTA: '额度/余额不足',
  AUTH: '授权被拒（未细分到具体原因）',
  INVALID_CREDENTIAL: '凭据无效',
  MISSING_CREDENTIAL: '凭据缺失',
  NO_ADAPTER: '路由未注册/无适配器',
  RATE_LIMIT: '被限流',
  SERVER: '服务端异常',
  TRANSPORT: '传输中断',
  CONTEXT_WINDOW_EXCEEDED: '上下文超限',
  INVALID_REQUEST: '请求无效',
  UNSUPPORTED_REASONING_EFFORT: '推理档位不支持',
}

/** 通知里保留的上游原文长度（脱敏后截断）。 */
const FAILURE_DETAIL_LIMIT = 200

/**
 * 一次失败的**原因**（纯函数）：先按 DEFAULT_FAILURE_REASONS 的顺序匹配原始报文与归一化码，
 * 全部未命中才退回 CODE_REASON_LABELS 的按码标签。返回值只用于展示：
 * `{ id, label, matched }`，`matched` 是命中的那个词（留作证据）。
 */
function failureReasonFor(code, message, table) {
  const entries = Array.isArray(table) && table.length > 0 ? table : DEFAULT_FAILURE_REASONS
  const haystack = (String(message ?? '') + ' ' + String(code ?? '')).toLowerCase()
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      const needle = String(pattern).toLowerCase()
      if (needle.length > 0 && haystack.indexOf(needle) >= 0) return { id: entry.id, label: entry.label, matched: String(pattern) }
    }
  }
  const normalized = typeof code === 'string' ? code.toUpperCase() : ''
  const label = CODE_REASON_LABELS[normalized]
  if (label === undefined) return { id: 'UNKNOWN', label: '原因未知', matched: undefined }
  return { id: normalized, label: label, matched: undefined }
}

/**
 * 合并配置里的 `failureReasons`（原因 id → 追加词条）与内置表，返回生效的有序表。
 * 只做**追加**不做替换，避免一份设备配置把内置的中英文词条整体挤掉；
 * 未知 id 与空数组都记配置错误（否则拼错的键会静默什么都不做）。
 */
function mergeFailureReasons(raw, errors) {
  const table = DEFAULT_FAILURE_REASONS.map((entry) => ({ id: entry.id, label: entry.label, patterns: [...entry.patterns] }))
  if (raw === undefined || raw === null) return table
  if (!isPlainObject(raw)) {
    errors.push('failureReasons must be an object mapping reason id -> extra patterns (string[])')
    return table
  }
  for (const key of Object.keys(raw)) {
    const target = table.find((entry) => entry.id === String(key).toUpperCase())
    if (target === undefined) {
      errors.push('failureReasons.' + key + ' is not a known reason id (known: ' + table.map((entry) => entry.id).join(', ') + ')')
      continue
    }
    const extra = strings(raw[key])
    if (extra.length === 0) {
      errors.push('failureReasons.' + key + ' must be a non-empty array of strings')
      continue
    }
    for (const pattern of extra) {
      const text = pattern.toLowerCase()
      if (target.patterns.indexOf(text) < 0) target.patterns.push(text)
    }
  }
  return table
}

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
  // policy（内容/安全策略）类失败的处理模式：
  //   'same'   —— 保留当前 provider/model，在同一 (turn, step) 内原地重试（默认；
  //               受 maxPolicyRetriesPerStep 约束，不轮换 key、不切换 provider、不冷却路由）
  //   'switch' —— 切换到下一条已配置 provider（旧 `policyFailover: true` 行为）
  //   'off'    —— 不介入，交回宿主原有失败路径（旧 `policyFailover: false` 行为）
  policyMode: 'same',
  // 兼容旧字段：`policyMode` 未给出时按它推导（false→off，true→switch）。
  policyFailover: true,
  // 单 (turn, step) 内 policy 同 provider 重试次数上限。
  maxPolicyRetriesPerStep: 2,
  /**
   * 按失败类别的重试策略（切换 provider 之前的原地重试）。
   *
   * 语义按类别分开，而不是所有错误一律“立刻切换”：
   *   TRANSPORT   连接/流中断（WebSocket error、socket hang up…）——等 delayMs 重试，
   *               attempts 次或预算用尽才切换；observationWindowMs 内（连接活过该窗口
   *               才失败）按“意外中断”处理，活过窗口外则视为路由已不可用，直接切换。
   *   RATE_LIMIT  服务端限流——按 retryAfterMs 退避重试，预算用尽再切换。
   *   SERVER      上游 5xx（含空体 502）——按 delayMs 间隔原地重试，attempts 次或预算用尽
   *               再切换。实测 2026-10-16：codex-relay 连续三次返回空体 502（单次请求约 15s），
   *               旧策略 2 次重试 × 3s 退避在 36s 内就交出了路由；紧接着 openai-codex 报额度
   *               用尽、kimi 报周额度 403，tier1 全线失败，子代理整轮失败。改为 5 次 × 5s
   *               （30s 预算）给短时过载留出自愈窗口，预算耗尽才把故障交给下一档。
   *   QUOTA / AUTH / INVALID_CREDENTIAL / MISSING_CREDENTIAL / NO_ADAPTER
   *               额度与凭据类，重试无意义——立即切换（attempts=0）。
   */
  retryPolicies: {
    TRANSPORT: { attempts: 5, delayMs: 5000, budgetMs: 30000, observationWindowMs: 30000 },
    RATE_LIMIT: { attempts: 3, delayMs: 15000, budgetMs: 60000 },
    SERVER: { attempts: 5, delayMs: 5000, budgetMs: 30000 },
    QUOTA: { attempts: 0 },
    AUTH: { attempts: 0 },
    INVALID_CREDENTIAL: { attempts: 0 },
    MISSING_CREDENTIAL: { attempts: 0 },
    NO_ADAPTER: { attempts: 0 },
    DEFAULT: { attempts: 1, delayMs: 2000, budgetMs: 10000 },
  },
  terminalCodes: DEFAULT_TERMINAL_CODES,
  failurePatterns: DEFAULT_FAILURE_PATTERNS,
  // 失败原因细分（只影响提示文案，不参与任何切换/重试判定）。
  // 同一个 `AUTH` 下「余额不足」与「该令牌无权访问模型」的处置完全不同，而归一化码区分不了；
  // 实测见 DEFAULT_FAILURE_REASONS 的注释。配置层只能用 failureReasons 往内置表里**追加**词条。
  failureReasons: DEFAULT_FAILURE_REASONS,
  minSwitchIntervalMs: 1000,
  maxSwitchesPerTurn: 6,
  // 按失败类别的冷却覆盖：{ QUOTA: 18000000 } 表示额度耗尽的路由冷却 5 小时。
  // 键为归一化错误码（大写）；消息模式兜底命中的失败按其模式归类（usage limit /
  // quota / balance 归 QUOTA，websocket closed 归 TRANSPORT 等）。未命中退回条目
  // cooldownMs（默认 60s）。额度耗尽恢复以小时计，默认 60s 会让死路由被反复捡回。
  cooldownByCode: {},
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
    /**
     * 同族互备优先（默认关闭，保持 v3.4.0 的「从第 1 档向上扫」语义）。
     *
     * 打开后：失败路由能在档位表里定位时，先只在它**所落的那一档**内选候选，
     * 该档内确实选不到（全部已尝试/冷却中/能力不兼容/不可解析）才退回全档扫描。
     * 例：opencode-go 失败先切同档的 ais-2dsglm（同为 deepseek-v4.1-flash），
     * 而不是直接升到第 1 档的 gpt-6.1-sol。
     */
    sameTierFirst: false,
  },
  tiers: DEFAULT_TIERS,
}

// ---------------------------------------------------------------- 配置校验

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) !== true
}

/** 归一化 { CODE: ms }：键转大写；形状与逐条校验在 normalizeConfig 的 errors 里完成。 */
function normalizeCooldownByCode(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const key of Object.keys(raw)) {
    const code = String(key).toUpperCase().trim()
    if (code.length > 0) out[code] = raw[key]
  }
  return out
}

/**
 * 失败类别的冷却时长（纯函数）：cooldownByCode 按归一化错误码覆盖条目 cooldownMs。
 * 消息模式兜底命中的失败（how 形如 'pattern:...'）按模式归类，使「额度耗尽冷却 N 小时」
 * 对未归一化的上游文案（如 Codex 的 usage limit 自然语言报错）同样生效。
 */
const COOLDOWN_PATTERN_CLASS = {
  'insufficient balance': 'QUOTA',
  'insufficient_quota': 'QUOTA',
  'quota exceeded': 'QUOTA',
  'usage limit': 'QUOTA',
  'usage_limit': 'QUOTA',
  'balance': 'QUOTA',
  'websocket closed': 'TRANSPORT',
  'websocket error': 'TRANSPORT',
  'websocket': 'TRANSPORT',
  // 上游流错误（HTTP/2 流复位、网关 upstream_* 前缀码）：连接层中断，归 TRANSPORT
  // 才能吃到「原地重试 5 次 × 5s、预算 30s」，而不是落到 DEFAULT 的 1 次或直接切换。
  'http2': 'TRANSPORT',
  'upstream_': 'TRANSPORT',
  'rate limit': 'RATE_LIMIT',
  'token limit': 'RATE_LIMIT',
  'invalid api key': 'AUTH',
  'overloaded': 'SERVER',
}

/**
 * 消息模式兜底命中的**归一化错误码**（纯函数）：把 `failurePatterns` 命中的那句文案
 * 折算成 `COOLDOWN_PATTERN_CLASS` 里的类别码，使「切换重试分类」与「全量测试状态展示」
 * 与「冷却归类」三者用同一套判定，不再各自为政。
 *
 * 匹配取**最先出现**的模式（index 相同时取模式表顺序），因此
 * `insufficient_quota` 先于其子串 `quota` 命中时仍归 QUOTA。
 * 自定义模式（不在类别表里）按模式名派生一个稳定的大写码，至少不再退化成「未知错误」。
 * `patterns` 决定派生阶段用哪份模式表（默认取插件默认表，调用方可传生效配置里的那份）。
 */
function patternCodeFor(text, patterns) {
  const haystack = String(text ?? '').toLowerCase()
  if (haystack.length === 0) return undefined
  let best
  let bestAt = -1
  for (const pattern of Object.keys(COOLDOWN_PATTERN_CLASS)) {
    const at = haystack.indexOf(pattern)
    if (at < 0) continue
    if (bestAt < 0 || at < bestAt) {
      best = pattern
      bestAt = at
    }
  }
  if (best !== undefined) return COOLDOWN_PATTERN_CLASS[best]
  const extra = Array.isArray(patterns) ? patterns : DEFAULT_FAILURE_PATTERNS
  let derived
  let derivedAt = -1
  for (const pattern of extra) {
    const at = haystack.indexOf(String(pattern).toLowerCase())
    if (at < 0) continue
    if (derivedAt < 0 || at < derivedAt) {
      derived = pattern
      derivedAt = at
    }
  }
  if (derived === undefined) return undefined
  return String(derived).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
}

function cooldownMsFor(cooldownByCode, entryCooldownMs, code, how, patterns) {
  let klass = code
  if (typeof how === 'string' && how.indexOf('pattern:') === 0) {
    const pattern = how.slice(8)
    const mapped = COOLDOWN_PATTERN_CLASS[pattern]
    if (mapped !== undefined) klass = mapped
    else klass = patternCodeFor(pattern, patterns) ?? klass
  } else if (typeof how === 'string' && how.indexOf('effective:') === 0) {
    // 宿主没归一化（code 仍是 PI_AI_ERROR）、靠消息/状态码折算出类别的失败，
    // 必须按**折算后的类别**取冷却：否则 "You have hit your ChatGPT usage limit" 这类
    // 真实额度耗尽只吃到条目兜底的 60 秒，一分钟后又把死路由捡回来打一次。
    klass = how.slice('effective:'.length)
  }
  const specific = klass.length > 0 && isPlainObject(cooldownByCode) ? cooldownByCode[klass] : undefined
  if (positiveNumber(specific)) return specific
  return entryCooldownMs !== undefined ? entryCooldownMs : 60000
}

/** 插件自有设置文件：`$DSH_HOME/plugins/<namespace>/settings.json`。 */
function settingsFilePath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'plugins', SETTINGS_NAMESPACE, 'settings.json')
}

/** Read the credential-free local route layer produced by ptc-route-setup. */
function localRouteConfigPath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'plugins', SETTINGS_NAMESPACE, 'route-config.json')
}

function readLocalRouteConfig() {
  try {
    const parsed = JSON.parse(readFileSync(localRouteConfigPath(), 'utf8'))
    if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) return undefined
    const provider = isPlainObject(parsed.providerFailover) ? parsed.providerFailover : parsed
    const policy = isPlainObject(provider.failurePolicy) ? provider.failurePolicy : {}
    return {
      ...(Array.isArray(provider.tiers) ? { tiers: provider.tiers } : {}),
      ...(Array.isArray(policy.switchOn) ? { terminalCodes: policy.switchOn } : {}),
      ...(Number.isInteger(policy.maxSwitchesPerTurn) ? { maxSwitchesPerTurn: policy.maxSwitchesPerTurn } : {}),
      ...(isPlainObject(policy.cooldownByCode) ? { cooldownByCode: policy.cooldownByCode } : {}),
      ...(policy.switchOn?.includes('POLICY') ? { policyMode: 'switch' } : {}),
    }
  } catch {
    return undefined
  }
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

/**
 * 取值版的正数判定：合法时返回该数值本身，否则 undefined。
 * 与 `positiveNumber`（布尔谓词）区分开——重试策略里需要拿到数值而不是 true/false。
 */
function positiveValue(value) {
  return positiveNumber(value) ? value : undefined
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 当前排序配置对设置页暴露的单模型选择；空链返回 null。 */
function rankingModelOf(ranking) {
  if (!isPlainObject(ranking)) return null
  const provider = optionalString(ranking.provider)
  const model = optionalString(ranking.model)
  if (provider !== undefined && model !== undefined) return { provider, model }
  const first = Array.isArray(ranking.models) ? ranking.models[0] : undefined
  if (isPlainObject(first)) {
    const firstProvider = optionalString(first.provider)
    const firstModel = optionalString(first.model)
    if (firstProvider !== undefined && firstModel !== undefined) return { provider: firstProvider, model: firstModel }
  }
  return null
}

/** 仅复制排序配置，避免用户层覆盖污染 profile 基线。 */
function cloneRanking(ranking) {
  return JSON.parse(JSON.stringify(ranking))
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
/**
 * 归一化 retryPolicies：每个类别只取已知整数/有限数字段，未知字段忽略。
 * 未声明的类别退回 DEFAULT_CONFIG 的该类别策略；一个类别都没有时仍是完整表。
 */
function normalizeRetryPolicies(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const result = {}
  const keys = new Set([...Object.keys(DEFAULT_CONFIG.retryPolicies), ...Object.keys(source)])
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) continue
    const upper = key.toUpperCase()
    const fallback = DEFAULT_CONFIG.retryPolicies[upper] ?? DEFAULT_CONFIG.retryPolicies.DEFAULT
    const input = isPlainObject(source[key]) ? source[key] : isPlainObject(source[upper]) ? source[upper] : {}
    const declared = Object.keys(input).length > 0
    const policy = {}
    policy.attempts = Number.isInteger(input.attempts) ? Math.max(0, input.attempts) : declared ? 0 : fallback.attempts
    if (policy.attempts > 0) {
      policy.delayMs = positiveValue(input.delayMs) ?? fallback.delayMs ?? 5000
      policy.budgetMs = positiveValue(input.budgetMs) ?? fallback.budgetMs ?? policy.delayMs * policy.attempts
      const window = positiveValue(input.observationWindowMs) ?? fallback.observationWindowMs
      if (window !== undefined) policy.observationWindowMs = window
    }
    result[upper] = policy
  }
  return result
}

function normalizeConfig(raw) {
  const errors = []
  const input = isPlainObject(raw) ? raw : {}
  // policy 模式解析：`policyMode` 优先；否则按旧字段 `policyFailover` 推导（显式 true→switch，
  // 显式 false→off），两者都未给出时用默认 same。
  const requestedPolicyMode = optionalString(input.policyMode)
  let policyMode
  if (requestedPolicyMode !== undefined) policyMode = requestedPolicyMode
  else if (input.policyFailover === false) policyMode = 'off'
  else if (input.policyFailover === true) policyMode = 'switch'
  else policyMode = DEFAULT_CONFIG.policyMode
  const config = {
    enabled: input.enabled === undefined ? DEFAULT_CONFIG.enabled : input.enabled === true,
    policyFailover: policyMode !== 'off',
    policyMode,
    maxPolicyRetriesPerStep: input.maxPolicyRetriesPerStep === undefined ? DEFAULT_CONFIG.maxPolicyRetriesPerStep : input.maxPolicyRetriesPerStep,
    retryPolicies: normalizeRetryPolicies(input.retryPolicies),
    terminalCodes: new Set((strings(input.terminalCodes).length > 0 ? strings(input.terminalCodes) : DEFAULT_TERMINAL_CODES).map((code) => code.toUpperCase())),
    failurePatterns: (strings(input.failurePatterns).length > 0 ? strings(input.failurePatterns) : DEFAULT_FAILURE_PATTERNS).map((pattern) => pattern.toLowerCase()),
    // 生效的失败原因表（内置表 + 配置追加）。放归一化结果里，使「判定」与「展示」同源：
    // 设置页/通知用哪张表，与运行期用的是同一份。
    failureReasons: mergeFailureReasons(input.failureReasons, errors),
    minSwitchIntervalMs: input.minSwitchIntervalMs === undefined ? DEFAULT_CONFIG.minSwitchIntervalMs : input.minSwitchIntervalMs,
    maxSwitchesPerTurn: input.maxSwitchesPerTurn === undefined ? DEFAULT_CONFIG.maxSwitchesPerTurn : input.maxSwitchesPerTurn,
    cooldownByCode: normalizeCooldownByCode(input.cooldownByCode),
    probeTarget: input.probeTarget === undefined ? DEFAULT_CONFIG.probeTarget : input.probeTarget === true,
    keyResetAt: optionalString(input.keyResetAt) ?? DEFAULT_CONFIG.keyResetAt,
    startup: { preferTier: 0 },
    ranking: {
      mode: 'keywords',
      timeoutMs: DEFAULT_CONFIG.ranking.timeoutMs,
      cacheTtlMs: DEFAULT_CONFIG.ranking.cacheTtlMs,
      provider: '',
      model: '',
      sameTierFirst: false,
    },
    tiers: [],
  }

  if (typeof config.minSwitchIntervalMs !== 'number' || Number.isFinite(config.minSwitchIntervalMs) !== true || config.minSwitchIntervalMs < 0) errors.push('minSwitchIntervalMs must be a non-negative number (0 disables the interval guard)')
  if (!Number.isInteger(config.maxSwitchesPerTurn) || config.maxSwitchesPerTurn < 1) errors.push('maxSwitchesPerTurn must be a positive integer')
  for (const [key, policy] of Object.entries(config.retryPolicies ?? {})) {
    if (!Number.isInteger(policy.attempts) || policy.attempts < 0) errors.push('retryPolicies.' + key + '.attempts must be a non-negative integer')
    if (policy.attempts > 0) {
      for (const field of ['delayMs', 'budgetMs', 'observationWindowMs']) {
        const value = policy[field]
        if (value === undefined) continue
        if (typeof value !== 'number' || Number.isFinite(value) !== true || value <= 0) errors.push('retryPolicies.' + key + '.' + field + ' must be a positive finite number')
      }
      if (typeof policy.budgetMs === 'number' && typeof policy.delayMs === 'number' && policy.budgetMs < policy.delayMs) errors.push('retryPolicies.' + key + '.budgetMs must be >= delayMs (otherwise no retry can ever run)')
    }
  }
  if (input.cooldownByCode !== undefined) {
    if (!isPlainObject(input.cooldownByCode)) errors.push('cooldownByCode must be an object mapping failure codes to milliseconds')
    else for (const key of Object.keys(input.cooldownByCode)) {
      if (!positiveNumber(input.cooldownByCode[key])) errors.push('cooldownByCode.' + String(key) + ' must be a positive number of milliseconds')
    }
  }
  if (['same', 'switch', 'off'].indexOf(config.policyMode) < 0) errors.push('policyMode must be one of same|switch|off')
  if (!Number.isInteger(config.maxPolicyRetriesPerStep) || config.maxPolicyRetriesPerStep < 1) errors.push('maxPolicyRetriesPerStep must be a positive integer')
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
  if (ranking.sameTierFirst !== undefined && typeof ranking.sameTierFirst !== 'boolean') {
    errors.push('ranking.sameTierFirst must be a boolean')
  }
  config.ranking.sameTierFirst = ranking.sameTierFirst === true
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
      // WINDOWFIX: 可选显式上下文窗口声明（token 数），覆盖内置路由兜底表。
      let contextWindow
      if (rawEntry.contextWindow !== undefined) {
        if (!positiveNumber(rawEntry.contextWindow) || !Number.isInteger(rawEntry.contextWindow)) {
          errors.push('entry.contextWindow must be a positive integer (entry ' + String(id ?? '?') + ')')
        } else {
          contextWindow = rawEntry.contextWindow
        }
      }
      const compatible = isPlainObject(rawEntry.compatible) ? rawEntry.compatible : {}
      entries.push({
        id,
        route,
        model,
        contextWindow,
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

// WINDOWFIX: 已知路由的声明上下文窗口兜底表（条目未显式声明 contextWindow 时使用）。
// 数值来自 2026-10-21 运行时观测（request/context.contextWindow）；条目显式声明优先。
const BUILTIN_CONTEXT_WINDOWS = {
  'ais-2dsglm': 1000000,
  'opencode-go': 1000000,
  'kimi-coding': 262144,
  'codex-relay': 500000,
  'openai-codex': 500000,
}

// WINDOWFIX: 条目生效窗口 = 显式 contextWindow > 内置路由兜底 > undefined（未知不参与溢出切换）。
function declaredContextWindow(entry) {
  const explicit = entry?.contextWindow
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit
  const builtin = BUILTIN_CONTEXT_WINDOWS[entry?.route]
  return typeof builtin === 'number' && builtin > 0 ? builtin : undefined
}

// WINDOWFIX: 识别上游包装成 invalid_request_error 的上下文溢出文案
// （实证：kimi 400 "Your request exceeded k3-256k model token limit: 262144"）。
const CONTEXT_OVERFLOW_MESSAGE_PATTERN = /token limit|maximum context length|context length|too many tokens|context window exceeded/i

/**
 * 该失败是否属于「可切换」，并给设置页一个明确的“不切换原因”。
 * 内容/安全策略拒绝必须先于通用 INVALID_REQUEST 判断：它不是请求参数问题。
 * 命中 policy 时由调用方按 `policyMode` 决定动作（same 原地重试 / switch 切 provider /
 * off 交回宿主）；本函数只回答“是否对 policy 已完成处理接管”，因此 `off` 返回 hit:false。
 */
function isSwitchable(config, code, message) {
  const normalized = typeof code === 'string' ? code.toUpperCase() : ''
  const haystack = (String(message ?? '') + ' ' + normalized).toLowerCase()
  const policyCodes = new Set(['CONTENT_POLICY_VIOLATION', 'MODERATION_BLOCKED', 'PROMPT_BLOCKED', 'SAFETY'])
  const policyPatterns = ['usage policy', 'content policy', 'safety policy', 'potentially violating', 'prompt was flagged']
  if (policyCodes.has(normalized) || policyPatterns.some((pattern) => haystack.includes(pattern))) {
    const policyMode = config.policyMode ?? (config.policyFailover === false ? 'off' : 'same')
    if (policyMode === 'off') {
      return {
        hit: false,
        category: 'policy',
        reason: '提示词被上游内容/安全策略拒绝；policyMode=off 时不介入，交回宿主处理（请修改提示词后重试）。',
      }
    }
    return { hit: true, how: 'policy:prompt', category: 'switchable', policy: true }
  }
  // WINDOWFIX: 上下文超限不再一律「不切换」——换 key 确实无效，但切换到**声明窗口更大**
  // 的候选有效（含压缩自救：compaction 请求走同一 failover 面）。无更大窗口候选时由调用方忽略。
  if (normalized === 'CONTEXT_WINDOW_EXCEEDED') {
    return { hit: true, how: 'window:overflow', category: 'context-window' }
  }
  if (normalized === 'INVALID_REQUEST') {
    if (CONTEXT_OVERFLOW_MESSAGE_PATTERN.test(String(message ?? ''))) {
      return { hit: true, how: 'window:overflow-400', category: 'context-window' }
    }
    return { hit: false, category: 'invalid-request', reason: '请求参数无效；切换密钥无效，请修正请求配置。' }
  }
  if (normalized === 'UNSUPPORTED_REASONING_EFFORT') {
    return { hit: false, category: 'configuration', reason: '模型不支持当前推理档位；请关闭推理档位或选择兼容模型。' }
  }
  if (config.terminalCodes.has(normalized)) return { hit: true, how: 'code:' + normalized, category: 'switchable' }
  // 未归一化（空码 / PI_AI_ERROR）时先折算生效码再判：宿主把链路中断、网关自定义码、
  // 空体 5xx 都留在 PI_AI_ERROR 里，只查原始码会让这些故障既不重试也不切换。
  // 与全量测试展示走同一个 effectiveFailureCode，避免「状态页说会切换、实际不动」。
  const effective = effectiveFailureCode(normalized, message, config.failurePatterns)
  if (effective !== normalized && config.terminalCodes.has(effective)) {
    return { hit: true, how: 'effective:' + effective, category: 'switchable' }
  }
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
  TRANSPORT: '传输中断',
  CONTEXT_WINDOW_EXCEEDED: '上下文超限',
  INVALID_REQUEST: '请求无效',
  UNSUPPORTED_REASONING_EFFORT: '推理档位不支持',
}

/**
 * 文案里出现的**已知 HTTP 错误状态码**（纯函数）。仅用于「编码未归一化」时的兜底归类：
 * 只认下表里的码，不做任意三位数匹配——`connect ETIMEDOUT 10.0.0.5:443`、端口号、字节数
 * 都不该被当成状态码。取**最先出现**的那个码。
 */
const HTTP_ERROR_STATUSES = new Set([400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 501, 502, 503, 504, 529])

function firstHttpErrorStatus(text) {
  const matcher = /\b(\d{3})\b/g
  let match
  while ((match = matcher.exec(text)) !== null) {
    const value = Number(match[1])
    if (HTTP_ERROR_STATUSES.has(value)) return value
  }
  return undefined
}

/**
 * HTTP 状态码 → 归一化错误类别码（纯函数）。只映射**该类别在本插件里可切换**的码，
 * 其余（400/404/413/422…）返回 undefined，交回原有判定，不擅自扩大切换面。
 * 与 `firstHttpErrorStatus` 配套，用于「宿主把上游 HTTP 故障留在 PI_AI_ERROR 里」的兜底。
 */
function statusCodeToClass(status) {
  if (status >= 500) return 'SERVER'
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  return undefined
}

/**
 * 一次失败的**生效类别码**（纯函数）：归一化码优先；宿主未归一化时（空码 / `PI_AI_ERROR`）
 * 依次用 `failurePatterns` 消息兜底、HTTP 状态码兜底，都认不出来才退回原始码。
 *
 * 切换/重试判定与全量测试展示**必须共用这一个函数**：否则会出现「设置页说会切换、
 * 实际没切换」这类展示与行为不一致（PI_AI_ERROR 不在宿主默认重试码表里，
 * 展示与判定一旦分叉，用户看到的状态就没有意义）。
 */
function effectiveFailureCode(code, message, patterns) {
  const raw = typeof code === 'string' ? code.toUpperCase() : ''
  if (raw !== '' && raw !== 'PI_AI_ERROR') return raw
  const text = String(message ?? '')
  const mapped = patternCodeFor(text, patterns)
  if (mapped !== undefined) return mapped
  const status = firstHttpErrorStatus(text.toLowerCase())
  const fromStatus = status === undefined ? undefined : statusCodeToClass(status)
  return fromStatus ?? raw
}

/**
 * 把一次探测失败的编码/消息归类成可展示状态（纯函数）。
 * 归一化编码优先；编码未归一化（或根本为空）时，与「切换判定」走同一套 `failurePatterns`
 * 消息兜底：命中即按映射出的类别码展示（usage limit → 额度不足、WebSocket error → 传输中断），
 * 不再让 `PI_AI_ERROR` 一律显示成「未知错误」——那种展示会掩盖真实的额度/链路故障。
 * 最后才退回超时/中断关键词与「未知错误」。
 *
 * 第四个参数 `reasons` 是生效的失败原因表（`config.failureReasons`）。给了它，**AUTH 族**的
 * 展示就不再一律写「凭据无效」——401/403 里既有余额不足也有模型未授权，是全量测试最容易
 * 误导用户的一处（`status` 保持原码不变，只细化给人看的 label；QUOTA 等原有标签一律不动）。
 */
function classifyProbeFailure(code, message, patterns, reasons) {
  const normalized = typeof code === 'string' ? code.toUpperCase() : ''
  const haystack = (String(message ?? '') + ' ' + normalized).toLowerCase()
  const detail = String(message ?? '').slice(0, 200)
  const unknownCode = normalized === '' || normalized === 'PI_AI_ERROR'
  const patternsFor = Array.isArray(patterns) && patterns.length > 0 ? patterns : DEFAULT_FAILURE_PATTERNS
  /** AUTH 族：原文能分辨出具体原因时用它，分辨不出才退回按码的保守标签。 */
  const refineAuthLabel = (statusCode) => {
    if (reasons === undefined) return undefined
    if (statusCode !== 'AUTH' && statusCode !== 'INVALID_CREDENTIAL' && statusCode !== 'MISSING_CREDENTIAL') return undefined
    const reason = failureReasonFor(statusCode, message, reasons)
    if (reason.id === statusCode || reason.id === 'UNKNOWN') return undefined
    return reason.label
  }
  if (unknownCode) {
    // 与切换/重试判定共用 effectiveFailureCode：模式兜底 → HTTP 状态码兜底。
    // 不为未知码臆造标签——effectiveFailureCode 认不出来时仍返回原码，落回下面的「未知错误」。
    const mapped = effectiveFailureCode(normalized, message, patternsFor)
    const mappedLabel = PROBE_STATUS_LABELS[mapped]
    if (mappedLabel !== undefined) return { status: mapped, label: refineAuthLabel(mapped) ?? mappedLabel, message: detail }
  }
  if (haystack.includes('timeout') || haystack.includes('timed out') || haystack.includes('aborted')) {
    return { status: 'TIMEOUT', label: '超时/无响应', message: detail.length > 0 ? detail : 'no response in time' }
  }
  // 传输层中断与切换判定对齐：宿主未归一化的 "WebSocket closed 1000" 会落到 PI_AI_ERROR，
  // 这里按文案兜底展示为「传输中断」，避免全量测试把它误报成「未知错误」。
  if (haystack.includes('websocket closed') || haystack.includes('other side closed')) {
    return { status: 'TRANSPORT', label: '传输中断', message: detail.length > 0 ? detail : 'connection closed mid-stream' }
  }
  const label = PROBE_STATUS_LABELS[normalized]
  if (label !== undefined) return { status: normalized, label: refineAuthLabel(normalized) ?? label, message: detail }
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
  const localConfig = readLocalRouteConfig()
  const effectiveRawConfig = localConfig === undefined ? rawConfig : { ...rawConfig, ...localConfig }
  try {
    // TEMP DIAGNOSTIC (remove after diagnosing sameTierFirst)
    const fs = require$1 !== undefined ? undefined : undefined
    writeFileSync(join(homedir(), '.dsh', 'failover-config-dump.json'), JSON.stringify({
      at: new Date().toISOString(),
      rawKeys: isPlainObject(rawConfig) ? Object.keys(rawConfig) : typeof rawConfig,
      rawRanking: isPlainObject(rawConfig) ? rawConfig.ranking : undefined,
      localRanking: isPlainObject(localConfig) ? localConfig.ranking : undefined,
      effectiveRanking: isPlainObject(effectiveRawConfig) ? effectiveRawConfig.ranking : undefined,
      effectiveHasRetryPolicies: isPlainObject(effectiveRawConfig) && effectiveRawConfig.retryPolicies !== undefined,
      effectiveTierCount: isPlainObject(effectiveRawConfig) && Array.isArray(effectiveRawConfig.tiers) ? effectiveRawConfig.tiers.length : undefined,
    }, null, 2) + '\n', 'utf8')
  } catch (error) { /* diagnostic only */ }
  const { value: config, errors } = normalizeConfig(effectiveRawConfig)
  // rankingModel 是用户层单模型覆盖；null/未设置时恢复这份 profile 基线，保留原有 ranking.models 链。
  const profileRanking = cloneRanking(config.ranking)
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
    /**
     * 会话可见通知：sessionId -> record[]（内存态，上限 200/会话，最新的在前）。
     * 与 switchLog 的区别：按会话隔离、带 noticeId 与 turn/step、并可落盘补拉，
     * 供 `/provider-failover/notices` 与插件对话区面板展示。
     */
    notices: new Map(),
    /** 通知自增序号，用于生成稳定 noticeId 与游标 */
    noticeSeq: 0,
    /** 每一轮通知生成时 memory 上限 */
    noticeLimit: 200,
    /** 生效的按类别重试策略（配置实时同步） */
    retryPolicies: DEFAULT_CONFIG.retryPolicies,
    /**
     * 每会话最近一次插件覆盖前的 base 路由：sessionKey -> { provider, model, at }。
     * 仅与后续 base 比较以识别外部路由变化；不能写入 failover/startup/pin 目标，
     * 否则重试仍携带旧 base 时会被误报为“手动切换”。这不是最终下发配置。
     */
    lastObservedBase: new Map(),
    /** 已单独通知、等待 base 首次跟上的测试 pin；弱引用不延长 pin 生命周期。 */
    unobservedTestSelections: new WeakSet(),
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
    /**
     * WINDOWFIX-FLOOR: 每会话的上下文窗口下限（token 数）。会话在某窗口 W 的模型上发生
     * 上下文溢出时提升到 W（取历史最大值），此后该会话的**所有**候选切换（不限失败类别）
     * 都过滤掉声明窗口 ≤ 下限的条目，防止非溢出失败（QUOTA/SERVER/TRANSPORT）把大上下文
     * 会话降级进装不下的窗口。sessionKey -> { window, at }；TTL 到期或容量淘汰后失效
     * （会话压缩变小后允许回到小窗口模型）。
     */
    contextFloors: new Map(),
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
    state.unobservedTestSelections.add(pin)
    pushLog({ at: pin.at, kind: 'test-switch', from: '(session selection)', to: pin.route + '/' + pin.model, tier: pin.tier, code: 'TEST', trigger: reason, turn: 0, step: 0 })
    pushNotice({
      at: pin.at,
      session: sessionId,
      kind: 'manual-switch',
      stage: 'selected',
      code: 'TEST',
      trigger: reason,
      fromRoute: '(session selection)',
      fromModel: '',
      toRoute: pin.route,
      toModel: pin.model,
      tier: pin.tier,
      reasoningEffort: pin.reasoningEffort,
      turn: 0,
      step: 0,
    })
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
      const cls = classifyProbeFailure(streamFailure.code, streamFailure.message, config.failurePatterns, config.failureReasons)
      return { ...base, ok: false, ms, status: cls.status, label: cls.label, message: cls.message }
    }
    if (thrown !== undefined) {
      const cls = classifyProbeFailure(thrown.code, messageOf(thrown), config.failurePatterns, config.failureReasons)
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
      record = { attempted: new Set(), target: undefined, switches: 0, policyRetries: 0, needs: { tools: false, images: false }, at: Date.now() }
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

  const agentDefaultModel = () => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('agentDefaultModel') ?? undefined
    } catch (error) {
      return undefined
    }
  }

  function currentDefaultModel() {
    const service = agentDefaultModel()
    if (service === undefined || typeof service.currentSelection !== 'function' || typeof service.saveSelection !== 'function') return { available: false, value: null, error: '宿主 agentDefaultModel 服务未装载' }
    try {
      const current = service.currentSelection()
      const provider = optionalString(current?.provider)
      const model = optionalString(current?.model)
      if (provider === undefined || model === undefined) return { available: false, value: null, error: '宿主默认模型选择不完整' }
      return { available: true, value: { provider, model }, error: undefined }
    } catch (error) {
      return { available: false, value: null, error: '读取宿主默认模型失败：' + messageOf(error) }
    }
  }

  function applyRankingModelOverride(value) {
    if (isPlainObject(value)) {
      const provider = optionalString(value.provider)
      const model = optionalString(value.model)
      if (provider !== undefined && model !== undefined) {
        // 用户层模型选择落为单元素 ranking.models，保持 provider/model 兼容字段同步。
        config.ranking.provider = provider
        config.ranking.model = model
        config.ranking.models = [{ provider, model }]
        return
      }
      warnConfigOnce('ignoring invalid rankingModel user setting; restoring profile ranking')
    }
    config.ranking = cloneRanking(profileRanking)
  }

  function cooling(route, now) {
    const health = state.routeHealth.get(route)
    return health !== undefined && health.coolingUntil > now
  }

  /**
   * 写入路由冷却：**只延长，不缩短**。
   * 同一路由可能先被判 QUOTA（5 小时），随后一条 SERVER 只值 30 分钟——旧实现直接 set()，
   * 会把额度已死的路由 30 分钟后又放回候选，于是「打一次再冻一次」。取两者较晚者即消除该抖动。
   */
  function coolDownRoute(route, now, ms, code, message) {
    if (typeof route !== 'string' || route.length === 0) return
    const until = now + (positiveNumber(ms) === true ? ms : 60000)
    const previous = state.routeHealth.get(route)
    const coolingUntil = previous !== undefined && Number.isFinite(previous.coolingUntil) && previous.coolingUntil > until ? previous.coolingUntil : until
    state.routeHealth.set(route, {
      coolingUntil,
      code: typeof code === 'string' ? code : '',
      message: String(message ?? '').slice(0, 200),
      at: now,
    })
  }

  /** 当前冷却中的路由摘要（给人看，不进模型上下文）：route(CODE, 至 HH:MM:SS)。 */
  function coolingSummary(now) {
    const items = []
    for (const [route, health] of state.routeHealth) {
      if (health === undefined || !(health.coolingUntil > now)) continue
      const until = new Date(health.coolingUntil).toLocaleTimeString('zh-CN', { hour12: false })
      items.push(route + '(' + String(health.code ?? '') + ', 至 ' + until + ')')
    }
    return items.length === 0 ? '(无)' : items.join(', ')
  }

  function pushLog(record) {
    state.switchLog.unshift(record)
    if (state.switchLog.length > 50) state.switchLog.length = 50
  }

  /**
   * 追加一条「会话内可见」的转移通知。
   *
   * 与 pushLog 的差别是它会：
   *  - 按 sessionId 归档（记忆 + JSONL 落盘），因此环形缓冲轮转后仍可回看；
   *  - 带稳定 noticeId 与 turn/step，客户端可按游标去重补拉；
   *  - 只记录事实：`stage` 区分「已选中下一尝试目标(selected)」与「启动对齐(startup-align)」，
   *    绝不把选中候选写成「已成功」。
   *
   * 落盘失败只警告，绝不影响切换本身。
   */
  function noticeFile() {
    const base = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    return join(base, 'plugins', SETTINGS_NAMESPACE, 'notices.jsonl')
  }

  function pushNotice(input) {
    const key = sessionKeyOf(input.session)
    state.noticeSeq += 1
    const notice = {
      noticeId: 'n' + String(state.noticeSeq) + '-' + String(input.at) + '-' + Math.random().toString(36).slice(2, 8),
      at: input.at,
      session: key,
      kind: input.kind,
      stage: input.stage,
      code: input.code === undefined ? '' : String(input.code),
      trigger: input.trigger === undefined ? '' : String(input.trigger),
      fromRoute: input.fromRoute,
      fromModel: input.fromModel,
      toRoute: input.toRoute,
      toModel: input.toModel,
      tier: input.tier,
      reasoningEffort: input.reasoningEffort,
      turn: input.turn,
      step: input.step,
      // 原因细分：`AUTH` 这类归一化码不足以决定处置（充值 vs 换来源 vs 重新登录），
      // 展示必须带上「具体是哪种」。reasonId 稳定可断言，reasonLabel 是给人看的中文。
      reasonId: input.reasonId,
      reasonLabel: input.reasonLabel,
      // 上游原文（脱敏 + 截断）。没有它，用户只看到「AUTH」无法自查；
      // 有它，余额不足会直接读出「用户剩余额度: ¥1.04」。凭据不会被带进来：
      // 走 sanitizeForRanking 的密钥形状抹除，且只保留前 FAILURE_DETAIL_LIMIT 字符。
      detail: input.detail === undefined ? '' : sanitizeForRanking(String(input.detail), FAILURE_DETAIL_LIMIT),
    }
    const list = state.notices.get(key) ?? []
    list.unshift(notice)
    if (list.length > state.noticeLimit) list.length = state.noticeLimit
    state.notices.set(key, list)
    if (state.notices.size > 64) {
      const oldest = state.notices.keys().next()
      if (oldest.done !== true && oldest.value !== key) state.notices.delete(oldest.value)
    }
    try {
      mkdirSync(dirname(noticeFile()), { recursive: true })
      appendFileSync(noticeFile(), JSON.stringify(notice) + '\n', 'utf8')
    } catch (error) {
      warnConfigOnce('notice log write failed: ' + messageOf(error))
    }
    return notice
  }

  /**
   * 失败类别的重试策略（切换 provider 之前的原地重试）。
   *
   * 类别划分（详见 DEFAULT_CONFIG.retryPolicies 注释）：
   *  - TRANSPORT / RATE_LIMIT / SERVER：等 delayMs 后原地重试，次数或预算用尽才切换；
   *  - QUOTA / AUTH / INVALID_CREDENTIAL / MISSING_CREDENTIAL / NO_ADAPTER：立即切换；
   *  - 其余（含 POLacy 之外的未归类错误）：按 DEFAULT 策略短暂重试。
   * 未配置策略时退回 DEFAULT_CONFIG，绝不因为缺配置而变成“永不重试”。
   */
  /**
   * 取该错误码的重试策略。
   *
   * 只有**显式列在 retryPolicies 里**的类别才重试；未列出的错误码一律按
   * `{ attempts: 0 }` 处理，即保持插件原有语义「立即切换」。这样新出现的错误码
   * 永远不会因为“默认值”而被静默改成先重试，也不会吞掉额度类（QUOTA）的立即切换。
   */
  function retryPolicyFor(rawCode) {
    const table = state.retryPolicies ?? DEFAULT_CONFIG.retryPolicies
    const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : ''
    if (code.length === 0) return { attempts: 0 }
    return isPlainObject(table[code]) ? table[code] : { attempts: 0 }
  }

  /** 重试类别标签（仅用于日志/通知）；未配置的码返回 'none'。 */
  function retryClassOf(rawCode) {
    const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : ''
    const table = state.retryPolicies ?? DEFAULT_CONFIG.retryPolicies
    return code.length > 0 && isPlainObject(table[code]) ? code : 'none'
  }

  /** 是否在「观测窗口内」失败：连接活过该窗口才断，视为路由已不可用，直接切换。 */
  function withinObservationWindow(policy, since) {
    if (policy?.observationWindowMs === undefined) return true
    if (typeof since !== 'number' || Number.isFinite(since) !== true) return true
    return Date.now() - since <= policy.observationWindowMs
  }

  /**
   * 切换 provider 之前的原地重试闸门。返回 undefined 表示放行给后面的切换逻辑。
   *
   * 预算按类别记在 (turn, step) 记账里：`record.retryBudget[CLASS] = { spent, attempts, startedAt }`；
   * 宿主重试仍走 `{ kind: 'retry' }`（交回宿主重放同一请求），插件只负责按类别判断
   * 「还能重试几次」与「该等多久」。
   */
  async function transientRetryGate(payload, failure, record, sessionId, turn, step, failedRoute, code) {
    const cls = retryClassOf(code)
    const policy = retryPolicyFor(code)
    if (policy === undefined || !Number.isInteger(policy.attempts) || policy.attempts <= 0) return undefined
    if (record.retryBudget === undefined) record.retryBudget = {}
    const budget = record.retryBudget[cls] ?? { spent: 0, attempts: 0, startedAt: Date.now() }
    record.retryBudget[cls] = budget
    if (budget.attempts >= policy.attempts) return undefined
    const delayMs = policy.delayMs ?? 0
    const budgetMs = policy.budgetMs ?? delayMs * policy.attempts
    if (budget.spent + delayMs > budgetMs) return undefined
    if (cls === 'TRANSPORT' && withinObservationWindow(policy, budget.startedAt) !== true) {
      warnConfigOnce('transient retry skipped for ' + String(failedRoute) + ': failure arrived after the observation window (' + String(policy.observationWindowMs) + 'ms)')
      return undefined
    }
    budget.spent += delayMs
    budget.attempts += 1
    const at = Date.now()
    // 原地重试同样带原因细分：TRANSPORT/RATE_LIMIT 类下「限流」与「链路抖动」的等待预期不同。
    const retryReason = failureReasonFor(code, failure?.message, config.failureReasons)
    pushNotice({
      at,
      session: sessionId,
      kind: 'retry',
      stage: 'retrying',
      code,
      trigger: 'retry:' + cls + ' ' + String(budget.attempts) + '/' + String(policy.attempts) + ' after ' + String(delayMs) + 'ms',
      fromRoute: failedRoute,
      fromModel: '',
      toRoute: failedRoute,
      toModel: '',
      tier: -1,
      turn,
      step,
      reasonId: retryReason.id,
      reasonLabel: retryReason.label,
      detail: failure?.message,
    })
    pushLog({
      at,
      kind: 'transient-retry',
      from: failedRoute,
      to: failedRoute,
      tier: 0,
      code,
      trigger: 'retry:' + cls,
      attempt: budget.attempts,
      turn,
      step,
    })
    console.warn('[dsh-provider-failover] transient retry ' + cls + ' ' + String(budget.attempts) + '/' + String(policy.attempts) + ' on ' + (failedRoute.length > 0 ? failedRoute : '(unknown)') + ' after ' + String(delayMs) + 'ms (spent ' + String(budget.spent) + '/' + String(budgetMs) + 'ms, turn ' + String(turn) + ' step ' + String(step) + ')')
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return { kind: 'retry' }
  }

  /** 该会话的通知列表（最新在前）；`after` 为 noticeId，返回它之后（更新）的通知。 */
  function noticesOf(session, limit, after) {
    const list = state.notices.get(sessionKeyOf(session)) ?? []
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, state.noticeLimit) : 20
    if (after === undefined || after === null || after === '') return list.slice(0, cap)
    const index = list.findIndex((item) => item.noticeId === after)
    return (index < 0 ? list : list.slice(0, index)).slice(0, cap)
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

  // WINDOWFIX-FLOOR: 会话上下文下限——溢出后该会话的一切候选切换都避开 ≤ 下限的窗口。
  const CONTEXT_FLOOR_TTL_MS = 2 * 60 * 60 * 1000
  const CONTEXT_FLOOR_MAX_ENTRIES = 256

  function sessionContextFloor(sessionId, now) {
    const key = sessionKeyOf(sessionId)
    const entry = state.contextFloors.get(key)
    if (entry === undefined) return undefined
    if (now - entry.at > CONTEXT_FLOOR_TTL_MS) {
      state.contextFloors.delete(key)
      return undefined
    }
    return entry.window
  }

  function raiseContextFloor(sessionId, window, now) {
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return
    const key = sessionKeyOf(sessionId)
    const prev = state.contextFloors.get(key)
    state.contextFloors.set(key, { window: Math.max(window, prev?.window ?? 0), at: now })
    if (state.contextFloors.size > CONTEXT_FLOOR_MAX_ENTRIES) {
      let oldestKey
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [k, v] of state.contextFloors) {
        if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
      }
      if (oldestKey !== undefined) state.contextFloors.delete(oldestKey)
    }
  }

  /**
   * 在给定档位序列内按既有顺序选第一条可用候选：逐条跳过未启用条目、已尝试、冷却中、
   * 能力不兼容、不可解析的候选（与 v3.4.0 的 pickCandidate 过滤顺序完全一致）。
   */
  async function pickInTiers(tiers, record, now, context, signal, excludeRoute, minContextWindow) {
    for (const tier of tiers) {
      if (tier.enabled !== true) continue
      for (const entry of await entriesInOrder(tier, context, signal, excludeRoute)) {
        if (entry.enabled !== true) continue
        // 失败路由本身不是自己的候选。旧实现靠「选候选之前先把失败路由写进冷却」间接排除它；
        // 冷却写入已移到选中候选之后（agent/request-error），因此这里必须显式排除，
        // 否则 no-candidate 之后的下一步会把自己的失败路由又选回来。
        if (typeof excludeRoute === 'string' && excludeRoute.length > 0 && entry.route === excludeRoute) continue
        if (record.attempted.has(attemptKey(entry.id, entry.route, activeRefOf(entry.route)))) continue
        if (cooling(entry.route, now)) continue
        // WINDOWFIX: 溢出切换只在「声明窗口严格更大」的候选间选择；窗口未知者不参与。
        if (minContextWindow !== undefined) {
          const entryWindow = declaredContextWindow(entry)
          if (entryWindow === undefined || entryWindow <= minContextWindow) continue
        }
        if (compatible(entry, record.needs) !== true) continue
        if ((await serviceable(entry, signal)) !== true) continue
        return { tier, entry }
      }
    }
    return undefined
  }

  async function pickCandidate(sessionId, turn, step, context, signal, excludeRoute, minContextWindow) {
    const record = stepState(sessionId, turn, step)
    const now = Date.now()
    // WINDOWFIX-FLOOR: 会话下限（历史溢出窗口）与本次显式最小窗口取较大者，对所有失败类别的切换生效。
    const floorWindow = sessionContextFloor(sessionId, now)
    const effectiveMinWindow = Math.max(minContextWindow ?? 0, floorWindow ?? 0)
    const minWindow = effectiveMinWindow > 0 ? effectiveMinWindow : undefined
    // 同族互备（ranking.sameTierFirst，默认 false）：失败路由能在档位表中定位时，先只扫它
    // 所落的那一档；该档内选不到才退回全档扫描。开关关闭、失败路由为空或无法定位时
    // 只有一条路径，与旧行为逐字等价。不触碰 key 轮换、冷却写入、record.switches 与限流判定。
    if (config.ranking.sameTierFirst === true && typeof excludeRoute === 'string' && excludeRoute.length > 0) {
      const failedTier = tierOf(config, excludeRoute)
      if (failedTier !== undefined) {
        const sameTier = await pickInTiers([failedTier], record, now, context, signal, excludeRoute, minWindow)
        if (sameTier !== undefined) return sameTier
      }
    }
    return pickInTiers(config.tiers, record, now, context, signal, excludeRoute, minWindow)
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
    // 只观测本插件覆盖前的 base（下游 hook 返回值），不是最终请求配置。
    // 故障转移/启动对齐/pin 只覆盖返回值，不改此观测基线。
    // 测试切换已有独立通知，base 跟上当前 pin 时不再重复报告手动切换。
    if (base !== null && typeof base === 'object' && typeof base.provider === 'string' && typeof base.model === 'string') {
      const observedKey = sessionKeyOf(sessionIdOf(payload?.agent))
      const observed = { provider: base.provider, model: base.model, at: Date.now() }
      const previous = state.lastObservedBase.get(observedKey)
      const testPin = activePin(sessionIdOf(payload?.agent))
      const followsTestSelection = testPin !== undefined && state.unobservedTestSelections.has(testPin) && testPin.route === observed.provider && testPin.model === observed.model
      if (followsTestSelection) state.unobservedTestSelections.delete(testPin)
      if (previous !== undefined && !followsTestSelection && (previous.provider !== observed.provider || previous.model !== observed.model)) {
        pushNotice({
          at: observed.at,
          session: sessionIdOf(payload?.agent),
          kind: 'manual-switch',
          stage: 'selected',
          code: 'MANUAL',
          trigger: 'observed:route-change',
          fromRoute: previous.provider,
          fromModel: previous.model,
          toRoute: observed.provider,
          toModel: observed.model,
          tier: -1,
          reasoningEffort: typeof base.reasoningEffort === 'string' ? base.reasoningEffort : undefined,
          turn: payload?.turn ?? 0,
          step: payload?.step ?? 0,
        })
      }
      state.lastObservedBase.set(observedKey, observed)
      if (state.lastObservedBase.size > 128) {
        const oldest = state.lastObservedBase.keys().next()
        if (oldest.done !== true && oldest.value !== observedKey) state.lastObservedBase.delete(oldest.value)
      }
    }
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
          pushNotice({
            at: Date.now(),
            session: sessionId,
            kind: 'startup-align',
            stage: 'selected',
            code: 'STARTUP_ALIGN',
            trigger: 'startup:preferTier=' + String(config.startup.preferTier),
            fromRoute: base.provider,
            fromModel: base.model,
            toRoute: picked.entry.route,
            toModel: picked.entry.model,
            tier: picked.tier.tier,
            turn,
            step,
          })
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
    // 归一化前先做一次生效码判定：宿主把带关闭码的链路中断、网关自定义码、空体 5xx
    // 都留在通用 PI_AI_ERROR 里，只有靠 failurePatterns（+ 已知 HTTP 状态码）才能识别成
    // TRANSPORT/SERVER 等类别；重试分类与切换分类都用它。
    // 注意：isSwitchable 只回 how（`pattern:<模式>`），不回类别码——类别码必须由
    // effectiveFailureCode 折算，否则 effectiveCode 永远退回 PI_AI_ERROR，
    // 重试策略会错用 DEFAULT（1 次）而不是该类别的策略（如 TRANSPORT 的 5 次）。
    // 该函数同时被全量测试的展示逻辑调用，保证「设置页说会切换」与实际行为一致。
    const rawCode = typeof failure?.code === 'string' ? failure.code.toUpperCase() : ''
    const effectiveCode = effectiveFailureCode(rawCode, failure?.message, config.failurePatterns)
    // 原因细分与「生效码」并行计算：`AUTH` 已归一化时 effectiveFailureCode 会直接短路返回，
    // 原文就不再参与判定——这正是「提示只写 AUTH、看不出余额不足」的成因。所以这里对
    // **原始报文**独立跑一次 failureReasonFor，只用它填展示字段，不参与任何切换决策。
    const reason = failureReasonFor(effectiveCode, failure?.message, config.failureReasons)
    // ① 未归一化的错误码（如 PI_AI_ERROR，带 "WebSocket error" 消息）也要按类别重试：
    //    先把消息兜底判定的命中码取回来，再决定「原地重试」还是「切换 provider」。
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
        // 即便不切换，也要能看出细分原因：例如「上下文超限」与「额度不足」都可能落到
        // 这里，而两者的下一步动作完全不同。
        reasonId: reason.id,
        reasonLabel: reason.label,
        turn,
        step,
      })
      return next()
    }

    const record = stepState(sessionId, turn, step)
    const failedRoute = typeof payload?.provider === 'string' ? payload.provider : ''
    const code = typeof failure?.code === 'string' ? failure.code.toUpperCase() : ''

    const now = Date.now()

    // ① policy 类失败（policyMode='same'，默认）：保留当前 provider/model，在同一
    //    (turn, step) 内原地重试。不轮换 key、不切换 provider、不给路由冷却——策略拒绝与
    //    凭据/额度/过载无关，换 provider 或换 key 都治不了；宿主会重新组装同一请求，
    //    插件无法在上游改写 prompt（见 README「policy 失败」）。重试次数受
    //    `maxPolicyRetriesPerStep` 约束，耗尽后保持当前 provider/model 交回宿主。
    //    该分支独立于 provider 切换的最小间隔与单 turn 上限（那两项只约束 provider 切换）。
    if (decision.policy === true && (config.policyMode ?? 'same') === 'same') {
      const used = record.policyRetries ?? 0
      if (used < config.maxPolicyRetriesPerStep) {
        record.policyRetries = used + 1
        pushLog({
          at: now,
          kind: 'policy-retry',
          from: failedRoute,
          to: failedRoute,
          tier: 0,
          code: typeof failure?.code === 'string' ? failure.code : '',
          trigger: decision.how,
          attempt: record.policyRetries,
          turn,
          step,
        })
        console.warn('[dsh-provider-failover] policy retry ' + String(record.policyRetries) + '/' + String(config.maxPolicyRetriesPerStep) + ' on ' + (failedRoute.length > 0 ? failedRoute : '(unknown)') + ' (' + decision.how + ', turn ' + String(turn) + ' step ' + String(step) + ')')
        return { kind: 'retry' }
      }
      pushIgnored({
        at: now,
        session: sessionKey === '-' ? '' : sessionKey,
        provider: failedRoute,
        category: 'policy',
        reason: 'policy 同 provider 重试已达上限（maxPolicyRetriesPerStep=' + String(config.maxPolicyRetriesPerStep) + '）；保持当前 provider/model 交回宿主。',
        code: typeof failure?.code === 'string' ? failure.code : '',
        message: String(failure?.message ?? '').slice(0, 200),
        turn,
        step,
      })
      return next()
    }

    if (now - (state.lastSwitchAt.get(sessionKey) ?? 0) < config.minSwitchIntervalMs) return next()
    if (record.switches >= config.maxSwitchesPerTurn) return next()

    // ⓪ 按类别决定「先原地重试」还是「直接切换」：
    //    额度/凭据类 attempts=0 → 立即切换；TRANSPORT/RATE_LIMIT/SERVER → 等 delayMs 重试，
    //    次数或预算用尽才落到下面的 key 轮换与 provider 切换。
    //    放在凭据轮换之前：凭据类失败优先换 key（同路由同模型），一类失败只吃一层策略。
    const retried = await transientRetryGate(payload, failure, record, sessionId, turn, step, failedRoute, effectiveCode)
    if (retried !== undefined) return retried

    const failedLoc = failedRoute.length > 0 ? locateRoute(config, failedRoute) : undefined
    const failedEntry = failedLoc?.entry
    const activeRef = failedRoute.length > 0 ? activeRefOf(failedRoute) : undefined
    if (failedEntry !== undefined) record.attempted.add(attemptKey(failedEntry.id, failedRoute, activeRef))

    // ① 凭据类失败：先在该条目内换 key（同路由、同模型，只改 apiKeyEnv 引用）。
    //    只有归一化到凭据类编码才走这里；消息模式兜底命中的失败按非凭据类处理。
    if (failedEntry !== undefined && hasRotation(failedEntry) && (KEY_ROTATION_CODES.has(code) || KEY_ROTATION_CODES.has(effectiveCode))) {
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
        // 换 key 是「凭据/授权」类失败的第一处置，必须在会话里可见并说明原因：
        // 余额不足换 key 可能有效（另一把 key 挂在有钱的账户上），模型未授权换 key
        // 也可能有效（另一把 token 有该模型权限）——所以两者都先换 key，但用户要知道
        // 到底是哪一种，才能判断「换 key 会不会有用」。
        pushNotice({
          at: now,
          session: sessionId,
          kind: 'failover',
          stage: 'selected',
          code,
          trigger: 'key-rotate:' + String(activeRef ?? '(unset)') + ' -> ' + rotatedTo,
          fromRoute: failedRoute,
          fromModel: typeof payload?.model === 'string' ? payload.model : '',
          toRoute: failedRoute,
          toModel: failedEntry.model,
          tier: failedLoc.tier.tier,
          turn,
          step,
          reasonId: reason.id,
          reasonLabel: reason.label,
          detail: failure?.message,
        })
        console.warn('[dsh-provider-failover] key rotate ' + failedEntry.id + '@' + failedRoute + ' ' + String(activeRef ?? '(unset)') + ' -> ' + rotatedTo + ' (' + decision.how + ', turn ' + String(turn) + ' step ' + String(step) + ')')
        return { kind: 'retry' }
      }
      // 无可用下一把（全部失效 / 未配置 / 写入失败）→ 落到 provider 切换路径。
    }

    // ② provider 切换：先选候选，**选中之后**才把失败路由写进冷却（见下方 coolDownRoute 调用）。
    //    旧实现先写冷却再选候选，于是「根本没切走」的失败也把该路由冻住 N 分钟：
    //    2026-10-23 实测一串网络抖动逐个冻住 tier1/tier2 五条路由，等 kimi 报额度耗尽时
    //    整条梯子都在冷却里，QUOTA 无从切换、只能原地失败（举证与后续修正见
    //    docs/ptc/reports/failover-kimi-quota-20261023.md）。
    //    选候选时失败路由由 pickInTiers 的 excludeRoute 显式排除，不再依赖冷却副作用。
    const coolingMs = cooldownMsFor(config.cooldownByCode, failedEntry?.cooldownMs, code, decision.how, config.failurePatterns)

    // WINDOWFIX: 上下文超限切换——只在「声明窗口严格更大」的候选间选择；失败条目窗口未知
    // 或不存在更大候选时，保持原「不切换」行为并明确记录原因。
    const overflowSwitch = decision.category === 'context-window'
    const failedWindow = overflowSwitch && failedEntry !== undefined ? declaredContextWindow(failedEntry) : undefined
    // WINDOWFIX-FLOOR: 溢出即精确信号（context > 失败模型窗口），提升该会话的下限。
    if (overflowSwitch && failedWindow !== undefined) {
      raiseContextFloor(sessionId, failedWindow, now)
    }
    if (overflowSwitch && failedWindow === undefined) {
      pushIgnored({
        at: now,
        session: sessionKey === '-' ? '' : sessionKey,
        provider: failedRoute,
        category: 'context',
        reason: '上下文超限，但失败条目未声明上下文窗口，无法判定更大窗口候选；保持当前模型，请先压缩上下文。',
        code,
        message: String(failure?.message ?? '').slice(0, 200),
        turn,
        step,
      })
      return next()
    }
    const context = String(failure?.code ?? '') + ' ' + String(failure?.message ?? '') + (record.needs.tools ? ' tools' : '') + (record.needs.images ? ' images' : '')
    const picked = await pickCandidate(sessionId, turn, step, context, payload?.signal, failedRoute, overflowSwitch ? failedWindow : undefined)
    if (picked === undefined) {
      // 没有可用候选也是决策，必须留痕：否则“什么都没发生”在证据里和“没触发”无法区分。
      pushIgnored({
        at: Date.now(),
        session: sessionKey === '-' ? '' : sessionKey,
        provider: failedRoute,
        category: 'no-candidate',
        reason: '可切换失败已确认，但档位表中没有可用候选（已尝试/冷却中/能力不兼容/不可解析）。',
        code: typeof failure?.code === 'string' ? failure.code : '',
        message: String(failure?.message ?? '').slice(0, 200),
        turn,
        step,
      })
      // 只进内存 ignored 环等于没留痕：调用方只看得到一条 bare 上游错误，会误判成「failover 失效」。
      // 因此同样落一条会话可见通知（notices.jsonl + 会话通知条），把「无候选」和「谁在冷却」说清楚。
      pushNotice({
        at: now,
        session: sessionId,
        kind: 'exhausted',
        stage: 'exhausted',
        code: typeof failure?.code === 'string' ? failure.code : '',
        trigger: 'no-candidate',
        fromRoute: failedRoute,
        fromModel: typeof payload?.model === 'string' ? payload.model : '',
        toRoute: '',
        toModel: '',
        tier: 0,
        turn,
        step,
        reasonId: reason.id,
        reasonLabel: reason.label,
        detail: '无可用候选；冷却中：' + coolingSummary(now),
      })
      return next()
    }

    // 真的选到了下一跳，才把失败路由写进冷却（只延长、不缩短）。
    coolDownRoute(failedRoute, now, coolingMs, code, failure?.message)
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
    // 通知里写实际会下发的推理层级：agent/request 侧同样经 reconcileEffort 解析，
    // 这里解析一次避免面板显示与真实请求不一致。
    const noticeEffort = await reconcileEffort(picked.entry, undefined, payload?.signal)
    pushNotice({
      at: now,
      session: sessionId,
      kind: 'failover',
      stage: 'selected',
      code: typeof failure?.code === 'string' ? failure.code : '',
      trigger: decision.how,
      fromRoute: failedRoute,
      fromModel: typeof payload?.model === 'string' ? payload.model : '',
      toRoute: picked.entry.route,
      toModel: picked.entry.model,
      tier: picked.tier.tier,
      reasoningEffort: noticeEffort,
      turn,
      step,
      reasonId: reason.id,
      reasonLabel: reason.label,
      detail: failure?.message,
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
        sameTierFirst: config.ranking.sameTierFirst === true,
        keyResetAt: config.keyResetAt,
        keysByEntry: {},
      },
    })
    const sync = (value, source) => {
      config.enabled = value.enabled === true
      config.minSwitchIntervalMs = value.minSwitchIntervalMs
      config.maxSwitchesPerTurn = value.maxSwitchesPerTurn
      config.startup.preferTier = value.startupPreferTier
      applyRankingModelOverride(value.rankingModel)
      config.ranking.mode = value.rankingMode
      if (parseClock(value.keyResetAt) !== undefined) config.keyResetAt = value.keyResetAt
      else console.warn('[dsh-provider-failover] ignoring invalid keyResetAt (expected HH:MM): ' + String(value.keyResetAt))
      state.keysByEntry = isPlainObject(value.keysByEntry) ? value.keysByEntry : {}
      state.retryPolicies = config.retryPolicies ?? DEFAULT_CONFIG.retryPolicies
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

    /** 实时读取 provider 与模型目录；单个 provider 的模型失败只标注该项。 */
    const modelCatalog = async () => {
      const service = llm()
      if (service === undefined || typeof service.listProviders !== 'function') return []
      let providers
      try {
        providers = service.listProviders()
      } catch (error) {
        console.warn('[dsh-provider-failover] listProviders for catalog failed: ' + messageOf(error))
        return []
      }
      const result = []
      for (const info of Array.isArray(providers) ? providers : []) {
        const id = optionalString(info?.id)
        if (id === undefined) continue
        const item = { id, name: String(info?.name ?? id), models: [] }
        if (typeof service.listModels !== 'function') {
          item.error = '宿主 llm 未提供 listModels()'
          result.push(item)
          continue
        }
        try {
          const models = await service.listModels(id)
          item.models = (Array.isArray(models) ? models : []).map((model) => ({
            id: String(model?.id ?? ''),
            name: String(model?.name ?? model?.id ?? ''),
          })).filter((model) => model.id.length > 0 && model.name.length > 0)
        } catch (error) {
          item.error = messageOf(error)
        }
        result.push(item)
      }
      return result
    }

    function validateModelSelection(field, value, catalog) {
      if (value === null) return { value: null, errors: [] }
      if (!isPlainObject(value)) return { value: null, errors: [field + ' 必须是 { provider, model } 或 null'] }
      const provider = optionalString(value.provider)
      const model = optionalString(value.model)
      if (provider === undefined || model === undefined) return { value: null, errors: [field + ' 的 provider 和 model 必须同时填写'] }
      const providerInfo = catalog.find((item) => item.id === provider)
      if (providerInfo === undefined) return { value: null, errors: [field + ' provider 不存在：' + provider] }
      if (providerInfo.error !== undefined) return { value: null, errors: [field + ' provider 的模型目录不可用：' + providerInfo.error] }
      if (providerInfo.models.some((item) => item.id === model) !== true) return { value: null, errors: [field + ' model 不存在：' + provider + '/' + model] }
      return { value: { provider, model }, errors: [] }
    }

    const rankingModelSnapshot = () => rankingModelOf(config.ranking)

    const snapshot = async () => {
      await refreshRefInfo()
      const directory = providerDirectory()
      const defaultModel = currentDefaultModel()
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
        rankingModel: rankingModelSnapshot(),
        defaultModel: defaultModel.value,
        defaultModelAvailable: defaultModel.available,
        defaultModelError: defaultModel.error,
        enabled: config.enabled,
        policyMode: config.policyMode,
        maxPolicyRetriesPerStep: config.maxPolicyRetriesPerStep,
        /** 当前生效的按类别重试策略（切换 provider 之前的原地重试） */
        retryPolicies: config.retryPolicies,
        /** 同族互备优先开关 */
        sameTierFirst: config.ranking.sameTierFirst === true,
        editable: {
          enabled: config.enabled,
          minSwitchIntervalMs: config.minSwitchIntervalMs,
          maxSwitchesPerTurn: config.maxSwitchesPerTurn,
          startupPreferTier: config.startup.preferTier,
          rankingMode: config.ranking.mode,
          rankingModel: rankingModelSnapshot(),
          defaultModel: defaultModel.value,
          defaultModelAvailable: defaultModel.available,
          defaultModelError: defaultModel.error,
          sameTierFirst: config.ranking.sameTierFirst === true,
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
      /** 会话可见通知：每会话条数（完整内容走 GET /provider-failover/notices） */
      notices: [...state.notices.entries()].map(([session, list]) => ({ session, count: list.length })),
        ignored: state.ignoredLog.slice(0, LOG_LIMIT),
        lastProbe: state.lastProbe,
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        cooling: [...state.routeHealth.entries()].map(([route, health]) => ({ route: route, code: health.code, until: health.coolingUntil })),
      }
    }
    register(ROUTE_BASE + '/catalog', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
      try {
        sendJson(res, 200, { providers: await modelCatalog() })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: '读取模型目录失败：' + messageOf(error) })
      }
    })
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
      for (const key of ['enabled', 'minSwitchIntervalMs', 'maxSwitchesPerTurn', 'startupPreferTier', 'rankingMode', 'keyResetAt', 'keysByEntry', 'rankingModel']) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
      }
      const hasRankingModel = Object.prototype.hasOwnProperty.call(body, 'rankingModel')
      const hasDefaultModel = Object.prototype.hasOwnProperty.call(body, 'defaultModel')
      let catalog
      let defaultSelection
      if (hasRankingModel || hasDefaultModel) {
        catalog = await modelCatalog()
        if (hasRankingModel) {
          const checked = validateModelSelection('排序模型', body.rankingModel, catalog)
          if (checked.errors.length > 0) return sendJson(res, 400, { ok: false, error: checked.errors.join('; '), errors: checked.errors })
          patch.rankingModel = checked.value
        }
        if (hasDefaultModel) {
          // 宿主默认模型配置是必填完整选择且没有 clear API；null 因此表示“不改动当前默认模型”。
          const checked = validateModelSelection('默认模型', body.defaultModel, catalog)
          if (checked.errors.length > 0) return sendJson(res, 400, { ok: false, error: checked.errors.join('; '), errors: checked.errors })
          defaultSelection = checked.value
          if (defaultSelection !== null) {
            const service = agentDefaultModel()
            if (service === undefined || typeof service.saveSelection !== 'function') return sendJson(res, 503, { ok: false, error: '宿主 agentDefaultModel 服务未装载，无法保存默认模型' })
          }
        }
      }
      if (Object.keys(patch).length === 0 && hasDefaultModel !== true) return sendJson(res, 400, { ok: false, error: 'no editable field in request' })
      if (patch.keyResetAt !== undefined && parseClock(patch.keyResetAt) === undefined) return sendJson(res, 400, { ok: false, error: 'keyResetAt must be HH:MM in 24-hour local time' })
      const keyErrors = validateKeysByEntry(patch.keysByEntry)
      if (keyErrors.length > 0) return sendJson(res, 400, { ok: false, error: keyErrors.join('; '), errors: keyErrors })
      if (hasDefaultModel && defaultSelection !== null) {
        try {
          await agentDefaultModel().saveSelection(defaultSelection)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: '保存默认模型失败：' + messageOf(error) })
        }
      }
      if (Object.keys(patch).length > 0) {
        try {
          await state.settings.update(patch)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: messageOf(error) })
        }
        // watch 回调是异步投递的；这里立即重放已落盘设置，保证响应里的 editable 已是新值。
        if (typeof state.syncSettings === 'function') state.syncSettings(state.settings.get(), 'updated')
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
    /**
     * 会话内可见的转移通知：{sessionId?, limit?, after?}。
     * 缺 sessionId 时用最近一次活跃会话。返回 {ok, sessionId, notices, latest, count}。
     * 只读、同源限定；通知本身不进入会话 surface，也不进入模型上下文。
     */
    register(ROUTE_BASE + '/notices', async (req, res) => {
      if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      const wanted = url.searchParams.get('sessionId')
      const sessionId = wanted !== null && wanted.length > 0
        ? wanted
        : state.lastSessionId !== undefined ? String(state.lastSessionId.id) : undefined
      if (sessionId === undefined) return sendJson(res, 200, { ok: true, sessionId: null, notices: [], latest: null, count: 0 })
      const limitRaw = Number.parseInt(String(url.searchParams.get('limit') ?? ''), 10)
      const after = url.searchParams.get('after') ?? undefined
      const all = noticesOf(sessionId, undefined, undefined)
      const notices = noticesOf(sessionId, Number.isFinite(limitRaw) ? limitRaw : 20, after === undefined ? undefined : String(after))
      return sendJson(res, 200, {
        ok: true,
        sessionId: String(sessionKeyOf(sessionId)),
        notices,
        latest: all.length > 0 ? all[0] : null,
        count: all.length,
      })
    })
  })

  const configured = config.tiers.map((tier) => String(tier.tier) + (tier.enabled ? '' : '(off)') + ':' + tier.entries.map((entry) => entry.id).join(',')).join(' | ')
  console.log('[dsh-provider-failover] ready: ' + configured + ' | startup.preferTier=' + String(config.startup.preferTier) + ' | ranking=' + config.ranking.mode + ' | policyMode=' + config.policyMode)
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
export const __test = { parseRanking, hashKey, sanitizeForRanking, isSwitchable, tierOf, orderEntries, isCredentialRef, parseClock, nextResetAt, selectNextRef, resolveTestTarget, unsupportedReasoningEffort, classifyProbeFailure, cooldownMsFor, patternCodeFor, effectiveFailureCode, failureReasonFor, mergeFailureReasons, DEFAULT_FAILURE_REASONS, declaredContextWindow }
