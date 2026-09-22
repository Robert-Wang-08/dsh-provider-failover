/**
 * M1 冒烟测试（不依赖 dsh 运行时）：校验 index.js 的导出形状与配置归一化。
 *   node probe/smoke-config.mjs
 */
import { apply, defaultConfig, name, inject, normalize, __test } from '../index.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok === true) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra))
  }
}

console.log('exports:')
check('name', name === 'dsh-provider-failover', name)
check('inject is empty', JSON.stringify(inject) === '[]', JSON.stringify(inject))
check('apply is function', typeof apply === 'function')
check('defaultConfig is function', typeof defaultConfig === 'function')

console.log('defaults:')
const defaults = defaultConfig()
check('one example tier (disabled, zero-intervention)', defaults.tiers.length === 1 && defaults.tiers[0].enabled === false, JSON.stringify(defaults.tiers))
check('example entry is placeholder', defaults.tiers[0].entries.length === 1 && defaults.tiers[0].entries[0].id === 'example' && defaults.tiers[0].entries[0].route === 'example-provider', JSON.stringify(defaults.tiers[0].entries))
check('startup preferTier = 1', defaults.startup.preferTier === 1)
check('terminal codes include SERVER + RATE_LIMIT', defaults.terminalCodes.includes('SERVER') && defaults.terminalCodes.includes('RATE_LIMIT'))
check('no credential field anywhere', JSON.stringify(defaults).toLowerCase().indexOf('apikeyenv') < 0)

console.log('normalize:')
const good = normalize({ tiers: [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'r', model: 'm', cooldownMs: 5000 }] }] })
check('accepts a minimal valid table', good.errors.length === 0, JSON.stringify(good.errors))
check('defaults applied (ranking.keys→mode stays keywords)', good.value.ranking.mode === 'keywords')

const missingRoute = normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', model: 'm' }] }] })
check('rejects entry without route', missingRoute.errors.some((error) => error.includes('route is required')))

const badCooldown = normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r', model: 'm', cooldownMs: 0 }] }] })
check('rejects non-positive cooldownMs', badCooldown.errors.some((error) => error.includes('cooldownMs')))

const dupId = normalize({ tiers: [{ tier: 1, entries: [{ id: 'x', route: 'r1', model: 'm' }, { id: 'x', route: 'r2', model: 'm' }] }] })
check('rejects duplicate entry id', dupId.errors.some((error) => error.includes('duplicate entry id')))

const badMode = normalize({ ranking: { mode: 'bogus' } })
check('rejects unknown ranking mode', badMode.errors.some((error) => error.includes('ranking.mode')))

const badTier = normalize({ startup: { preferTier: -1 } })
check('rejects negative preferTier', badTier.errors.some((error) => error.includes('startup.preferTier')))

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

console.log('apply 假 ctx（settings/webServer/provider 目录关联）:')
const makeCtx = (providers, options) => {
  const opts = options ?? {}
  const namespaces = []
  const routes = {}
  const updated = []
  const mutations = []
  const handlers = {}
  const disposers = []
  const providerSection = { providers: opts.providerSection ?? {} }
  const refInfo = opts.refInfo ?? {}
  const settingsScope = {
    get: () => ({ enabled: true, minSwitchIntervalMs: 1000, maxSwitchesPerTurn: 6, startupPreferTier: 1, rankingMode: 'keywords', keyResetAt: '06:00' }),
    watch: () => () => {},
    update: async (patch) => { updated.push(patch) },
  }
  const settingsProvider = {
    register: (ns) => { namespaces.push(ns); return settingsScope },
    get: (ns) => ns === 'llm-pi-ai' ? providerSection : undefined,
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  const credentials = { describe: async (ref) => refInfo[ref] ?? { configured: false } }
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    on: (event, fn) => { handlers[event] = fn },
    get: (n) => n === 'llm' ? providers : n === 'settings' ? settingsProvider : n === 'credentials' ? credentials : undefined,
    inject: (deps, cb) => {
      if (deps.includes('settings')) cb({ settings: settingsProvider })
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } } })
    },
  }
  return { ctx, namespaces, routes, updated, mutations, handlers, disposers }
}
const res1 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const env1 = makeCtx({ listProviders: () => [{ id: 'example-provider', name: 'Example' }, { id: 'other-provider', name: 'Other' }], listConfigurableProviders: () => [] })
apply(env1.ctx, {})
check('注册 settings 命名空间 provider-failover', env1.namespaces.includes('provider-failover'), JSON.stringify(env1.namespaces))
check('注册 status/config/keys 三条路由', env1.routes['/provider-failover/status'] !== undefined && env1.routes['/provider-failover/config'] !== undefined && env1.routes['/provider-failover/keys'] !== undefined)
await env1.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res1)
check('snapshot 用 route 名关联目录', res1.body.tiers[0].entries[0].route === 'example-provider' && res1.body.tiers[0].entries[0].registered === true, JSON.stringify(res1.body.tiers?.[0]))
check('snapshot 计算 unassigned/missing', Array.isArray(res1.body.providers.unassigned) && res1.body.providers.unassigned.some((p) => p.id === 'other-provider') && res1.body.providers.missing.length === 0, JSON.stringify(res1.body.providers))
const postReq = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ enabled: false, evil: 1 })) } }
const res2 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
await env1.routes['/provider-failover/config'](postReq, res2)
check('/config 只接受白名单字段', res2.status === 200 && JSON.stringify(env1.updated.at(-1)) === JSON.stringify({ enabled: false }), JSON.stringify(env1.updated.at(-1)))
const res3 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const env3 = makeCtx({ listProviders: () => [], listConfigurableProviders: () => [] })
apply(env3.ctx, {})
await env3.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res3)
check('目录不可用时 providers=null 且不误标', res3.body.providers === null && res3.body.tiers[0].entries[0].registered === true, JSON.stringify(res3.body.providers) + ' ' + JSON.stringify(res3.body.tiers?.[0]?.entries?.[0]))

console.log('apply 假 ctx（凭据引用轮换路径）:')
const KEY_CONFIG = { keyResetAt: '06:00', tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm', keys: ['K1', 'K2'] }] }] }
const llmStub = { listProviders: () => [{ id: 'r1', name: 'R1' }], listConfigurableProviders: () => [] }
const failure = { failure: { code: 'AUTH', message: 'invalid api key' }, provider: 'r1', turn: 1, step: 1 }
const env4 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true, source: 'file' }, K2: { configured: true, source: 'file' } } })
apply(env4.ctx, KEY_CONFIG)
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
apply(env5.ctx, KEY_CONFIG)
const skipped = await env5.handlers['agent/request-error'](failure, async () => 'NEXT')
check('未配置的备用引用被跳过并交回宿主', skipped === 'NEXT' && env5.mutations.length === 0, JSON.stringify(skipped) + ' ' + JSON.stringify(env5.mutations))

const env6 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true }, K2: { configured: true } } })
apply(env6.ctx, KEY_CONFIG)
const overload = await env6.handlers['agent/request-error']({ failure: { code: 'SERVER', message: 'overloaded' }, provider: 'r1', turn: 1, step: 1 }, async () => 'NEXT')
check('过载不消耗 key 轮换（走 provider 切换）', env6.mutations.length === 0, JSON.stringify(env6.mutations))

const res7 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const manualReq = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ entry: 'ais', ref: 'K2' })) } }
const env7 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true }, K2: { configured: true } } })
apply(env7.ctx, KEY_CONFIG)
await env7.routes['/provider-failover/keys'](manualReq, res7)
check('手工置位写入指定引用', res7.status === 200 && res7.body.ok === true && JSON.stringify(env7.mutations[0]?.ops?.[0]?.value) === '"K2"', JSON.stringify({ status: res7.status, mutations: env7.mutations }))
const res8 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const badReq = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ entry: 'ais', ref: 'NOT_DECLARED' })) } }
const env8 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true } } })
apply(env8.ctx, KEY_CONFIG)
await env8.routes['/provider-failover/keys'](badReq, res8)
check('手工置位拒绝未声明的引用', res8.body.ok === false && env8.mutations.length === 0, JSON.stringify(res8.body))

for (const env of [env4, env5, env6, env7, env8]) for (const dispose of env.disposers) dispose()

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + failures.length)
process.exitCode = failures.length === 0 ? 0 : 1
