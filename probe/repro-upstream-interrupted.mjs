/** Repro: PI_AI_ERROR wording "Upstream response stream was interrupted" escapes the failover plugin.
 * Red  = incident wording returned as NEXT (no retry, no switch) -> turn dies in host agent-loop.
 * Green controls prove the harness sees TRANSPORT-class failures correctly.
 *   node probe/repro-upstream-interrupted.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, defaultConfig, __test } from '../index.js'

const previousHome = process.env.DSH_HOME
const homes = []
function fixture(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-repro-upstream-'))
  homes.push(home)
  process.env.DSH_HOME = home
  const handlers = {}
  const ctx = {
    on: (event, fn) => { handlers[event] = fn },
    get: name => name === 'sessionController' ? { selectModel: async request => ({ selected: { provider: request.provider, model: request.model } }) } : undefined,
    effect: fn => fn(),
    logger: { warn() {} },
    inject: (deps, cb) => { if (deps.includes('webServer')) cb({ webServer: { register(r) { return () => {} } } }) },
  }
  apply(ctx, {
    minSwitchIntervalMs: 0,
    retryPolicies: { TRANSPORT: { attempts: 2, delayMs: 1, budgetMs: 10, observationWindowMs: 30000 } },
    tiers: [{ tier: 1, enabled: true, entries: [
      { id: 'a', route: 'a', model: 'm' },
      { id: 'b', route: 'b', model: 'm' },
    ] }],
    ...overrides,
  })
  const payload = (step = 11, provider = 'a', message, code = 'PI_AI_ERROR') => ({
    agent: { session: { id: 'incident' } }, turn: 1, step, provider,
    failure: { code, message },
  })
  const fail = (...args) => handlers['agent/request-error'](payload(...args), async () => 'NEXT')
  return { home, fail }
}

const INCIDENT = 'Upstream response stream was interrupted'
const results = { red: [], green: [] }
try {
  // Control 1: raw normalized TRANSPORT code is retried today.
  const control = fixture()
  const controlAction = await control.fail(11, 'a', 'Connection error.', 'TRANSPORT')
  ;(controlAction.kind === 'retry' ? results.green : results.red).push('control TRANSPORT raw code -> ' + JSON.stringify(controlAction))
  // Control 2: coded http/2 wording already covered.
  const http2 = fixture()
  const http2Action = await http2.fail(11, 'a', 'Error Code upstream_http2_stream_error: Upstream HTTP/2 stream failed')
  ;(http2Action.kind === 'retry' ? results.green : results.red).push('control upstream_http2_stream_error -> ' + JSON.stringify(http2Action))
  // The incident: exact wording + code recorded in failures.jsonl 2026-11-11T09:23:33Z.
  const incident = fixture()
  const incidentAction = await incident.fail(11, 'a', INCIDENT)
  ;(incidentAction.kind === 'retry' ? results.green : results.red).push('INCIDENT wording -> ' + JSON.stringify(incidentAction))
  // Static view: what the host classifier and the plugin do with this wording.
  const defaults = defaultConfig()
  results.effectiveCode = __test.effectiveFailureCode('PI_AI_ERROR', INCIDENT, defaults.failurePatterns)
  results.switchable = __test.isSwitchable({ terminalCodes: new Set(defaults.terminalCodes), failurePatterns: defaults.failurePatterns }, 'PI_AI_ERROR', INCIDENT)
  // pi-ai's own opinion on the same wording:
  const piSrc = readFileSync('C:/Users/wwm_1/AppData/Local/nvm/v24.18.0/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/utils/retry.js', 'utf8')
  results.piAiRetryable = /RETRYABLE_PROVIDER_ERROR_PATTERN[\s\S]*"stream was interrupted"/.test(piSrc)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const home of homes) rmSync(home, { recursive: true, force: true })
}

console.log('RED   (failover misses):', results.red.length > 0 ? results.red : 'none')
console.log('GREEN (failover works):', results.green)
console.log('effectiveFailureCode(PI_AI_ERROR, incident) =', results.effectiveCode)
console.log('isSwitchable(incident).hit =', results.switchable.hit, '| category =', results.switchable.category, '| reason =', results.switchable.reason)
console.log('pi-ai RETRYABLE_PROVIDER_ERROR_PATTERN contains "stream was interrupted":', results.piAiRetryable)
if (results.red.length > 0) { console.log('REPRO RED: failover does not catch the incident wording'); process.exitCode = 1 }
