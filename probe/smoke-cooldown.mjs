/**
 * 冷却语义冒烟（不依赖 dsh 运行时）：验证 2026-10-23 的三条修正。
 *   node probe/smoke-cooldown.mjs
 *
 * 背景（docs/ptc/reports/failover-kimi-quota-20261023.md）：
 * 2026-10-23 kimi 报额度耗尽时没有切换，because tier1/tier2 五条路由被一串网络抖动
 * 逐个冻结 30 分钟，候选池为空；而「无候选」只写进内存 ignored 环，用户看不到原因。
 *
 * 本探针固定三条不变量：
 *   1) 无候选时**不冻结**失败路由（失败但没切走，不该让唯一可用的路由进入冷却）；
 *   2) 无候选必须落一条会话可见通知（kind=exhausted，进 notices.jsonl），不再静默；
 *   3) 冷却只延长不缩短（QUOTA 的 5 小时不得被随后一条 SERVER 的 60 秒覆盖）。
 *
 * 全程 DSH_HOME 指向临时目录，绝不触碰真实 ~/.dsh。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const home = mkdtempSync(join(tmpdir(), 'dsh-keypool-cooldown-'))
process.env.DSH_HOME = home

const failures = []
const check = (label, ok, extra) => {
  if (ok === true) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra))
  }
}

const makeCtx = () => {
  const routes = {}
  const handlers = {}
  const ctx = {
    logger: { warn: () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: (event, fn) => { handlers[event] = fn },
    get: () => undefined,
    inject: (deps, cb) => {
      if (deps.includes('webServer') === true) cb({ webServer: { register: (r) => { routes[r.path] = r.handler; return () => {} } } })
    },
  }
  return { ctx, routes, handlers }
}
const newRes = () => ({ status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = JSON.parse(b) } })
const readStatus = async (env) => {
  const res = newRes()
  await env.routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, res)
  return res.body
}
const readNotices = async (env, sessionId) => {
  const res = newRes()
  await env.routes['/provider-failover/notices']({ url: '/provider-failover/notices?sessionId=' + sessionId, socket: { remoteAddress: '127.0.0.1' } }, res)
  return res.body
}
const agentOf = (id) => ({ session: { id } })
const fail = (code, message, provider, turn, step) => ({ failure: { code, message }, provider, turn, step, agent: agentOf('s-cooldown') })

const FIVE_HOURS = 18000000
const TWO_ENTRIES = {
  minSwitchIntervalMs: 0,
  cooldownByCode: { QUOTA: FIVE_HOURS, SERVER: 60000, TRANSPORT: 60000 },
  tiers: [{
    tier: 1,
    enabled: true,
    entries: [
      { id: 'r1', route: 'r1', model: 'm1', cooldownMs: 60000 },
      { id: 'r2', route: 'r2', model: 'm1', cooldownMs: 60000 },
    ],
  }],
}

console.log('无候选：不冻结、不重试、必须留痕:')
{
  const env = makeCtx()
  apply(env.ctx, { minSwitchIntervalMs: 0, tiers: [{ tier: 1, enabled: true, entries: [{ id: 'only', route: 'solo', model: 'm', cooldownMs: 60000 }] }] })
  const decision = await env.handlers['agent/request-error'](fail('QUOTA', 'quota exceeded', 'solo', 1, 1), async () => 'NEXT')
  check('交回宿主（不原地重试）', decision === 'NEXT', JSON.stringify(decision))
  const status = await readStatus(env)
  check('唯一可用路由不被冻结', Array.isArray(status.cooling) && status.cooling.length === 0, JSON.stringify(status.cooling))
  const feed = await readNotices(env, 's-cooldown')
  const notice = (feed.notices ?? []).find((item) => item.kind === 'exhausted')
  check('落 kind=exhausted 的会话可见通知', notice !== undefined && notice.code === 'QUOTA', JSON.stringify(feed.notices))
  check('通知点名「无可用候选」并带冷却摘要', notice !== undefined && String(notice.detail).includes('无可用候选') && String(notice.detail).includes('冷却中'), notice === undefined ? '(none)' : String(notice.detail))
  const file = join(home, 'plugins', 'provider-failover', 'notices.jsonl')
  const persisted = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check('通知落盘 notices.jsonl（可回看）', persisted.includes('"kind":"exhausted"'), persisted.slice(0, 200))
}

console.log('冷却写入时机：选中候选之后:')
const envSwitch = makeCtx()
apply(envSwitch.ctx, TWO_ENTRIES)
{
  const decision = await envSwitch.handlers['agent/request-error'](fail('QUOTA', 'quota exceeded', 'r1', 1, 1), async () => 'NEXT')
  check('有候选时切换并重试', decision?.kind === 'retry', JSON.stringify(decision))
  const status = await readStatus(envSwitch)
  const cooling = (status.cooling ?? []).find((item) => item.route === 'r1')
  check('切换后失败路由进入冷却', cooling !== undefined, JSON.stringify(status.cooling))
  check('QUOTA 冷却按 cooldownByCode 取 5 小时', cooling !== undefined && cooling.code === 'QUOTA' && Math.abs((cooling.until - Date.now()) - FIVE_HOURS) < 15000, JSON.stringify(cooling))
}

console.log('冷却只延长不缩短:')
{
  // 同一路由随后一条 SERVER：cooldownByCode.SERVER=60s，但不得把 5 小时压缩成 60 秒。
  const env = makeCtx()
  apply(env.ctx, { ...TWO_ENTRIES, retryPolicies: { SERVER: { attempts: 0 } } })
  const first = await env.handlers['agent/request-error'](fail('QUOTA', 'quota exceeded', 'r1', 1, 1), async () => 'NEXT')
  const afterQuota = (await readStatus(env)).cooling.find((item) => item.route === 'r1')
  const second = await env.handlers['agent/request-error'](fail('SERVER', '502 status code (no body)', 'r1', 1, 3), async () => 'NEXT')
  const afterServer = (await readStatus(env)).cooling.find((item) => item.route === 'r1')
  check('两条失败都触发了切换', first?.kind === 'retry' && second?.kind === 'retry', JSON.stringify([first, second]))
  check('QUOTA 后冷却约 5 小时', afterQuota !== undefined && Math.abs((afterQuota.until - Date.now()) - FIVE_HOURS) < 15000, JSON.stringify(afterQuota))
  const drift = afterServer === undefined || afterQuota === undefined ? Number.POSITIVE_INFINITY : afterServer.until - afterQuota.until
  check('随后的 SERVER 不缩短既有 5 小时冷却', afterServer !== undefined && drift <= 0 && (afterServer.until - Date.now()) > FIVE_HOURS - 20000, JSON.stringify([afterQuota, afterServer]))
}

console.log('未归一化的额度耗尽也按类别取冷却:')
{
  // 宿主管线里 code 可能仍是 PI_AI_ERROR（Codex 自然语言额度、网关自定义码），
  // 只要折算出了 effective:QUOTA，就必须吃到 QUOTA 的 5 小时，而不是条目兜底的 60 秒。
  const { __test } = await import('../index.js')
  const map = { QUOTA: FIVE_HOURS, TRANSPORT: 60000, SERVER: 60000 }
  check('effective:QUOTA 按 5 小时冷却', __test.cooldownMsFor(map, 60000, 'PI_AI_ERROR', 'effective:QUOTA') === FIVE_HOURS, String(__test.cooldownMsFor(map, 60000, 'PI_AI_ERROR', 'effective:QUOTA')))
  check('effective:TRANSPORT 按 60 秒冷却', __test.cooldownMsFor(map, 1800000, 'PI_AI_ERROR', 'effective:TRANSPORT') === 60000, String(__test.cooldownMsFor(map, 1800000, 'PI_AI_ERROR', 'effective:TRANSPORT')))
  check('未登记类别仍回退条目 cooldownMs', __test.cooldownMsFor(map, 120000, 'PI_AI_ERROR', 'effective:WHATEVER') === 120000, String(__test.cooldownMsFor(map, 120000, 'PI_AI_ERROR', 'effective:WHATEVER')))
}

console.log('瞬时故障的冷却时长可配置:')
{
  const env = makeCtx()
  apply(env.ctx, { ...TWO_ENTRIES, retryPolicies: { TRANSPORT: { attempts: 0 } } })
  const decision = await env.handlers['agent/request-error'](fail('TRANSPORT', 'fetch failed', 'r1', 1, 1), async () => 'NEXT')
  const cooling = (await readStatus(env)).cooling.find((item) => item.route === 'r1')
  check('TRANSPORT 失败照样切换', decision?.kind === 'retry', JSON.stringify(decision))
  check('TRANSPORT 冷却取 cooldownByCode 的 60 秒', cooling !== undefined && cooling.code === 'TRANSPORT' && cooling.until - Date.now() <= 65000, JSON.stringify(cooling))
}

rmSync(home, { recursive: true, force: true })
if (process.env.DSH_HOME === home) process.env.DSH_HOME = realHome
console.log('')
if (failures.length > 0) {
  console.log('FAILED (' + String(failures.length) + '): ' + failures.join(' | '))
  process.exitCode = 1
} else console.log('ALL PASSED')
