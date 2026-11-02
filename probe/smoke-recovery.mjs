/** Request recovery regression; isolated DSH_HOME, no network or credentials. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, defaultConfig, __test } from '../index.js'

const MESSAGE = 'server_error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 281a8b8a-b34e-4630-9fbb-96a25b4b1602 in your message.'
const previousHome = process.env.DSH_HOME
const homes = []
function fixture(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-recovery-'))
  homes.push(home)
  process.env.DSH_HOME = home
  const handlers = {}
  const routes = {}
  const ctx = {
    on: (event, fn) => { handlers[event] = fn },
    get: name => name === 'sessionController' ? { selectModel: async request => ({ selected: { provider: request.provider, model: request.model } }) } : undefined,
    effect: fn => fn(),
    logger: { warn() {} },
    inject: (deps, cb) => {
      if (deps.includes('webServer')) cb({ webServer: { register(r) { routes[r.path] = r.handler; return () => {} } } })
    },
  }
  apply(ctx, {
    minSwitchIntervalMs: 0,
    retryPolicies: { SERVER: { attempts: 2, delayMs: 1, budgetMs: 10 } },
    tiers: [{ tier: 1, enabled: true, entries: [
      { id: 'a', route: 'a', model: 'm' },
      { id: 'b', route: 'b', model: 'm' },
    ] }],
    ...overrides,
  })
  const payload = (session = 's', step = 14, provider = 'a', message = MESSAGE, signal) => ({
    agent: { session: { id: session } }, turn: 40, step, provider,
    failure: { code: 'PI_AI_ERROR', message }, signal,
  })
  const fail = (...args) => handlers['agent/request-error'](payload(...args), async () => 'NEXT')
  const request = (session = 's', step = 14) => handlers['agent/request'](payload(session, step), async () => ({ provider: 'a', model: 'm' }))
  const status = async () => {
    let value
    await routes['/provider-failover/status']({ socket: { remoteAddress: '127.0.0.1' } }, { writeHead() {}, end(body) { value = JSON.parse(body) } })
    return value
  }
  const pin = async () => {
    let value
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 's', entry: 'a' })) } }
    await routes['/provider-failover/test'](req, { writeHead() {}, end(body) { value = JSON.parse(body) } })
    assert.equal(value.ok, true)
  }
  return { home, fail, request, status, pin }
}

try {
  const defaults = defaultConfig()
  for (const code of ['server_error', 'internal_server_error', 'overloaded_error', 'service_unavailable']) {
    assert.equal(__test.effectiveFailureCode('PI_AI_ERROR', code + ': request failed', defaults.failurePatterns), 'SERVER', code)
    assert.equal(__test.effectiveFailureCode(code, 'request failed', defaults.failurePatterns), 'SERVER', code + ' raw code')
    assert.equal(__test.classifyProbeFailure(code, 'request failed', defaults.failurePatterns).status, 'SERVER')
  }
  assert.equal(__test.effectiveFailureCode('PI_AI_ERROR', MESSAGE, defaults.failurePatterns), 'SERVER')
  const shape = { terminalCodes: new Set(defaults.terminalCodes), failurePatterns: defaults.failurePatterns }
  assert.equal(__test.isSwitchable(shape, 'PI_AI_ERROR', MESSAGE).hit, true)
  assert.equal(__test.classifyProbeFailure('PI_AI_ERROR', MESSAGE, defaults.failurePatterns).status, 'SERVER')
  assert.equal(__test.effectiveFailureCode('INVALID_REQUEST', MESSAGE, defaults.failurePatterns), 'INVALID_REQUEST')
  assert.equal(__test.isSwitchable(shape, 'INVALID_REQUEST', MESSAGE).hit, false)
  assert.equal(__test.isSwitchable(shape, 'PI_AI_ERROR', 'An error occurred while processing your request').hit, false)
  assert.equal(__test.isSwitchable(shape, 'PI_AI_ERROR', 'application validation failed').hit, false)

  // An overloaded response followed by generic server_error must share one budget.
  const f = fixture()
  assert.equal((await f.fail('s', 14, 'a', 'server_error: Our servers are currently overloaded. Please try again later.')).kind, 'retry')
  assert.equal((await f.request()).provider, 'a')
  assert.equal((await f.fail()).kind, 'retry')
  assert.equal((await f.request()).provider, 'a')
  assert.equal((await f.fail()).kind, 'retry')
  assert.equal((await f.request()).provider, 'b', 'exhausted budget must switch actual next request')
  assert.equal((await f.request('other')).provider, 'a', 'target must be session-local')
  assert.equal(await f.fail('s', 14, 'b'), 'NEXT', 'all routes exhausted must stop')
  const records = readFileSync(join(f.home, 'plugins/provider-failover/failures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(records.every(r => r.effectiveCode === 'SERVER'))
  const notices = readFileSync(join(f.home, 'plugins/provider-failover/notices.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(notices.some(r => r.kind === 'retry' && r.code === 'SERVER'))
  assert.ok(notices.some(r => r.kind === 'failover' && r.toRoute === 'b'))
  assert.ok(notices.some(r => r.kind === 'exhausted'))
  assert.equal((await f.fail('other')).kind, 'retry', 'other session has independent budget')
  assert.equal((await f.fail('s', 15)).kind, 'retry', 'new step has independent budget')

  const disabled = fixture({ enabled: false })
  assert.equal(await disabled.fail(), 'NEXT')
  const capped = fixture({ maxSwitchesPerTurn: 1, retryPolicies: { SERVER: { attempts: 0 } } })
  assert.equal((await capped.fail()).kind, 'retry')
  assert.equal(await capped.fail('s', 14, 'b'), 'NEXT')

  const pinned = fixture({ retryPolicies: { SERVER: { attempts: 0 } } })
  await pinned.pin()
  assert.equal((await pinned.request()).provider, 'a')
  assert.equal((await pinned.fail()).kind, 'retry')
  assert.equal((await pinned.request()).provider, 'b', 'failed test pin must not override failover')
  assert.equal((await pinned.status()).pins.length, 0, 'failed pin must not pull next step back')

  for (const guard of [{ minSwitchIntervalMs: 60000 }, { maxSwitchesPerTurn: 1 }]) {
    const guarded = fixture({ ...guard, retryPolicies: { SERVER: { attempts: 1, delayMs: 1, budgetMs: 1 } } })
    assert.equal((await guarded.fail('s', 14, 'a', 'quota exceeded')).kind, 'retry')
    assert.equal((await guarded.request()).provider, 'b')
    assert.equal((await guarded.fail('s', 14, 'b')).kind, 'retry', 'switch guards must allow remaining transient retry')
    assert.equal(await guarded.fail('s', 14, 'b'), 'NEXT', 'guards still bound further switches')
  }

  // Aborting a backoff should reject promptly, without a retry or a candidate selection.
  const cancel = fixture({ retryPolicies: { SERVER: { attempts: 2, delayMs: 30000, budgetMs: 60000 } } })
  const controller = new AbortController()
  const pending = cancel.fail('s', 14, 'a', MESSAGE, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal((await cancel.status()).switches.filter(item => item.kind === 'failover').length, 0)
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(cancel.fail('pre-aborted', 14, 'a', MESSAGE, preAborted.signal), { name: 'AbortError' })
  console.log('PASS: symbolic errors, mixed-message budget, actual request failover, exhaustion, session/step isolation, disabled/capped recovery, cancellation')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const home of homes) rmSync(home, { recursive: true, force: true })
}
