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

console.log('entry.keys（条目内 key 轮换，opt-in）:')
check('entries without keys normalize to empty array', Array.isArray(good.value.tiers[0].entries[0].keys) && good.value.tiers[0].entries[0].keys.length === 0, JSON.stringify(good.value.tiers[0].entries[0]))
const withKeys = normalize({ tiers: [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r2', 'r3'] }] }] })
check('accepts keys[] and preserves order', withKeys.errors.length === 0 && JSON.stringify(withKeys.value.tiers[0].entries[0].keys) === JSON.stringify(['r2', 'r3']), JSON.stringify(withKeys))
check('rejects keys item equal to entry.route', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r', model: 'm', keys: ['r'] }] }] }).errors.some((error) => error.includes('must not repeat entry.route')))
check('rejects duplicate key route within keys', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r2', 'r2'] }] }] }).errors.some((error) => error.includes('duplicate key route in entry.keys')))
check('rejects non-string keys item', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: [7] }] }] }).errors.some((error) => error.includes('entry.keys items must be non-empty strings')))
check('rejects keys[] declaring nothing usable', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r', model: 'm', keys: ['r'] }] }] }).errors.some((error) => error.includes('declares no usable distinct key route')))
check('rejects non-array keys', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: 'r2' }] }] }).errors.some((error) => error.includes('entry.keys must be an array')))
check('rejects route key reused across entries (key 池不跨 provider)', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r2'] }, { id: 'b', route: 'r2', model: 'm' }] }] }).errors.some((error) => error.includes('each key serves a single provider')))
check('rejects primary route reused as another entry key', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm' }, { id: 'b', route: 'r3', model: 'm', keys: ['r1'] }] }] }).errors.some((error) => error.includes('each key serves a single provider')))
check('rejects same key route in two entries keys', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r9'] }, { id: 'b', route: 'r2', model: 'm', keys: ['r9'] }] }] }).errors.some((error) => error.includes('each key serves a single provider')))
check('key uniqueness is global across tiers', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r9'] }] }, { tier: 2, entries: [{ id: 'b', route: 'r2', model: 'm', keys: ['r9'] }] }] }).errors.some((error) => error.includes('each key serves a single provider')))
check('distinct keys across entries are fine', normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r2'] }, { id: 'b', route: 'r3', model: 'm', keys: ['r4'] }] }] }).errors.length === 0, JSON.stringify(normalize({ tiers: [{ tier: 1, entries: [{ id: 'a', route: 'r1', model: 'm', keys: ['r2'] }, { id: 'b', route: 'r3', model: 'm', keys: ['r4'] }] }] }).errors))

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
const makeCtx = (providers) => {
  const namespaces = []
  const routes = {}
  const updated = []
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { fn(); return () => {} },
    on: () => {},
    get: (n) => n === 'llm' ? providers : undefined,
    inject: (deps, cb) => {
      if (deps.includes('settings')) cb({ settings: { register: (ns, schema, opts) => { namespaces.push(ns); return { get: () => ({ enabled: true, minSwitchIntervalMs: 1000, maxSwitchesPerTurn: 6, startupPreferTier: 1, rankingMode: 'keywords' }), watch: () => () => {}, update: async (patch) => { updated.push(patch) } } } } })
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } } })
    },
  }
  return { ctx, namespaces, routes, updated }
}
const res1 = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } }
const env1 = makeCtx({ listProviders: () => [{ id: 'example-provider', name: 'Example' }, { id: 'other-provider', name: 'Other' }], listConfigurableProviders: () => [] })
apply(env1.ctx, {})
check('注册 settings 命名空间 provider-failover', env1.namespaces.includes('provider-failover'), JSON.stringify(env1.namespaces))
check('注册 status/config 两条路由', env1.routes['/provider-failover/status'] !== undefined && env1.routes['/provider-failover/config'] !== undefined)
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

console.log(failures.length === 0 ? '\nALL PASSED' : '\nFAILURES: ' + failures.length)
process.exitCode = failures.length === 0 ? 0 : 1
