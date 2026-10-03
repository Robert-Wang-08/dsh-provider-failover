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
check('startup preferTier 默认 0（关闭启动对齐，保持会话选择）', defaults.startup.preferTier === 0, String(defaults.startup.preferTier))
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
    get: () => ({ enabled: true, minSwitchIntervalMs: 1000, maxSwitchesPerTurn: 6, startupPreferTier: 1, rankingMode: 'keywords', keyResetAt: '06:00', keysByEntry: opts.keysByEntry ?? {} }),
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

// a) 设置层 keys 覆盖 patch（patch 未声明 keys），并按需启用每日重置排程
const env9 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true, source: 'file' }, K9: { configured: true, source: 'file' } }, keysByEntry: { ais: ['K1', 'K9'] } })
apply(env9.ctx, { tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm' }] }] })
const res9 = await statusOf(env9)
check('设置层 keys 覆盖 patch keys', res9.body.tiers[0].entries[0].keys.length === 2 && res9.body.tiers[0].entries[0].keysSource === 'settings', JSON.stringify(res9.body.tiers[0].entries[0]))
check('patch 无 keys 时默认不排程、有覆盖时按需排程', env9.disposers.length === 6, String(env9.disposers.length))
const noKeys = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' } }, refInfo: { K1: { configured: true } } })
apply(noKeys.ctx, { tiers: [{ tier: 1, enabled: true, entries: [{ id: 'ais', route: 'r1', model: 'm' }] }] })
check('无任何 key 引用时不排程每日重置', noKeys.disposers.length === 5, String(noKeys.disposers.length))

// b) 轮换使用设置层 keys
const rotated9 = await env9.handlers['agent/request-error'](failure, async () => 'NEXT')
check('轮换按设置层 keys 前进（K1 → K9）', rotated9?.kind === 'retry' && env9.mutations[0]?.ops?.[0]?.value === 'K9', JSON.stringify(env9.mutations))

// c) 失效状态字段（时间 / 编码 / 消息）
const res10 = await statusOf(env9)
const failedKey = res10.body.tiers[0].entries[0].keys.find((key) => key.ref === 'K1')
check('失效 key 带时间与错误', failedKey?.failed === true && typeof failedKey.failedAt === 'number' && failedKey.failedCode === 'AUTH' && String(failedKey.failedMessage).includes('invalid api key'), JSON.stringify(failedKey))

// d) /config 校验
const env11 = makeCtx(llmStub, { providerSection: { r1: { apiKeyEnv: 'K1' }, r2: { apiKeyEnv: 'K2' } }, refInfo: { K1: { configured: true }, K2: { configured: true }, K3: { configured: true } } })
apply(env11.ctx, TWO_ENTRIES)
check('拒绝条目内重复引用', (await postConfig(env11, { keysByEntry: { ais: ['K1', 'K1'] } })).body.error?.includes('repeats') === true)
check('拒绝非法引用名', (await postConfig(env11, { keysByEntry: { ais: ['not a ref'] } })).body.error?.includes('invalid credential reference name') === true)
check('拒绝未知条目 id', (await postConfig(env11, { keysByEntry: { nope: ['K1'] } })).body.error?.includes('unknown entry id') === true)
check('拒绝跨条目复用引用', (await postConfig(env11, { keysByEntry: { ais: ['K3'], codex: ['K3'] } })).body.error?.includes('used by both entry') === true)
check('非法写入不改动现有配置', env11.updated.length === 0 && env11.mutations.length === 0, JSON.stringify(env11.updated))
const okConfig = await postConfig(env11, { keysByEntry: { ais: ['K1', 'K3'] } })
check('合法写入被接受并落盘', okConfig.status === 200 && JSON.stringify(env11.updated.at(-1)) === JSON.stringify({ keysByEntry: { ais: ['K1', 'K3'] } }), JSON.stringify(env11.updated.at(-1)))
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

// 最小同构 ctx：只挂测试切换需要的能力（settings / webServer / commands / sessionController）
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
      if (deps.includes('settings')) cb({ settings: { register: () => ({ get: () => ({ enabled: true, minSwitchIntervalMs: 1000, maxSwitchesPerTurn: 6, startupPreferTier: 1, rankingMode: 'keywords', keyResetAt: '06:00', keysByEntry: {} }), watch: () => () => {}, update: async () => {} }) } })
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } } })
      if (deps.includes('commands')) cb({ commands: { register: (def) => { logs.push(def); return () => {} } } })
    },
  }
  apply(ctx, patch)
  return { routes, disposers, handlers, registered: logs }
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
check('可切换失败不写 ignored', (status23.body.ignored?.length ?? 0) === 0, JSON.stringify(status23.body.ignored))
for (const env of [env22, env23]) for (const dispose of env.disposers) dispose()

// 2026-10-02：全量测试——对启用档位的每个 provider/model 发最小真实请求并列出状态。
console.log('全量测试（真实最小请求 + 状态分类）:')
check('classifyProbeFailure 额度不足', __test.classifyProbeFailure('QUOTA', 'quota exceeded').label === '额度不足')
check('classifyProbeFailure 超时兜底', __test.classifyProbeFailure(undefined, 'request timed out').status === 'TIMEOUT')
check('classifyProbeFailure 未知编码', __test.classifyProbeFailure(undefined, 'weird thing').label === '未知错误')

const PROBE_TIERS = [
  { tier: 1, enabled: true, entries: [
    { id: 'good', route: 'r-good', model: 'm-good', enabled: true },
    { id: 'bad', route: 'r-bad', model: 'm-bad', enabled: true },
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
check('全量测试只覆盖启用档位的启用条目', probeRes24.body.results.length === 2 && probeRes24.body.results.every((item) => item.id !== 'off' && item.id !== 'offtier'), JSON.stringify(probeRes24.body.results.map((item) => item.id)))
check('正常目标回报 OK + 回复', probeRes24.body.results.find((item) => item.id === 'good')?.status === 'OK' && probeRes24.body.results.find((item) => item.id === 'good')?.reply === 'ok', JSON.stringify(probeRes24.body.results.find((item) => item.id === 'good')))
check('额度不足目标回报 QUOTA', probeRes24.body.results.find((item) => item.id === 'bad')?.status === 'QUOTA' && probeRes24.body.results.find((item) => item.id === 'bad')?.label === '额度不足', JSON.stringify(probeRes24.body.results.find((item) => item.id === 'bad')))
check('全量测试汇总', probeRes24.body.summary.total === 2 && probeRes24.body.summary.ok === 1 && probeRes24.body.summary.failed === 1, JSON.stringify(probeRes24.body.summary))
const status24 = await statusOf(env24)
check('status 暴露 lastProbe 与 probeTimeoutMs', status24.body.lastProbe?.results?.length === 2 && typeof status24.body.probeTimeoutMs === 'number', JSON.stringify(status24.body.lastProbe?.summary))
const single24 = await postProbe(env24, { entry: 'bad' })
check('单条目过滤', single24.body.results.length === 1 && single24.body.results[0].id === 'bad', JSON.stringify(single24.body.results.map((item) => item.id)))
check('未知条目报错', (await postProbe(env24, { entry: 'nope' })).status === 400)
check('探测请求始终携带会话身份（opencode-go 需 x-opencode-session）', probeSeen.length >= 2 && probeSeen.every((request) => typeof request.sessionId === 'string' && request.sessionId.length > 0), JSON.stringify(probeSeen.map((request) => request.sessionId)))
const explicit24 = await postProbe(env24, { entry: 'good', sessionId: 'sess-explicit' })
check('显式 sessionId 透传到探测请求与报告', explicit24.body.sessionId === 'sess-explicit' && probeSeen.at(-1).sessionId === 'sess-explicit', String(probeSeen.at(-1).sessionId))
const probeCmd = env24.registered.find((def) => def.name === 'failover-probe')
const cmdProbe = await probeCmd.handler({ rawInput: '', agent: { session: { id: 'x' } } })
check('指令 /failover-probe 返回汇总文本', cmdProbe.kind === 'success' && cmdProbe.text.includes('1/2'), String(cmdProbe.text))
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
const { readFileSync } = await import('node:fs')
check('client.js 渲染「最近未切换原因」（status.ignored）', readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes('status.ignored'))

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + failures.length)
process.exitCode = failures.length === 0 ? 0 : 1
