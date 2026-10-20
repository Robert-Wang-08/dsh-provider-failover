/**
 * M1 冒烟测试（不依赖 dsh 运行时）：校验 index.js 的导出形状与配置归一化。
 *   node probe/smoke-config.mjs
 *
 * 设置走插件自有文件 scope：每个用例在独立的临时 DSH_HOME 里跑 apply
 * （settingsFilePath 在 apply 内读取该变量），断言落盘内容后整体清理，
 * 绝不触碰真实 ~/.dsh。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, defaultConfig, name, inject, normalize, __test } from '../index.js'

// 真实设置文件的守卫基线：整个探针期间它的存在性必须保持不变。
const realSettingsFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', 'provider-failover', 'settings.json')
const realFileExisted = existsSync(realSettingsFile)

const failures = []
const check = (label, ok, extra) => {
  if (ok === true) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra))
  }
}

// 每个用例独立 DSH_HOME：仅包住 apply 调用（路径在该时刻解析），返回设置文件位置。
const probeHomes = []
function isolatedApply(ctx, rawConfig, seed) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-keypool-probe-'))
  probeHomes.push(home)
  const settingsFile = join(home, 'plugins', 'provider-failover', 'settings.json')
  if (seed !== undefined) {
    mkdirSync(dirname(settingsFile), { recursive: true })
    writeFileSync(settingsFile, JSON.stringify(seed, null, 2) + '\n', 'utf8')
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(ctx, rawConfig)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  return { home, settingsFile }
}
function cleanupHomes() {
  for (const home of probeHomes) rmSync(home, { recursive: true, force: true })
}
const readScope = (settingsFile) => (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : undefined)

console.log('exports:')
check('name', name === 'dsh-provider-failover', name)
check('inject is empty', JSON.stringify(inject) === '[]', JSON.stringify(inject))
check('apply is function', typeof apply === 'function')
check('defaultConfig is function', typeof defaultConfig === 'function')

console.log('defaults:')
const defaults = defaultConfig()
check('one example tier (disabled, zero-intervention)', defaults.tiers.length === 1 && defaults.tiers[0].enabled === false, JSON.stringify(defaults.tiers))
check('example entry is placeholder', defaults.tiers[0].entries.length === 1 && defaults.tiers[0].entries[0].id === 'example' && defaults.tiers[0].entries[0].route === 'example-provider', JSON.stringify(defaults.tiers[0].entries))
check('startup preferTier 默认 0（关闭启动对齐，保持会话选择）', defaults.startup.preferTier === 0, String(defaults.startup.preferTier))
check('terminal codes include SERVER + RATE_LIMIT', defaults.terminalCodes.includes('SERVER') && defaults.terminalCodes.includes('RATE_LIMIT'))
check('message fallbacks include Codex usage-limit wording', defaults.failurePatterns.includes('usage limit') && defaults.failurePatterns.includes('usage_limit'))
const switchableShape = (value) => ({ terminalCodes: new Set(value.terminalCodes), failurePatterns: value.failurePatterns })
// 命中方式说明：消息模式兜底（`pattern:<模式>`）只在生效码折算不出可切换类别时才会走到
// （例如自定义模式未登记类别）。usage limit / websocket / http2 这些**已登记类别**的模式
// 会先经 effectiveFailureCode 折算成 QUOTA / TRANSPORT，再按终止码集合命中，故 how 为 `effective:<CODE>`；
// 保留 `pattern:` 前缀的断言用于验证表外模式这条路径本身没断。
check('Codex natural-language usage limit is switchable despite PI_AI_ERROR', __test.isSwitchable(switchableShape(defaults), 'PI_AI_ERROR', 'Codex error: The usage limit has been reached').how === 'effective:QUOTA')
check('Codex snake-case usage limit is switchable despite PI_AI_ERROR', __test.isSwitchable(switchableShape(defaults), 'PI_AI_ERROR', 'usage_limit_reached').how === 'effective:QUOTA')
check('default terminal codes include TRANSPORT', defaults.terminalCodes.includes('TRANSPORT'))
check('message fallbacks include WebSocket-close wording', defaults.failurePatterns.includes('websocket closed'))
check('WebSocket close with code is switchable despite PI_AI_ERROR', __test.isSwitchable(switchableShape(defaults), 'PI_AI_ERROR', 'WebSocket closed 1000').how === 'effective:TRANSPORT')
check('normalized TRANSPORT failure is switchable', __test.isSwitchable(switchableShape(defaults), 'TRANSPORT', 'socket hang up').how === 'code:TRANSPORT')
// 2026-10-15：relay 上游 HTTP/2 流复位（SSE error 事件 → PI_AI_ERROR）。宿主两条规则都不命中，
// 必须靠插件的 'http2' / 'upstream_' 模式兜底，且归类必须是 TRANSPORT（5 次原地重试 + 观测窗口），
// 否则既无宿主重试也无插件重试，整轮直接终止。
const HTTP2_FAILURE = 'Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed'
check('message fallbacks include upstream http2 wording', defaults.failurePatterns.includes('http2') && defaults.failurePatterns.includes('upstream_'))
check('upstream http2 stream error is switchable despite PI_AI_ERROR', __test.isSwitchable(switchableShape(defaults), 'PI_AI_ERROR', HTTP2_FAILURE).how === 'effective:TRANSPORT')
check('upstream http2 stream error maps to TRANSPORT (not DEFAULT)', __test.patternCodeFor(HTTP2_FAILURE, switchableShape(defaults).failurePatterns) === 'TRANSPORT')
// 展示与判定必须同源：effectiveFailureCode 是设置页状态与切换/重试共用的那一份折算。
check('effectiveFailureCode: http2 流错误 → TRANSPORT', __test.effectiveFailureCode('PI_AI_ERROR', HTTP2_FAILURE, switchableShape(defaults).failurePatterns) === 'TRANSPORT')
check('effectiveFailureCode: 空体 5xx → SERVER', __test.effectiveFailureCode('PI_AI_ERROR', 'codex-relay API error (502): 502 status code (no body)', switchableShape(defaults).failurePatterns) === 'SERVER')
check('effectiveFailureCode: usage limit → QUOTA', __test.effectiveFailureCode('PI_AI_ERROR', 'The usage limit has been reached', switchableShape(defaults).failurePatterns) === 'QUOTA')
check('effectiveFailureCode: 认不出来时保留原码', __test.effectiveFailureCode('PI_AI_ERROR', 'connect ETIMEDOUT 10.0.0.5:443', switchableShape(defaults).failurePatterns) === 'PI_AI_ERROR')
check('effectiveFailureCode: 已归一化码不被消息覆盖', __test.effectiveFailureCode('SERVER', 'The usage limit has been reached', switchableShape(defaults).failurePatterns) === 'SERVER')
check('prompt policy refusal is handled by default', __test.isSwitchable(switchableShape(defaults), 'PI_AI_ERROR', 'Invalid prompt: your prompt was flagged as potentially violating our usage policy').how === 'policy:prompt')
check('prompt policy refusal can remain terminal explicitly', __test.isSwitchable({ ...switchableShape(defaults), policyFailover: false }, 'PI_AI_ERROR', 'Invalid prompt: your prompt was flagged as potentially violating our usage policy').category === 'policy')
check('policyFailover:true keeps the legacy switch semantics', __test.isSwitchable({ ...switchableShape(defaults), policyFailover: true }, 'PI_AI_ERROR', 'flagged as potentially violating our usage policy').hit === true)
check('policyMode:off suppresses the policy takeover', __test.isSwitchable({ ...switchableShape(defaults), policyMode: 'off' }, 'PI_AI_ERROR', 'flagged as potentially violating our usage policy').category === 'policy')
check('no credential field anywhere', JSON.stringify(defaults).toLowerCase().indexOf('apikeyenv') < 0)

console.log('normalize:')
const good = normalize({ tiers: [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'r', model: 'm', cooldownMs: 5000 }] }] })
check('accepts a minimal valid table', good.errors.length === 0, JSON.stringify(good.errors))
check('defaults applied (ranking.keys→mode stays keywords)', good.value.ranking.mode === 'keywords')

const missingRoute = normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', model: 'm' }] }] })
check('rejects entry without route', missingRoute.errors.some((error) => error.includes('route is required')))

const badCooldown = normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r', model: 'm', cooldownMs: 0 }] }] })
check('rejects non-positive cooldownMs', badCooldown.errors.some((error) => error.includes('cooldownMs')))

console.log('cooldownByCode:')
const withCooldown = normalize({ cooldownByCode: { quota: 18000000, TRANSPORT: 5000 }, tiers: [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'r', model: 'm' }] }] })
check('cooldownByCode keys normalize to uppercase', withCooldown.errors.length === 0 && withCooldown.value.cooldownByCode.QUOTA === 18000000 && withCooldown.value.cooldownByCode.TRANSPORT === 5000, JSON.stringify(withCooldown.errors))
check('cooldownByCode defaults to an empty map', Object.keys(normalize({}).value.cooldownByCode).length === 0)
const badCooldownMap = normalize({ cooldownByCode: { QUOTA: -1 } })
check('rejects non-positive cooldownByCode value', badCooldownMap.errors.some((error) => error.includes('cooldownByCode')))
const badCooldownShape = normalize({ cooldownByCode: [1] })
check('rejects non-object cooldownByCode', badCooldownShape.errors.some((error) => error.includes('cooldownByCode')))
check('QUOTA code gets the category override', __test.cooldownMsFor({ QUOTA: 18000000 }, 60000, 'QUOTA', 'code:QUOTA') === 18000000)
check('usage-limit wording classifies as QUOTA for cooldown', __test.cooldownMsFor({ QUOTA: 18000000 }, 60000, 'PI_AI_ERROR', 'pattern:usage limit') === 18000000)
check('websocket-close wording classifies as TRANSPORT for cooldown', __test.cooldownMsFor({ QUOTA: 18000000, TRANSPORT: 3000 }, 60000, 'PI_AI_ERROR', 'pattern:websocket closed') === 3000)
check('unmapped code falls back to entry cooldownMs', __test.cooldownMsFor({ QUOTA: 18000000 }, 120000, 'SERVER', 'code:SERVER') === 120000)
check('no entry cooldownMs falls back to the 60s default', __test.cooldownMsFor({}, undefined, 'SERVER', 'code:SERVER') === 60000)

const dupId = normalize({ tiers: [{ tier: 1, entries: [{ id: 'x', route: 'r1', model: 'm' }, { id: 'x', route: 'r2', model: 'm' }] }] })
check('rejects duplicate entry id', dupId.errors.some((error) => error.includes('duplicate entry id')))

const badMode = normalize({ ranking: { mode: 'bogus' } })
check('rejects unknown ranking mode', badMode.errors.some((error) => error.includes('ranking.mode')))

const badTier = normalize({ startup: { preferTier: -1 } })
check('rejects negative preferTier', badTier.errors.some((error) => error.includes('startup.preferTier')))

const policyDefaults = normalize({})
check('policy defaults to same-provider retry', policyDefaults.value.policyMode === 'same' && policyDefaults.value.maxPolicyRetriesPerStep === 2, JSON.stringify({ mode: policyDefaults.value.policyMode, max: policyDefaults.value.maxPolicyRetriesPerStep }))
check('legacy policyFailover:true maps to switch', normalize({ policyFailover: true }).value.policyMode === 'switch')
check('legacy policyFailover:false maps to off', normalize({ policyFailover: false }).value.policyMode === 'off')
check('explicit policyMode wins over legacy field', normalize({ policyFailover: true, policyMode: 'same' }).value.policyMode === 'same')
check('rejects unknown policyMode', normalize({ policyMode: 'bogus' }).errors.some((error) => error.includes('policyMode')))
check('rejects non-positive maxPolicyRetriesPerStep', normalize({ maxPolicyRetriesPerStep: 0 }).errors.some((error) => error.includes('maxPolicyRetriesPerStep')))

const zeroInterval = normalize({ minSwitchIntervalMs: 0 })
check('accepts minSwitchIntervalMs 0 (guard off)', zeroInterval.errors.length === 0 && zeroInterval.value.minSwitchIntervalMs === 0, JSON.stringify(zeroInterval.errors))
check('rejects negative minSwitchIntervalMs', normalize({ minSwitchIntervalMs: -1 }).errors.some((error) => error.includes('minSwitchIntervalMs')))

console.log('entry.keys（同路由凭据引用轮换，opt-in）:')
check('entries without keys normalize to empty array', Array.isArray(good.value.tiers[0].entries[0].keys) && good.value.tiers[0].entries[0].keys.length === 0, JSON.stringify(good.value.tiers[0].entries[0]))
const withKeys = normalize({ tiers: [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['MY_KEY', 'MY_KEY_2'] }] }] })
check('accepts credential refs and preserves order', withKeys.errors.length === 0 && JSON.stringify(withKeys.value.tiers[0].entries[0].keys) === JSON.stringify(['MY_KEY', 'MY_KEY_2']), JSON.stringify(withKeys))
check('empty keys[] means no rotation', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r', model: 'm', keys: [] }] }] }).errors.length === 0)
check('rejects non-identifier keys item', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['not a ref'] }] }] }).errors.some((error) => error.includes('credential reference names')))
check('rejects numeric keys item', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: [7] }] }] }).errors.some((error) => error.includes('credential reference names')))
check('rejects duplicate ref within keys', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['K', 'K'] }] }] }).errors.some((error) => error.includes('duplicate credential reference')))
check('rejects non-array keys', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: 'K' }] }] }).errors.some((error) => error.includes('entry.keys must be an array')))
check('rejects ref reused across entries', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['K9'] }, { id: 'b', route: 'r2', model: 'm', keys: ['K9'] }] }] }).errors.some((error) => error.includes('each reference serves a single provider')))
check('ref uniqueness is global across tiers', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['K9'] }] }, { tier: 2, entries: [{ id: 'b', route: 'r2', model: 'm', keys: ['K9'] }] }] }).errors.some((error) => error.includes('each reference serves a single provider')))
check('distinct refs across entries are fine', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['K1'] }, { id: 'b', route: 'r3', model: 'm', keys: ['K2'] }] }] }).errors.length === 0)

console.log('keyResetAt:')
check('defaults to 06:00', normalize({}).value.keyResetAt === '06:00', normalize({}).value.keyResetAt)
check('accepts 04:30', normalize({ keyResetAt: '04:30' }).errors.length === 0)
check('rejects 6:00 (needs two digits)', normalize({ keyResetAt: '6:00' }).errors.some((error) => error.includes('keyResetAt')))
check('rejects 24:00', normalize({ keyResetAt: '24:00' }).errors.some((error) => error.includes('keyResetAt')))

console.log('key 轮换纯函数:')
const at = (h, m) => new Date(2026, 8, 22, h, m, 0, 0).getTime()
check('nextResetAt same day when before the clock', __test.nextResetAt('06:00', at(5, 0)) === at(6, 0))
check('nextResetAt next day when after the clock', __test.nextResetAt('06:00', at(7, 0)) === new Date(2026, 8, 23, 6, 0, 0, 0).getTime())
check('parseClock accepts 23:59 and rejects 24:00', __test.parseClock('23:59') !== undefined && __test.parseClock('24:00') === undefined)
check('isCredentialRef accepts POSIX identifiers only', __test.isCredentialRef('MY_KEY_2') === true && __test.isCredentialRef('my-key-2') === false && __test.isCredentialRef('2KEY') === false)
const K3 = ['A', 'B', 'C']
check('selectNextRef moves forward', __test.selectNextRef(K3, 'A', () => true) === 'B')
check('selectNextRef wraps around', __test.selectNextRef(K3, 'C', () => true) === 'A')
check('selectNextRef skips unusable', __test.selectNextRef(K3, 'A', (ref) => ref !== 'B') === 'C')
check('selectNextRef single ref has no next', __test.selectNextRef(['A'], 'A', () => true) === undefined)
check('selectNextRef starts at the first ref when active is unknown', __test.selectNextRef(K3, undefined, () => true) === 'A')

console.log('parseRanking (整词匹配):')
const two = [{ id: 'q' }, { id: 'a' }]
check('rejects substring false positive ("ok" has no id)', __test.parseRanking('ok', two) === undefined, JSON.stringify(__test.parseRanking('ok', two)))
check('single-letter id "o" no longer matches "ok"', __test.parseRanking('ok', [{ id: 'o' }]) === undefined)
check('matches whole tokens in order', JSON.stringify(__test.parseRanking('a, q', two)) === JSON.stringify(['a', 'q']))
check('appends unmentioned ids in declared order', JSON.stringify(__test.parseRanking('a', two)) === JSON.stringify(['a', 'q']))
check('ignores ids inside longer words', __test.parseRanking('raise the cap', [{ id: 'ais' }]) === undefined)
check('tolerates punctuation/newlines', JSON.stringify(__test.parseRanking('1. ais\n2. kimi', [{ id: 'ais' }, { id: 'kimi' }])) === JSON.stringify(['ais', 'kimi']))

console.log('ranking 有序候选:')
const defaults2 = defaultConfig()
check('默认无排序链（models 未设置）', defaults2.ranking.models === undefined || defaults2.ranking.models.length === 0, JSON.stringify(defaults2.ranking.models))
check('单条 provider/model 兼容为链', JSON.stringify(normalize({ ranking: { provider: 'p', model: 'm' } }).value.ranking.models) === JSON.stringify([{ provider: 'p', model: 'm' }]))
check('models 列表按序保留', JSON.stringify(normalize({ ranking: { models: [{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }] } }).value.ranking.models) === JSON.stringify([{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }]))
check('列表项缺 model 报错', normalize({ ranking: { models: [{ provider: 'a' }] } }).errors.some((error) => error.includes('ranking.models')))
check('只给 provider 不给 model 报错', normalize({ ranking: { provider: 'p' } }).errors.some((error) => error.includes('must be set together')))

console.log('sanitizeForRanking:')
check('redacts key-like fragments', __test.sanitizeForRanking('failed with sk-abcdef123456789', 200).indexOf('sk-abcdef123456789') < 0)
check('truncates to limit', __test.sanitizeForRanking('x'.repeat(500), 100).length === 100)

console.log('apply 假 ctx（webServer/provider 目录关联，设置走隔离文件 scope）:')
const makeCtx = (providers, options) => {
  const opts = options ?? {}
  const routes = {}
  const mutations = []
  const handlers = {}
  const disposers = []
  const providerSection = { providers: opts.providerSection ?? {} }
  const refInfo = opts.refInfo ?? {}
  // 0.2 SettingsForms 形状：跨命名空间读走 describe()，写走 mutate()。
  const settingsProvider = {
    describe: () => [{ ns: 'llm-pi-ai', value: providerSection }],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  const credentials = { describe: async (ref) => refInfo[ref] ?? { configured: false } }
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    on: (event, fn) => { handlers[event] = fn },
    get: (n) => n === 'llm' ? providers : n === 'settings' ? settingsProvider : n === 'credentials' ? credentials : undefined,
    inject: (deps, cb) => {
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } } })
    },
  }
  return { ctx, routes, mutations, handlers, disposers }
}
const res1 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const env1 = makeCtx({ listProviders: () => [{ id: 'example-provider', name: 'Example' }, { id: 'other-provider', name: 'Other' }], listConfigurableProviders: () => [] })
Object.assign(env1, isolatedApply(env1.ctx, {}))
check('apply 只读不写盘（设置文件尚未创建）', !existsSync(env1.settingsFile))
check('注册 status/config/keys 三条路由', env1.routes['/provider-failover/status'] !== undefined && env1.routes['/provider-failover/config'] !== undefined && env1.routes['/provider-failover/keys'] !== undefined)
await env1.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res1)
check('status 暴露 writable（文件 scope 可写）', res1.body.writable === true, String(res1.body.writable))
await env1.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res1)
check('snapshot 用 route 名关联目录', res1.body.tiers[0].entries[0].route === 'example-provider' && res1.body.tiers[0].entries[0].registered === true, JSON.stringify(res1.body.tiers?.[0]))
check('snapshot 计算 unassigned/missing', Array.isArray(res1.body.providers.unassigned) && res1.body.providers.unassigned.some((p) => p.id === 'other-provider') && res1.body.providers.missing.length === 0, JSON.stringify(res1.body.providers))
const postReq = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ enabled: false, evil: 1 })) } }
const res2 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
await env1.routes['/provider-failover/config'](postReq, res2)
const written1 = readScope(env1.settingsFile)
check('/config 只接受白名单字段（仅 enabled 落盘）', res2.status === 200 && JSON.stringify(written1) === JSON.stringify({ enabled: false }), JSON.stringify(written1))
const res3 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const env3 = makeCtx({ listProviders: () => [], listConfigurableProviders: () => [] })
Object.assign(env3, isolatedApply(env3.ctx, {}))
await env3.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res3)
check('目录不可用时 providers=null 且不误标', res3.body.providers === null && res3.body.tiers[0].entries[0].registered === true, JSON.stringify(res3.body.providers) + ' ' + JSON.stringify(res3.body.tiers?.[0]?.entries?.[0]))

console.log('apply 假 ctx（凭据引用轮换路径）:')
const KEY_CONFIG = { keyResetAt: '06:00', tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm', keys: ['K1', 'K2'] }] }] }
const llmStub = { listProviders: () => [{ id: 'r1', name: 'R1' }], listConfigurableProviders: () => [] }
const failure = { failure: { code: 'AUTH', message: 'invalid api key' }, provider: 'r1', turn: 1, step: 1 }
const env4 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true, source: 'file' }, K2: { configured: true, source: 'file' } } })
Object.assign(env4, isolatedApply(env4.ctx, KEY_CONFIG))
const rotated = await env4.handlers['agent/request-error'](failure, async () => 'NEXT')
check('凭据类失败触发条目内 key 轮换并重试', rotated?.kind === 'retry', JSON.stringify(rotated))
check('轮换只写引用名（path/value）', JSON.stringify(env4.mutations) === JSON.stringify([{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'r1', 'apiKeyEnv'], value: 'K2' }] }]), JSON.stringify(env4.mutations))
const res4 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
await env4.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res4)
const logEntry = res4.body.switches.find((item) => item.kind === 'key-rotate')
check('审计记录 key-rotate（同路由，只换引用）', logEntry !== undefined && logEntry.from === 'r1' && logEntry.to === 'r1/m' && logEntry.key === 'K2' && logEntry.fromKey === 'K1', JSON.stringify(logEntry))
check('status 报告 key 引用状态（含 active/configured）', res4.body.tiers[0].entries[0].keys.length === 2 && res4.body.tiers[0].entries[0].keys[0].active === true && res4.body.tiers[0].entries[0].keys[1].configured === true, JSON.stringify(res4.body.tiers[0].entries[0]))
check('status 暴露 nextKeyResetAt', typeof res4.body.nextKeyResetAt === 'number')

const env5 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true, source: 'file' } } })
Object.assign(env5, isolatedApply(env5.ctx, KEY_CONFIG))
const skipped = await env5.handlers['agent/request-error'](failure, async () => 'NEXT')
check('未配置的备用引用被跳过并交回宿主', skipped === 'NEXT' && env5.mutations.length === 0, JSON.stringify(skipped) + ' ' + JSON.stringify(env5.mutations))

const env6 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true }, K2: { configured: true } } })
Object.assign(env6, isolatedApply(env6.ctx, KEY_CONFIG))
const overload = await env6.handlers['agent/request-error']({ failure: { code: 'SERVER', message: 'overloaded' }, provider: 'r1', turn: 1, step: 1 }, async () => 'NEXT')
check('过载不消耗 key 轮换（走 provider 切换）', env6.mutations.length === 0, JSON.stringify(env6.mutations))

const res7 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const manualReq = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ entry: 'ais', ref: 'K2' })) } }
const env7 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true }, K2: { configured: true } } })
Object.assign(env7, isolatedApply(env7.ctx, KEY_CONFIG))
await env7.routes['/provider-failover/keys'](manualReq, res7)
check('手工置位写入指定引用', res7.status === 200 && res7.body.ok === true && JSON.stringify(env7.mutations[0]?.ops?.[0]?.value) === '"K2"', JSON.stringify({ status: res7.status, mutations: env7.mutations }))
const res8 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const badReq = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ entry: 'ais', ref: 'NOT_DECLARED' })) } }
const env8 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true } } })
Object.assign(env8, isolatedApply(env8.ctx, KEY_CONFIG))
await env8.routes['/provider-failover/keys'](badReq, res8)
check('手工置位拒绝未声明的引用', res8.body.ok === false && env8.mutations.length === 0, JSON.stringify(res8.body))

for (const env of [env4, env5, env6, env7, env8]) for (const dispose of env.disposers) dispose()

console.log('apply 假 ctx（keysByEntry 界面配置与状态）:')
const TWO_ENTRIES = { tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm' }, { id: 'codex', route: 'r2', model: 'm' }] }] }
const statusOf = async (env) => {
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
  await env.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res)
  return res
}
const postConfig = async (env, body) => {
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
  await env.routes['/provider-failover/config'](req, res)
  return res
}

// a) 设置层 keys 覆盖 patch（patch 未声明 keys），并按需启用每日重置排程。
// 用户层 keysByEntry 预置进用例自己的设置文件，走真实的读取路径。
const env9 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true, source: 'file' }, K9: { configured: true, source: 'file' } } })
Object.assign(env9, isolatedApply(env9.ctx, { tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm' }] }] }, { keysByEntry: { ais: ['K1', 'K9'] } }))
const res9 = await statusOf(env9)
check('设置层 keys 覆盖 patch keys', res9.body.tiers[0].entries[0].keys.length === 2 && res9.body.tiers[0].entries[0].keysSource === 'settings', JSON.stringify(res9.body.tiers[0].entries[0]))
// 排程断言按「路由条数 + 排程次数」推导，不再写死数字：插件新增/删除路由时
// 这些断言仍然表达同一件事（几条路由就有几个 effect，另有每个每日重置排程一个）。
const routeCountOf = (env) => Object.keys(env.routes).length
check('patch 无 keys 时默认不排程、有覆盖时按需排程', env9.disposers.length === routeCountOf(env9) + 1, String(env9.disposers.length) + ' vs routes ' + String(routeCountOf(env9)))
const noKeys = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true } } })
Object.assign(noKeys, isolatedApply(noKeys.ctx, { tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm' }] }] }))
check('无任何 key 引用时不排程每日重置', noKeys.disposers.length === routeCountOf(noKeys), String(noKeys.disposers.length) + ' vs routes ' + String(routeCountOf(noKeys)))

// b) 轮换使用设置层 keys
const rotated9 = await env9.handlers['agent/request-error'](failure, async () => 'NEXT')
check('轮换按设置层 keys 前进（K1 → K9）', rotated9?.kind === 'retry' && env9.mutations[0]?.ops?.[0]?.value === 'K9', JSON.stringify(env9.mutations))

// c) 失效状态字段（时间 / 编码 / 消息）
const res10 = await statusOf(env9)
const failedKey = res10.body.tiers[0].entries[0].keys.find((key) => key.ref === 'K1')
check('失效 key 带时间与错误', failedKey?.failed === true && typeof failedKey.failedAt === 'number' && failedKey.failedCode === 'AUTH' && String(failedKey.failedMessage).includes('invalid api key'), JSON.stringify(failedKey))

// d) /config 校验
const env11 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' }, r2: { apiKeyEnv: 'K2' } }, refInfo: { K1: { configured: true }, K2: { configured: true }, K3: { configured: true } } })
Object.assign(env11, isolatedApply(env11.ctx, TWO_ENTRIES))
check('拒绝条目内重复引用', (await postConfig(env11, { keysByEntry: { ais: ['K1', 'K1'] } })).body.error?.includes('repeats') === true)
check('拒绝非法引用名', (await postConfig(env11, { keysByEntry: { ais: ['not a ref'] } })).body.error?.includes('invalid credential reference name') === true)
check('拒绝未知条目 id', (await postConfig(env11, { keysByEntry: { nope: ['K1'] } })).body.error?.includes('unknown entry id') === true)
check('拒绝跨条目复用引用', (await postConfig(env11, { keysByEntry: { ais: ['K3'], codex: ['K3'] } })).body.error?.includes('used by both entry') === true)
check('非法写入不落盘、不改写引用', !existsSync(env11.settingsFile) && env11.mutations.length === 0, JSON.stringify(readScope(env11.settingsFile)))
const okConfig = await postConfig(env11, { keysByEntry: { ais: ['K1', 'K3'] } })
const written11 = readScope(env11.settingsFile)
check('合法写入被接受并落盘', okConfig.status === 200 && JSON.stringify(written11) === JSON.stringify({ keysByEntry: { ais: ['K1', 'K3'] } }), JSON.stringify(written11))
check('写入后状态快照反映新引用', okConfig.body.tiers[0].entries[0].keys.length === 2 && okConfig.body.tiers[0].entries[0].keys[1].ref === 'K3', JSON.stringify(okConfig.body.tiers[0].entries[0].keys))
check('快照暴露可编辑的 keysByEntry', JSON.stringify(okConfig.body.editable.keysByEntry) === JSON.stringify({ ais: ['K1', 'K3'] }), JSON.stringify(okConfig.body.editable.keysByEntry))
for (const env of [env9, noKeys, env11]) for (const dispose of env.disposers) dispose()

console.log('测试切换（指令 + /test 路由）:')
const TEST_TIERS = [
  { tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm1', enabled: true }, { id: 'relay', route: 'r2', model: 'm2', enabled: true }] },
  { tier: 2, enabled: true, entries: [{ id: 'kimi', route: 'r3', model: 'm3', enabled: true }] },
  { tier: 3, enabled: false, entries: [{ id: 'off', route: 'r4', model: 'm4', enabled: true }] },
]
check('resolveTestTarget 空参数 = 当前条目之后的下一条', __test.resolveTestTarget(TEST_TIERS, '', 'r1').entry.id === 'relay')
check('resolveTestTarget 末尾回环', __test.resolveTestTarget(TEST_TIERS, '', 'r3').entry.id === 'ais')
check('resolveTestTarget tier:N', __test.resolveTestTarget(TEST_TIERS, 'tier:2').entry.id === 'kimi')
check('resolveTestTarget 条目 id', __test.resolveTestTarget(TEST_TIERS, 'relay').entry.id === 'relay')
check('resolveTestTarget 未知目标返回 undefined', __test.resolveTestTarget(TEST_TIERS, 'nope') === undefined)
check('resolveTestTarget 跳过未启用档位', __test.resolveTestTarget(TEST_TIERS, 'tier:3') === undefined)
check('resolveTestTarget 无匹配当前 provider 时从首项开始', __test.resolveTestTarget(TEST_TIERS, '', 'unknown').entry.id === 'ais')

// 最小同构 ctx：只挂测试切换需要的能力（webServer / commands / sessionController）
const makeSwitchEnv = (controller, patch, resolveModelInfo, streamFn) => {
  const routes = {}
  const disposers = []
  const handlers = {}
  const logs = []
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    on: (event, fn) => { handlers[event] = fn },
    get: (n) => n === 'llm' ? { listProviders: () => [], listConfigurableProviders: () => [], ...(resolveModelInfo === undefined ? {} : { resolveModelInfo }), ...(streamFn === undefined ? {} : { stream: streamFn }) } : n === 'sessionController' ? controller : undefined,
    inject: (deps, cb) => {
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } } })
      if (deps.includes('commands')) cb({ commands: { register: (def) => { logs.push(def); return () => {} } } })
    },
  }
  const scope = isolatedApply(ctx, patch)
  return { routes, disposers, handlers, registered: logs, settingsFile: scope.settingsFile }
}
const postTest = async (env, body) => {
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
  await env.routes['/provider-failover/test'](req, res)
  return res
}
const SWITCH_PATCH = { startup: { preferTier: 1 }, tiers: TEST_TIERS }

const selections = []
const controllerStub = { selectModel: async (request) => { selections.push(request); return { selected: { provider: request.provider, model: request.model } } } }
const env12 = makeSwitchEnv(controllerStub, SWITCH_PATCH)
check('注册 /test 路由与 failover-test 指令', env12.routes['/provider-failover/test'] !== undefined && env12.registered.some((def) => def.name === 'failover-test') === true)
const res12 = await postTest(env12, { sessionId: 's1', entry: 'relay' })
check('/test 切换会话模型', res12.status === 200 && res12.body.ok === true && selections.at(-1).provider === 'r2' && selections.at(-1).model === 'm2', JSON.stringify(res12.body.pin))
check('/test 记录 pin 与测试目标', res12.body.pin.entryId === 'relay' && res12.body.status.pins.length === 1 && res12.body.status.testTargets.length === 3, JSON.stringify(res12.body.status.pins))
check('/test 无会话时报错', (await postTest(env12, { entry: 'relay' })).status === 400)
check('/test 未知目标报错', (await postTest(env12, { sessionId: 's1', entry: 'nope' })).status === 400)
check('/test clear 解除 pin', (await postTest(env12, { sessionId: 's1', clear: true })).body.cleared === true)

// pin 短路 agent/request（跳过启动对齐）
const env13 = makeSwitchEnv(controllerStub, SWITCH_PATCH)
await postTest(env13, { sessionId: 's2', entry: 'relay' })
const agentStub = { session: { id: 's2', requestHeader: () => undefined } }
const pinned = await env13.handlers['agent/request']({ agent: agentStub, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
check('pin 生效时 agent/request 下发 pin 目标', pinned.provider === 'r2' && pinned.model === 'm2', JSON.stringify(pinned))
const otherSession = await env13.handlers['agent/request']({ agent: { session: { id: 's3', requestHeader: () => undefined } }, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
check('pin 只影响被 pin 的会话', otherSession.provider === 'r1' && otherSession.model === 'm1', JSON.stringify(otherSession))

// 指令路径（含 clear 与未知目标）
const env14 = makeSwitchEnv(controllerStub, SWITCH_PATCH)
const def = env14.registered.find((item) => item.name === 'failover-test')
const cmdAgent = { session: { id: 's4', requestHeader: () => ({ config: { provider: 'r1', model: 'm1' } }) } }
const cmdResult = await def.handler({ agent: cmdAgent, rawInput: ' tier:2 ' })
check('指令 tier:N 切换并返回成功文本', cmdResult.kind === 'success' && cmdResult.text.includes('r3/m3'), String(cmdResult.text))
check('指令未知目标返回错误', (await def.handler({ agent: cmdAgent, rawInput: 'nope' })).kind === 'error')
check('指令 clear 解除 pin', (await def.handler({ agent: cmdAgent, rawInput: 'clear' })).kind === 'success' && (await postTest(env14, { sessionId: 's4' })).body.ok === true)

// sessionController 未组合时不静默
const env15 = makeSwitchEnv(undefined, SWITCH_PATCH)
const noController = await postTest(env15, { sessionId: 's5', entry: 'relay' })
check('sessionController 未组合时报错而非静默', noController.status === 400 && String(noController.body.error).includes('session controller'), JSON.stringify(noController.body))
for (const env of [env12, env13, env14, env15]) for (const dispose of env.disposers) dispose()

// 2026-09-24：宿主对不支持的推理层级抛 UNSUPPORTED_REASONING_EFFORT（实测
// `ais-2dsglm/deepseek-v4.1-flash` 未声明 reasoningEfforts），插件必须自己拦住。
console.log('条目推理层级与模型目录一致性（UNSUPPORTED_REASONING_EFFORT 防护）:')
const noReasoning = {}
check('未声明 reasoningEffort 的条目一致', __test.unsupportedReasoningEffort({ reasoningEffort: undefined }, noReasoning) === undefined)
check('模型无 reasoning 时任何层级都不支持', __test.unsupportedReasoningEffort({ reasoningEffort: 'medium' }, noReasoning) !== undefined)
check('层级不在 efforts 中即不支持', __test.unsupportedReasoningEffort({ reasoningEffort: 'medium' }, { reasoning: { efforts: [{ id: 'high' }] } }) !== undefined)
check('层级在 efforts 中即支持', __test.unsupportedReasoningEffort({ reasoningEffort: 'medium' }, { reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }] } }) === undefined)

// 预检路径：首条目声明了模型不支持的层级 → 跳过，落到下一个可用条目（而不是打断整轮）。
const PRECHECK_TIERS = [{
  tier: 1,
  enabled: true,
  entries: [
    { id: 'unsupported', route: 'r-bad', model: 'm-bad', reasoningEffort: 'medium', enabled: true },
    { id: 'fallback', route: 'r-ok', model: 'm-ok', enabled: true },
  ],
}]
const env16 = makeSwitchEnv(undefined, { probeTarget: true, startup: { preferTier: 1 }, tiers: PRECHECK_TIERS }, async () => noReasoning)
const aligned16 = await env16.handlers['agent/request']({ agent: { session: { id: 'p1' } }, turn: 1, step: 1 }, async () => ({ provider: 'r-other', model: 'm-other' }))
check('预检跳过不支持推理层级的候选', aligned16.provider === 'r-ok' && aligned16.model === 'm-ok', JSON.stringify(aligned16))
check('跳过后不下发任何 reasoningEffort', aligned16.reasoningEffort === undefined, JSON.stringify(aligned16))
const env17 = makeSwitchEnv(undefined, { probeTarget: true, startup: { preferTier: 1 }, tiers: PRECHECK_TIERS }, async () => ({ reasoning: { efforts: [{ id: 'medium' }] } }))
const aligned17 = await env17.handlers['agent/request']({ agent: { session: { id: 'p2' } }, turn: 1, step: 1 }, async () => ({ provider: 'r-other', model: 'm-other' }))
check('层级受支持时候选正常下发 reasoningEffort', aligned17.provider === 'r-bad' && aligned17.reasoningEffort === 'medium', JSON.stringify(aligned17))

// 测试切换路径：条目层级不受支持时丢弃（官方 selectModel 会校验并抛错）。
const DROP_TIERS = [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm1', reasoningEffort: 'medium', enabled: true }] }]
const dropSelections = []
const dropController = { selectModel: async (request) => { dropSelections.push(request); return { selected: { provider: request.provider, model: request.model } } } }
const env18 = makeSwitchEnv(dropController, { startup: { preferTier: 1 }, tiers: DROP_TIERS }, async () => noReasoning)
const res18 = await postTest(env18, { sessionId: 's6', entry: 'ais' })
check('测试切换丢弃模型不支持的推理层级', res18.status === 200 && dropSelections.at(-1).reasoningEffort === undefined, JSON.stringify(dropSelections.at(-1)))
check('pin 也不带被丢弃的层级', res18.body.pin.reasoningEffort === undefined, JSON.stringify(res18.body.pin))
for (const env of [env16, env17, env18]) for (const dispose of env.disposers) dispose()

// 2026-10-02：插件改写 provider/model 时必须同步推理层级。旧模型（或会话持久化选择）
// 的 reasoningEffort 带到不支持它的目标模型会抛 UNSUPPORTED_REASONING_EFFORT（不可切换），
// 表现为「切换 provider 时持续卡在前一个故障中」。
console.log('改写路由时的推理层级同步（继承层级不兼容即丢弃）:')
const EFFORT_TIERS = [{ tier: 1, enabled: true, entries: [{ id: 'noeff', route: 'r-nr', model: 'm-nr', enabled: true }] }]
const freshAgent = (id) => ({ session: { id } })
const env19 = makeSwitchEnv(undefined, { probeTarget: true, startup: { preferTier: 1 }, tiers: EFFORT_TIERS }, async () => noReasoning)
const out19 = await env19.handlers['agent/request']({ agent: freshAgent('e1'), turn: 1, step: 1 }, async () => ({ provider: 'r-old', model: 'm-old', reasoningEffort: 'high' }))
check('启动对齐：目标模型不支持时丢弃继承层级', out19.provider === 'r-nr' && out19.reasoningEffort === undefined, JSON.stringify(out19))

const env20 = makeSwitchEnv(undefined, { probeTarget: true, startup: { preferTier: 1 }, tiers: EFFORT_TIERS }, async () => ({ reasoning: { efforts: [{ id: 'high' }] } }))
const out20 = await env20.handlers['agent/request']({ agent: freshAgent('e2'), turn: 1, step: 1 }, async () => ({ provider: 'r-old', model: 'm-old', reasoningEffort: 'high' }))
check('启动对齐：目标模型支持时保留继承层级', out20.provider === 'r-nr' && out20.reasoningEffort === 'high', JSON.stringify(out20))

const DECLARED_TIERS = [{ tier: 1, enabled: true, entries: [{ id: 'decl', route: 'r-d', model: 'm-d', reasoningEffort: 'medium', enabled: true }] }]
const env21 = makeSwitchEnv(undefined, { probeTarget: true, startup: { preferTier: 1 }, tiers: DECLARED_TIERS }, async () => ({ reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }] } }))
const out21 = await env21.handlers['agent/request']({ agent: freshAgent('e3'), turn: 1, step: 1 }, async () => ({ provider: 'r-old', model: 'm-old', reasoningEffort: 'high' }))
check('启动对齐：条目声明层级优先于继承层级', out21.provider === 'r-d' && out21.reasoningEffort === 'medium', JSON.stringify(out21))
for (const env of [env19, env20, env21]) for (const dispose of env.disposers) dispose()

// 不可切换失败必须给出原因（ignored 决策），可切换失败不得写入。
console.log('不可切换失败的诊断记录（ignored）:')
const IGNORE_TIERS = [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'r1', model: 'm1', enabled: true }] }]
const env22 = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: IGNORE_TIERS })
const ignoredOut = await env22.handlers['agent/request-error']({ failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'does not support reasoning effort "high"' }, provider: 'r1', turn: 2, step: 2 }, async () => 'NEXT')
const status22 = await statusOf(env22)
check('不可切换失败交回宿主', ignoredOut === 'NEXT')
check('记录 ignored 决策并标注 configuration', status22.body.ignored?.some((item) => item.category === 'configuration' && item.code === 'UNSUPPORTED_REASONING_EFFORT') === true, JSON.stringify(status22.body.ignored))
const env23 = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: IGNORE_TIERS })
await env23.handlers['agent/request-error']({ failure: { code: 'QUOTA', message: 'quota exceeded' }, provider: 'r1', turn: 1, step: 1 }, async () => 'NEXT')
const status23 = await statusOf(env23)
// 口径：可切换失败不写「为什么没切」类的 ignored（other/configuration）。
// no-candidate 是另一件事——失败可切换但档位表里确实没有可用候选，必须留痕，
// 否则证据里分不清「没触发」和「触发了但没得切」。
check('可切换失败不写 other/configuration 类 ignored', (status23.body.ignored?.filter((item) => item.category === 'other' || item.category === 'configuration').length ?? 0) === 0, JSON.stringify(status23.body.ignored))

// Codex OAuth 的额度耗尽文案可能被宿主归成 PI_AI_ERROR；消息兜底必须实际触发
// provider 切换和同一步 retry，而不只是纯函数命中。
const USAGE_LIMIT_TIERS = [{ tier: 1, enabled: true, entries: [
  { id: 'official', route: 'r1', model: 'm1', enabled: true },
  { id: 'fallback', route: 'r2', model: 'm2', enabled: true },
] }]
const envUsage = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, tiers: USAGE_LIMIT_TIERS })
const usageAgent = freshAgent('usage-limit-session')
const usageDecision = await envUsage.handlers['agent/request-error']({ agent: usageAgent, failure: { code: 'PI_AI_ERROR', message: 'Codex error: The usage limit has been reached' }, provider: 'r1', turn: 1, step: 1 }, async () => 'NEXT')
const usageRoute = await envUsage.handlers['agent/request']({ agent: usageAgent, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
const usageStatus = await statusOf(envUsage)
check('PI_AI_ERROR usage-limit 文案触发同一步 retry', usageDecision?.kind === 'retry', JSON.stringify(usageDecision))
check('PI_AI_ERROR usage-limit 文案切换到其他 provider', usageRoute.provider === 'r2' && usageRoute.model === 'm2', JSON.stringify(usageRoute))
check('PI_AI_ERROR usage-limit 命中后不写 ignored', (usageStatus.body.ignored?.length ?? 0) === 0, JSON.stringify(usageStatus.body.ignored))
for (const env of [env22, env23, envUsage]) for (const dispose of env.disposers) dispose()

// 2026-10-06：状态记账淘汰回归。超过 128 个 (turn, step) 后，新建记账不得被自身的
// 淘汰扫描误删（at:0 会是最小值，导致 target 在 request-error 与 request 之间丢失）。
// 触发场景：长会话（实测 turn 30 / 480+ 步）里切换只记日志、不生效，最终仍以原 provider 失败。
const envEvict = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, tiers: USAGE_LIMIT_TIERS })
const evictAgent = freshAgent('eviction-session')
for (let step = 1; step <= 200; step++) {
  await envEvict.handlers['agent/request']({ agent: evictAgent, turn: 1, step }, async () => ({ provider: 'r1', model: 'm1' }))
}
const evictDecision = await envEvict.handlers['agent/request-error']({ agent: evictAgent, failure: { code: 'PI_AI_ERROR', message: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~151 min.' }, provider: 'r1', turn: 2, step: 1 }, async () => 'NEXT')
const evictRoute = await envEvict.handlers['agent/request']({ agent: evictAgent, turn: 2, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
check('超过 128 步后 usage-limit 仍触发 retry', evictDecision?.kind === 'retry', JSON.stringify(evictDecision))
check('超过 128 步后切换仍作用于下一步请求', evictRoute.provider === 'r2' && evictRoute.model === 'm2', JSON.stringify(evictRoute))
for (const dispose of envEvict.disposers) dispose()

// 2026-10-06：status 的「最近 10 条」必须是最近 10 条。switchLog 是 newest-first（unshift），
// 切片方向曾用 slice(-LOG_LIMIT) 取到最旧的 10 条，超过 10 条后设置页展示的是陈旧记录。
const envLog = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, tiers: USAGE_LIMIT_TIERS })
for (let step = 1; step <= 12; step++) {
  await envLog.handlers['agent/request-error']({ agent: freshAgent('log-order-' + step), failure: { code: 'QUOTA', message: 'quota exceeded' }, provider: 'r1', turn: 1, step }, async () => 'NEXT')
}
const logStatus = await statusOf(envLog)
const logSwitches = logStatus.body.switches
check('status.switches 只保留最近 10 条', logSwitches.length === 10, String(logSwitches.length))
check('status.switches 首条为最新（newest-first）', logSwitches[0]?.step === 12 && logSwitches.at(-1)?.step === 3, JSON.stringify(logSwitches.map((item) => item.step)))
for (const dispose of envLog.disposers) dispose()

const POLICY_TIERS = [{ tier: 1, enabled: true, entries: [
  { id: 'policy-source', route: 'r-policy', model: 'm-policy', enabled: true },
  { id: 'policy-fallback', route: 'r-policy-fallback', model: 'm-policy-fallback', enabled: true },
] }]
const POLICY_FAILURE = { code: 'PI_AI_ERROR', message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy' }

// 默认 policyMode='same'：保留当前 provider/model，在同一 (turn, step) 原地重试，不切换。
const envPolicy = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, tiers: POLICY_TIERS })
const policyAgent = freshAgent('policy-session')
const policyDecision = await envPolicy.handlers['agent/request-error']({ agent: policyAgent, failure: POLICY_FAILURE, provider: 'r-policy', turn: 1, step: 1 }, async () => 'NEXT')
const policyRoute = await envPolicy.handlers['agent/request']({ agent: policyAgent, turn: 1, step: 1 }, async () => ({ provider: 'r-policy', model: 'm-policy' }))
check('policy refusal retries on the same provider by default', policyDecision?.kind === 'retry', JSON.stringify(policyDecision))
check('policy refusal keeps the current provider/model', policyRoute.provider === 'r-policy' && policyRoute.model === 'm-policy', JSON.stringify(policyRoute))
const policyStatus = await statusOf(envPolicy)
check('policy retry is audited as policy-retry', policyStatus.body.switches.some((item) => item.kind === 'policy-retry' && item.from === 'r-policy' && item.to === 'r-policy') === true, JSON.stringify(policyStatus.body.switches))
check('status reports policyMode/maxPolicyRetriesPerStep', policyStatus.body.policyMode === 'same' && policyStatus.body.maxPolicyRetriesPerStep === 2, JSON.stringify({ mode: policyStatus.body.policyMode, max: policyStatus.body.maxPolicyRetriesPerStep }))

// 重试次数上限：耗尽后保持当前 provider/model 交回宿主。
const envPolicyCap = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, maxPolicyRetriesPerStep: 1, tiers: POLICY_TIERS })
const capAgent = freshAgent('policy-cap-session')
const cap1 = await envPolicyCap.handlers['agent/request-error']({ agent: capAgent, failure: POLICY_FAILURE, provider: 'r-policy', turn: 1, step: 1 }, async () => 'NEXT')
const cap2 = await envPolicyCap.handlers['agent/request-error']({ agent: capAgent, failure: POLICY_FAILURE, provider: 'r-policy', turn: 1, step: 1 }, async () => 'NEXT')
check('policy retry respects maxPolicyRetriesPerStep then hands back', cap1?.kind === 'retry' && cap2 === 'NEXT', JSON.stringify([cap1, cap2]))

// policyMode='switch'：保留旧行为（切到下一条 provider）。
const envPolicySwitch = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, policyMode: 'switch', tiers: POLICY_TIERS })
const swAgent = freshAgent('policy-switch-session')
const swDecision = await envPolicySwitch.handlers['agent/request-error']({ agent: swAgent, failure: POLICY_FAILURE, provider: 'r-policy', turn: 1, step: 1 }, async () => 'NEXT')
const swRoute = await envPolicySwitch.handlers['agent/request']({ agent: swAgent, turn: 1, step: 1 }, async () => ({ provider: 'r-policy', model: 'm-policy' }))
check('policyMode:switch keeps the legacy provider switch', swDecision?.kind === 'retry' && swRoute.provider === 'r-policy-fallback' && swRoute.model === 'm-policy-fallback', JSON.stringify(swRoute))

// policyMode='off'：不介入，交回宿主。
const envPolicyOff = makeSwitchEnv(undefined, { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, policyMode: 'off', tiers: POLICY_TIERS })
const offDecision = await envPolicyOff.handlers['agent/request-error']({ agent: freshAgent('policy-off-session'), failure: POLICY_FAILURE, provider: 'r-policy', turn: 1, step: 1 }, async () => 'NEXT')
check('policyMode:off hands policy failures back to the host', offDecision === 'NEXT', JSON.stringify(offDecision))
for (const env of [envPolicy, envPolicyCap, envPolicySwitch, envPolicyOff]) for (const dispose of env.disposers) dispose()

// 2026-10-02：全量测试——对启用档位的每个 provider/model 发最小真实请求并列出状态。
console.log('全量测试（真实最小请求 + 状态分类）:')
check('classifyProbeFailure 额度不足', __test.classifyProbeFailure('QUOTA', 'quota exceeded').label === '额度不足')
check('classifyProbeFailure 超时兜底', __test.classifyProbeFailure(undefined, 'request timed out').status === 'TIMEOUT')
check('classifyProbeFailure 归一化传输中断', __test.classifyProbeFailure('TRANSPORT', 'socket hang up').label === '传输中断')
check('classifyProbeFailure WebSocket close 兜底', __test.classifyProbeFailure('PI_AI_ERROR', 'WebSocket closed 1000').status === 'TRANSPORT')
check('classifyProbeFailure 未知编码', __test.classifyProbeFailure(undefined, 'weird thing').label === '未知错误')
// 2026-10-15：编码未归一化时不再一律「未知错误」——与切换判定共用同一套 failurePatterns 兜底。
const clsCodexLimit = __test.classifyProbeFailure('PI_AI_ERROR', 'Codex error: The usage limit has been reached')
check('classifyProbeFailure 未归一化 usage limit 归额度不足', clsCodexLimit.status === 'QUOTA' && clsCodexLimit.label === '额度不足', JSON.stringify(clsCodexLimit))
const clsRelay502 = __test.classifyProbeFailure('PI_AI_ERROR', 'codex-relay API error (502): 502 status code (no body)')
check('classifyProbeFailure 原生 502 展示服务端异常而非未知错误', clsRelay502.status === 'SERVER' && clsRelay502.label === '服务端/网络异常', JSON.stringify(clsRelay502))
const clsEtimedout = __test.classifyProbeFailure('PI_AI_ERROR', 'connect ETIMEDOUT 10.0.0.5:443')
check('classifyProbeFailure 不把端口/字节当状态码', clsEtimedout.status === 'PI_AI_ERROR' && clsEtimedout.label === '未知错误', JSON.stringify(clsEtimedout))
const clsWsError = __test.classifyProbeFailure('PI_AI_ERROR', 'WebSocket error')
check('classifyProbeFailure 裸 WebSocket error 归传输中断', clsWsError.status === 'TRANSPORT' && clsWsError.label === '传输中断', JSON.stringify(clsWsError))
// 2026-10-15：relay 上游 HTTP/2 流复位以 SSE error 事件下发，文案两条宿主规则都不命中 → PI_AI_ERROR，
// 必须靠 'http2' / 'upstream_' 模式兜底成 TRANSPORT，否则宿主默认重试码表不含 PI_AI_ERROR，整轮终止。
const clsHttp2 = __test.classifyProbeFailure('PI_AI_ERROR', 'Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed')
check('classifyProbeFailure 上游 http2 流错误归传输中断', clsHttp2.status === 'TRANSPORT' && clsHttp2.label === '传输中断', JSON.stringify(clsHttp2))
check('classifyProbeFailure 网关 upstream_* 前缀码归传输中断', __test.classifyProbeFailure('PI_AI_ERROR', 'Error Code upstream_connection_reset: connection reset by peer').status === 'TRANSPORT')
const clsCustom = __test.classifyProbeFailure('PI_AI_ERROR', 'custom vendor blocked code', ['custom vendor blocked'])
check('classifyProbeFailure 自定义模式保守落回未知错误（不臆造状态标签）', clsCustom.label === '未知错误', JSON.stringify(clsCustom))

// 2026-10-16：AUTH 类失败必须区分具体原因。实测 tokeniss 对 claude-opus-5-5 返回
//   403 {"error":{"type":"new_api_error","message":"预扣费额度失败, 用户剩余额度: ¥1.040956,
//        需要预扣费额度: ¥1.192114 (request id: ...)"}}  且 code:"AUTH"
// 提示里只写「AUTH」，真因却是余额不足；同一时期 anthropic-relay 的 403
// 「该令牌无权访问模型 claude-opus-5-5」也是 AUTH，但真因是模型未授权——两者处置完全不同。
console.log('失败原因细分（AUTH 类提示）:')
const REAL_QUOTA_AUTH = '403 {"error":{"type":"new_api_error","message":"预扣费额度失败, 用户剩余额度: ¥1.040956, 需要预扣费额度: ¥1.192114 (request id: 202610160612230175964348268d9d64PFYJzb0)"},"type":"error"}'
const REAL_PERM_AUTH = '403 {"error":{"message":"该令牌无权访问模型 claude-opus-5-5"}}'
const reasonQuota = __test.failureReasonFor('AUTH', REAL_QUOTA_AUTH)
check('AUTH + 预扣费额度失败 → 额度/余额不足（而非“凭据无效”）', reasonQuota.id === 'QUOTA_EXHAUSTED' && reasonQuota.label === '额度/余额不足', JSON.stringify(reasonQuota))
const reasonPerm = __test.failureReasonFor('AUTH', REAL_PERM_AUTH)
check('AUTH + 该令牌无权访问模型 → 权限不足：该令牌无权使用该模型', reasonPerm.id === 'MODEL_NOT_AUTHORIZED', JSON.stringify(reasonPerm))
// 同一个 AUTH 码下两种真因必须给出不同结论——这是本次修复的核心断言。
check('同一 AUTH 码下「余额不足」与「模型未授权」不再同形', reasonQuota.id !== reasonPerm.id)
check('AUTH + invalid api key → 凭据无效', __test.failureReasonFor('AUTH', 'invalid api key provided').id === 'CREDENTIAL_INVALID')
check('AUTH + 认不出的原文 → 如实说“未细分”，不替用户下结论', __test.failureReasonFor('AUTH', 'weird upstream thing').id === 'AUTH')
check('QUOTA 码无原文时仍按码给出额度标签', __test.failureReasonFor('QUOTA', '').label === '额度/余额不足')
check('英文额度文案同样细分（不只认中文）', __test.failureReasonFor('AUTH', 'insufficient_quota: your account has run out').id === 'QUOTA_EXHAUSTED')
// 兜底顺序：更具体的词必须先于通用词命中（'余额不足' vs 泛化的 'balance'）。
check('细分表取首个命中，具体词优先于通用词', __test.failureReasonFor('AUTH', '额度不足').id === 'QUOTA_EXHAUSTED')
// 配置只能往内置表**追加**词条，不能整体替换掉中英文默认判定。
const mergedReasons = __test.mergeFailureReasons({ QUOTA_EXHAUSTED: ['自定义欠费文案'] }, [])
check('failureReasons 追加词条后仍保留内置中文判定', __test.failureReasonFor('AUTH', REAL_QUOTA_AUTH, mergedReasons).id === 'QUOTA_EXHAUSTED')
check('failureReasons 追加的自定义词条生效', __test.failureReasonFor('AUTH', '自定义欠费文案', mergedReasons).id === 'QUOTA_EXHAUSTED')
const mergeErrors = []
__test.mergeFailureReasons({ NO_SUCH_REASON: ['x'] }, mergeErrors)
check('failureReasons 未知 id 记配置错误（拼错的键不会静默失效）', mergeErrors.length === 1, JSON.stringify(mergeErrors))
const mergeErrors2 = []
__test.mergeFailureReasons({ QUOTA_EXHAUSTED: [] }, mergeErrors2)
check('failureReasons 空数组记配置错误', mergeErrors2.length === 1, JSON.stringify(mergeErrors2))
// 归一化后的配置必须带上生效的 failureReasons（判定与展示同源）。
const normalizedReasons = normalize({ failureReasons: { QUOTA_EXHAUSTED: ['欠费停机'] } })
check('normalize 结果携带生效 failureReasons', Array.isArray(normalizedReasons.value.failureReasons) && normalizedReasons.value.failureReasons.length === __test.DEFAULT_FAILURE_REASONS.length)
check('normalize 把自定义词条并入生效表', __test.failureReasonFor('AUTH', '欠费停机', normalizedReasons.value.failureReasons).id === 'QUOTA_EXHAUSTED')
check('normalize 对未知 reason id 报错', normalize({ failureReasons: { NOPE: ['x'] } }).errors.some((line) => line.indexOf('failureReasons.NOPE') >= 0))

// 全量测试（/failover-probe）的展示同样不能把 AUTH 一律写成「凭据无效」。
// 注意：只细化 AUTH 族的 label，status 与 QUOTA 等既有标签保持不变。
const probeReasonTable = __test.DEFAULT_FAILURE_REASONS
const clsAuthQuota = __test.classifyProbeFailure('AUTH', REAL_QUOTA_AUTH, undefined, probeReasonTable)
check('全量测试：AUTH + 余额不足展示为额度/余额不足（status 仍为 AUTH）', clsAuthQuota.status === 'AUTH' && clsAuthQuota.label === '额度/余额不足', JSON.stringify(clsAuthQuota))
const clsAuthPerm = __test.classifyProbeFailure('AUTH', REAL_PERM_AUTH, undefined, probeReasonTable)
check('全量测试：AUTH + 无权访问模型展示为权限不足', clsAuthPerm.label === '权限不足：该令牌无权使用该模型', JSON.stringify(clsAuthPerm))
check('全量测试：AUTH + 认不出的原文仍保守显示凭据无效', __test.classifyProbeFailure('AUTH', 'weird upstream thing', undefined, probeReasonTable).label === '凭据无效')
check('全量测试：不传原因表时行为完全不变（向后兼容）', __test.classifyProbeFailure('AUTH', REAL_QUOTA_AUTH).label === '凭据无效')
check('全量测试：QUOTA 既有标签不受影响', __test.classifyProbeFailure('QUOTA', 'quota exceeded', undefined, probeReasonTable).label === '额度不足')

const PROBE_TIERS = [
  { tier: 1, enabled: true, entries: [
    { id: 'good', route: 'r-good', model: 'm-good', enabled: true },
    { id: 'bad', route: 'r-bad', model: 'm-bad', enabled: true },
    { id: 'relay', route: 'r-relay', model: 'm-relay', enabled: true },
    { id: 'off', route: 'r-off', model: 'm-off', enabled: false },
  ] },
  { tier: 2, enabled: false, entries: [{ id: 'offtier', route: 'r-x', model: 'm-x', enabled: true }] },
]
const probeSeen = []
const streamStub = (request) => {
  probeSeen.push(request)
  return (async function* () {
    if (request.provider === 'r-good') {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'completed' } }
    } else if (request.provider === 'r-relay') {
      // 本机 codex-relay 实测：流式请求稳定回 502 且响应体为空。
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'codex-relay API error (502): 502 status code (no body)' } } }
    } else {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient balance' } } }
    }
  })()
}
const postProbe = async (env, body) => {
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body ?? {})) } }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
  await env.routes['/provider-failover/probe'](req, res)
  return res
}
const env24 = makeSwitchEnv(undefined, { tiers: PROBE_TIERS }, undefined, streamStub)
const probeRes24 = await postProbe(env24, {})
check('全量测试只覆盖启用档位的启用条目', probeRes24.body.results.length === 3 && probeRes24.body.results.every((item) => item.id !== 'off' && item.id !== 'offtier'), JSON.stringify(probeRes24.body.results.map((item) => item.id)))
check('正常目标回报 OK + 回复', probeRes24.body.results.find((item) => item.id === 'good')?.status === 'OK' && probeRes24.body.results.find((item) => item.id === 'good')?.reply === 'ok', JSON.stringify(probeRes24.body.results.find((item) => item.id === 'good')))
check('额度不足目标回报 QUOTA', probeRes24.body.results.find((item) => item.id === 'bad')?.status === 'QUOTA' && probeRes24.body.results.find((item) => item.id === 'bad')?.label === '额度不足', JSON.stringify(probeRes24.body.results.find((item) => item.id === 'bad')))
check('空体 502 目标回报 SERVER/服务端网络异常（不再是未知错误）', probeRes24.body.results.find((item) => item.id === 'relay')?.status === 'SERVER' && probeRes24.body.results.find((item) => item.id === 'relay')?.label === '服务端/网络异常', JSON.stringify(probeRes24.body.results.find((item) => item.id === 'relay')))
check('全量测试汇总', probeRes24.body.summary.total === 3 && probeRes24.body.summary.ok === 1 && probeRes24.body.summary.failed === 2, JSON.stringify(probeRes24.body.summary))
const status24 = await statusOf(env24)
check('status 暴露 lastProbe 与 probeTimeoutMs', status24.body.lastProbe?.results?.length === 3 && typeof status24.body.probeTimeoutMs === 'number', JSON.stringify(status24.body.lastProbe?.summary))
const single24 = await postProbe(env24, { entry: 'bad' })
check('单条目过滤', single24.body.results.length === 1 && single24.body.results[0].id === 'bad', JSON.stringify(single24.body.results.map((item) => item.id)))
check('未知条目报错', (await postProbe(env24, { entry: 'nope' })).status === 400)
check('探测请求始终携带会话身份（opencode-go 需 x-opencode-session）', probeSeen.length >= 2 && probeSeen.every((request) => typeof request.sessionId === 'string' && request.sessionId.length > 0), JSON.stringify(probeSeen.map((request) => request.sessionId)))
const explicit24 = await postProbe(env24, { entry: 'good', sessionId: 'sess-explicit' })
check('显式 sessionId 透传到探测请求与报告', explicit24.body.sessionId === 'sess-explicit' && probeSeen.at(-1).sessionId === 'sess-explicit', String(probeSeen.at(-1).sessionId))
const probeCmd = env24.registered.find((def) => def.name === 'failover-probe')
const cmdProbe = await probeCmd.handler({ rawInput: '', agent: { session: { id: 'x' } } })
check('指令 /failover-probe 返回汇总文本', cmdProbe.kind === 'success' && cmdProbe.text.includes('1/3'), String(cmdProbe.text))
for (const dispose of env24.disposers) dispose()

// 2026-10-02：跨会话状态隔离——steps 与 pendingNeeds 按 sessionId 分键。
console.log('跨会话状态隔离:')
const ISO_TIERS = [{ tier: 1, enabled: true, entries: [
  { id: 'a', route: 'r1', model: 'm1', enabled: true },
  { id: 'b', route: 'r2', model: 'm2', enabled: true },
] }]
const envIso = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: ISO_TIERS })
const agentA = { session: { id: 'sess-A', requestHeader: () => undefined } }
const agentB = { session: { id: 'sess-B', requestHeader: () => undefined } }
await envIso.handlers['agent/request-error']({ agent: agentA, failure: { code: 'QUOTA', message: 'quota exceeded' }, provider: 'r1', turn: 1, step: 1 }, async () => 'NEXT')
const aReq = await envIso.handlers['agent/request']({ agent: agentA, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
check('会话 A 的失败切换只作用于 A', aReq.provider === 'r2' && aReq.model === 'm2', JSON.stringify(aReq))
const bReq = await envIso.handlers['agent/request']({ agent: agentB, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
check('同 turn/step 的会话 B 不受 A 的切换影响', bReq.provider === 'r1' && bReq.model === 'm1', JSON.stringify(bReq))
for (const dispose of envIso.disposers) dispose()

const NEED_TIERS = [{ tier: 1, enabled: true, entries: [{ id: 'noimg', route: 'r-noimg', model: 'm', enabled: true, compatible: { tools: true, images: false } }] }]
const envNeeds = makeSwitchEnv(undefined, { startup: { preferTier: 0 }, tiers: NEED_TIERS })
envNeeds.handlers['llm/stream']({ sessionId: 'sess-A', messages: [{ role: 'user', content: [{ type: 'image' }] }] }, () => undefined)
await envNeeds.handlers['agent/request']({ agent: { session: { id: 'sess-A' } }, turn: 1, step: 1 }, async () => ({ provider: 'r-old', model: 'm' }))
const aErr = await envNeeds.handlers['agent/request-error']({ agent: { session: { id: 'sess-A' } }, failure: { code: 'QUOTA', message: 'quota exceeded' }, provider: 'r-old', turn: 1, step: 1 }, async () => 'NEXT')
check('会话 A 的图片需求使不兼容候选被跳过', aErr === 'NEXT', JSON.stringify(aErr))
envNeeds.handlers['llm/stream']({ sessionId: 'sess-B', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, () => undefined)
await envNeeds.handlers['agent/request']({ agent: { session: { id: 'sess-B' } }, turn: 2, step: 1 }, async () => ({ provider: 'r-old', model: 'm' }))
const bErr = await envNeeds.handlers['agent/request-error']({ agent: { session: { id: 'sess-B' } }, failure: { code: 'QUOTA', message: 'quota exceeded' }, provider: 'r-old', turn: 2, step: 1 }, async () => 'NEXT')
check('会话 B 不受 A 的图片需求影响（正常切换）', bErr?.kind === 'retry', JSON.stringify(bErr))
for (const dispose of envNeeds.disposers) dispose()

// 设置页需渲染 Host 的 ignored 诊断（client.js 静态检查）。
check('client.js 渲染「最近未切换原因」（status.ignored）', readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes('status.ignored'))

// 2026-10-16 端到端：真实 tokeniss 403/AUTH 报文经 agent/request-error 后，
// 通知（/provider-failover/notices 的取数源）必须带出「额度/余额不足」而非只写 AUTH。
console.log('端到端：AUTH 类失败在通知里区分具体原因:')
const readNotices = async (env, sessionId) => {
  const req = { method: 'GET', url: '/provider-failover/notices?sessionId=' + encodeURIComponent(sessionId) + '&limit=20', socket: { remoteAddress: '127.0.0.1' } }
  const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
  await env.routes['/provider-failover/notices'](req, res)
  return res.body?.notices ?? []
}
const REASON_TIERS = [{ tier: 1, enabled: true, entries: [
  { id: 'a', route: 'r-tokeniss', model: 'claude-opus-5-5', enabled: true },
  { id: 'b', route: 'r-codex', model: 'gpt-5.6-sol', enabled: true },
] }]
const reasonSession = { session: { id: 'sess-reason', requestHeader: () => undefined } }
const envReason = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: REASON_TIERS, failureReasons: { QUOTA_EXHAUSTED: ['试用额度已耗尽'] } })
await envReason.handlers['agent/request-error']({ agent: reasonSession, provider: 'r-tokeniss', turn: 1, step: 1, failure: { code: 'AUTH', message: REAL_QUOTA_AUTH } }, async () => 'NEXT')
const quotaNotice = (await readNotices(envReason, 'sess-reason')).find((n) => n.kind === 'failover' && n.code === 'AUTH') ?? {}
check('切换通知带 reasonId/reasonLabel（不再只说 AUTH）', quotaNotice.reasonId === 'QUOTA_EXHAUSTED' && quotaNotice.reasonLabel === '额度/余额不足', JSON.stringify(quotaNotice))
check('切换通知带脱敏后的上游原文摘要', typeof quotaNotice.detail === 'string' && quotaNotice.detail.includes('剩余额度'), JSON.stringify(quotaNotice.detail))
check('原因细分不影响切换行为（仍然切到下一档）', quotaNotice.toRoute === 'r-codex' && quotaNotice.toModel === 'gpt-5.6-sol', JSON.stringify({ to: quotaNotice.toRoute, model: quotaNotice.toModel }))
// 同一 AUTH 码 + 模型未授权文案 → 不同的展示结论（这是本次修复的核心）。
const envPerm = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: REASON_TIERS })
await envPerm.handlers['agent/request-error']({ agent: { session: { id: 'sess-perm', requestHeader: () => undefined } }, provider: 'r-tokeniss', turn: 1, step: 1, failure: { code: 'AUTH', message: REAL_PERM_AUTH } }, async () => 'NEXT')
const permNotice = (await readNotices(envPerm, 'sess-perm')).find((n) => n.kind === 'failover') ?? {}
check('同一 AUTH 码下模型未授权走不同的原因标签', permNotice.reasonId === 'MODEL_NOT_AUTHORIZED' && permNotice.reasonLabel !== quotaNotice.reasonLabel, JSON.stringify(permNotice))
// 密钥形状的片段绝不能进通知（detail 走 sanitizeForRanking）。
const envSecret = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: REASON_TIERS })
await envSecret.handlers['agent/request-error']({ agent: { session: { id: 'sess-secret', requestHeader: () => undefined } }, provider: 'r-tokeniss', turn: 1, step: 1, failure: { code: 'AUTH', message: 'Authorization failed for api_key sk-abcdefghijklmnopqrstuvwxyz012345' } }, async () => 'NEXT')
const secretNotice = (await readNotices(envSecret, 'sess-secret')).find((n) => n.kind === 'failover') ?? {}
check('通知里的密钥形状片段被脱敏', typeof secretNotice.detail === 'string' && secretNotice.detail.includes('[redacted]') && secretNotice.detail.includes('sk-abcdefghij') !== true, JSON.stringify(secretNotice.detail))
for (const dispose of envReason.disposers) dispose()
for (const dispose of envPerm.disposers) dispose()
for (const dispose of envSecret.disposers) dispose()

console.log('按类别重试策略（SERVER = 上游 5xx / 空体 502）:')
// 空体 502 由 effectiveFailureCode 折算成 SERVER，所以 SERVER 这一档就是 502 的实际重试档。
// 2026-10-16 实测把该档从 3s×2（15s 预算）提到 5s×5（30s 预算）：codex-relay 连续三次返回
// 空体 502，旧档 36s 内就交出了路由，接棒的 openai-codex / kimi 又分别额度耗尽，tier1 全灭。
check('默认 SERVER 档 = 5 次 × 5s、预算 30s', JSON.stringify(defaults.retryPolicies.SERVER) === JSON.stringify({ attempts: 5, delayMs: 5000, budgetMs: 30000 }), JSON.stringify(defaults.retryPolicies.SERVER))
check('SERVER 档的全部重试都落在预算内（attempts × delayMs <= budgetMs）', defaults.retryPolicies.SERVER.attempts * defaults.retryPolicies.SERVER.delayMs <= defaults.retryPolicies.SERVER.budgetMs, JSON.stringify(defaults.retryPolicies.SERVER))
check('SERVER 档按类别可被配置覆盖（不整体挤掉其它类）', normalize({ retryPolicies: { SERVER: { attempts: 4, delayMs: 2000, budgetMs: 9000 } } }).value.retryPolicies.SERVER.attempts === 4 && normalize({ retryPolicies: { SERVER: { attempts: 4, delayMs: 2000, budgetMs: 9000 } } }).value.retryPolicies.TRANSPORT.attempts === defaults.retryPolicies.TRANSPORT.attempts)
// 用极小的 delayMs 驱动同一条闸门，避免回归里真的等 25s。
const RETRY_TIERS = [
  { tier: 1, enabled: true, entries: [{ id: 'relay', route: 'r1', model: 'm1', enabled: true }, { id: 'kimi', route: 'r2', model: 'm2', enabled: true }] },
]
const envRetry = makeSwitchEnv(undefined, { startup: { preferTier: 1 }, tiers: RETRY_TIERS, retryPolicies: { SERVER: { attempts: 3, delayMs: 1, budgetMs: 100 } } })
const retryAgent = { session: { id: 'sess-retry', requestHeader: () => undefined } }
const retryFailure = { code: 'PI_AI_ERROR', message: 'codex-relay API error (502): 502 status code (no body)' }
for (let attempt = 0; attempt < 4; attempt += 1) await envRetry.handlers['agent/request-error']({ agent: retryAgent, provider: 'r1', turn: 1, step: 1, failure: retryFailure }, async () => 'NEXT')
const retryNotices = (await readNotices(envRetry, 'sess-retry')).filter((n) => n.kind === 'retry')
const retrySwitches = (await readNotices(envRetry, 'sess-retry')).filter((n) => n.kind === 'failover')
check('空体 502 落到 SERVER 档原地重试，次数由 attempts 收口', retryNotices.length === 3 && retryNotices.every((n) => String(n.trigger).startsWith('retry:SERVER')), JSON.stringify(retryNotices.map((n) => n.trigger)))
check('次数用尽后切换下一档，而不是无限原地重试', retrySwitches.length >= 1 && retrySwitches[0].toRoute === 'r2', JSON.stringify(retrySwitches.map((n) => n.toRoute)))
for (const dispose of envRetry.disposers) dispose()

console.log('路由观测隔离（故障转移目标不污染 base 基线）:')
const observationPatch = { probeTarget: false, minSwitchIntervalMs: 0, startup: { preferTier: 0 }, ranking: { mode: 'declared' }, tiers: RETRY_TIERS }
const envObserve = makeSwitchEnv(undefined, observationPatch)
const observeAgent = freshAgent('sess-observe')
const observePayload = { agent: observeAgent, turn: 1, step: 1 }
const originalBase = { provider: 'r-old', model: 'm-old' }
await envObserve.handlers['agent/request'](observePayload, async () => ({ ...originalBase }))
await envObserve.handlers['agent/request-error']({ ...observePayload, provider: 'r-old', model: 'm-old', failure: { code: 'QUOTA', message: 'quota exceeded' } }, async () => 'NEXT')
for (let attempt = 0; attempt < 3; attempt += 1) {
  const actual = await envObserve.handlers['agent/request'](observePayload, async () => ({ ...originalBase }))
  check('故障转移后的连续请求仍使用目标 ' + attempt, actual.provider === 'r1' && actual.model === 'm1', JSON.stringify(actual))
}
check('故障转移后旧 base 不再误报手动切回', (await readNotices(envObserve, 'sess-observe')).filter((n) => n.kind === 'manual-switch').length === 0)
const changedBase = { provider: 'r-external', model: 'm-external' }
await envObserve.handlers['agent/request']({ ...observePayload, step: 2 }, async () => ({ ...changedBase }))
await envObserve.handlers['agent/request']({ ...observePayload, step: 2 }, async () => ({ ...changedBase }))
const externalNotices = (await readNotices(envObserve, 'sess-observe')).filter((n) => n.kind === 'manual-switch')
check('真实外部 base 变更仍通知一次且起点是前一个 base', externalNotices.length === 1 && externalNotices[0].fromRoute === 'r-old' && externalNotices[0].toRoute === 'r-external', JSON.stringify(externalNotices))
await envObserve.handlers['agent/request']({ agent: freshAgent('sess-observe-other'), turn: 1, step: 1 }, async () => ({ ...changedBase }))
check('路由观测按会话隔离', (await readNotices(envObserve, 'sess-observe-other')).length === 0)

const envAlignObserve = makeSwitchEnv(undefined, { ...observationPatch, startup: { preferTier: 1 } })
const alignAgent = freshAgent('sess-align-observe')
for (let attempt = 0; attempt < 2; attempt += 1) {
  const actual = await envAlignObserve.handlers['agent/request']({ agent: alignAgent, turn: 1, step: 1 }, async () => ({ ...originalBase }))
  check('启动对齐后的请求仍使用目标 ' + attempt, actual.provider === 'r1', JSON.stringify(actual))
}
check('启动对齐后旧 base 不误报手动切换', (await readNotices(envAlignObserve, 'sess-align-observe')).filter((n) => n.kind === 'manual-switch').length === 0)

const envPinObserve = makeSwitchEnv(controllerStub, SWITCH_PATCH)
const pinAgent = freshAgent('sess-pin-observe')
await envPinObserve.handlers['agent/request']({ agent: pinAgent, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
await postTest(envPinObserve, { sessionId: 'sess-pin-observe', entry: 'relay' })
// 官方选模尚未反映在 base 时，pin 生效也不能制造反向切换通知。
await envPinObserve.handlers['agent/request']({ agent: pinAgent, turn: 1, step: 1 }, async () => ({ provider: 'r1', model: 'm1' }))
await envPinObserve.handlers['agent/request']({ agent: pinAgent, turn: 1, step: 1 }, async () => ({ provider: 'r2', model: 'm2' }))
const pinNotices = (await readNotices(envPinObserve, 'sess-pin-observe')).filter((n) => n.kind === 'manual-switch')
check('测试切换在旧 base 与选模同步后都不重复通知', pinNotices.length === 1 && pinNotices[0].code === 'TEST', JSON.stringify(pinNotices))
await envPinObserve.handlers['agent/request']({ agent: pinAgent, turn: 1, step: 2 }, async () => ({ provider: 'r3', model: 'm3' }))
await envPinObserve.handlers['agent/request']({ agent: pinAgent, turn: 1, step: 3 }, async () => ({ provider: 'r2', model: 'm2' }))
const returnToPinNotices = (await readNotices(envPinObserve, 'sess-pin-observe')).filter((n) => n.kind === 'manual-switch' && n.code === 'MANUAL')
check('测试同步只去重一次，之后外部切走再切回 pin 仍通知', returnToPinNotices.length === 2 && returnToPinNotices[0].fromRoute === 'r3' && returnToPinNotices[0].toRoute === 'r2', JSON.stringify(returnToPinNotices))
for (const env of [envObserve, envAlignObserve, envPinObserve]) for (const dispose of env.disposers) dispose()

check('真实设置文件未被探针触碰', existsSync(realSettingsFile) === realFileExisted, realSettingsFile)
cleanupHomes()

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + failures.length)
process.exitCode = failures.length === 0 ? 0 : 1
